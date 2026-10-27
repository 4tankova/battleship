// Правила, флот, перевірка розстановок і чесної гри. Чистий модуль без DOM.
export const N = 10;
export const LETTERS = 'ABCDEFGHIJ'.split('');

export const RULESETS = {
  classic: {
    id: 'classic',
    title: 'Класичні',
    note: '10 кораблів · не торкаються',
    touch: false,
    fleet: [
      { type: 'battleship', name: 'Лінкор', size: 4, count: 1 },
      { type: 'cruiser', name: 'Крейсер', size: 3, count: 2 },
      { type: 'destroyer', name: 'Есмінець', size: 2, count: 3 },
      { type: 'boat', name: 'Катер', size: 1, count: 4 }
    ]
  },
  modern: {
    id: 'modern',
    title: 'Сучасні',
    note: '5 кораблів · можуть торкатися',
    touch: true,
    fleet: [
      { type: 'carrier', name: 'Авіаносець', size: 5, count: 1 },
      { type: 'battleship', name: 'Лінкор', size: 4, count: 1 },
      { type: 'cruiser', name: 'Крейсер', size: 3, count: 1 },
      { type: 'submarine', name: 'Підводний човен', size: 3, count: 1 },
      { type: 'destroyer', name: 'Есмінець', size: 2, count: 1 }
    ]
  }
};

export const getRules = id => RULESETS[id] || RULESETS.classic;
export const inBounds = (r, c) => Number.isInteger(r) && Number.isInteger(c) && r >= 0 && r < N && c >= 0 && c < N;
export const key = (r, c) => r * N + c;
export const coordName = (r, c) => LETTERS[c] + (r + 1);

/** Розгорнутий список кораблів: [{id:'cruiser-1', type, name, size}] — від більших до менших. */
export function fleetList(rules) {
  const out = [];
  for (const t of rules.fleet) for (let i = 0; i < t.count; i++) out.push({ id: `${t.type}-${i}`, type: t.type, name: t.name, size: t.size });
  return out.sort((a, b) => b.size - a.size);
}
export const fleetCount = rules => rules.fleet.reduce((s, t) => s + t.count, 0);

export function shipCells(r, c, size, orient) {
  const cells = [];
  for (let i = 0; i < size; i++) {
    const rr = orient === 'V' ? r + i : r;
    const cc = orient === 'V' ? c : c + i;
    if (!inBounds(rr, cc)) return null;
    cells.push({ r: rr, c: cc });
  }
  return cells;
}

export function around(r, c, diagonal = true) {
  const out = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (!dr && !dc) continue;
    if (!diagonal && dr && dc) continue;
    if (inBounds(r + dr, c + dc)) out.push({ r: r + dr, c: c + dc });
  }
  return out;
}

/** Клітинки довкола корабля (для правила «не торкаються»). */
export function halo(cells) {
  const own = new Set(cells.map(p => key(p.r, p.c)));
  const res = new Map();
  for (const p of cells) for (const n of around(p.r, p.c)) {
    const k = key(n.r, n.c);
    if (!own.has(k)) res.set(k, n);
  }
  return [...res.values()];
}

export function occupancy(ships, exceptId = null) {
  const occ = new Map();
  for (const s of ships) if (s.id !== exceptId) for (const p of s.cells) occ.set(key(p.r, p.c), s.id);
  return occ;
}

export function canPlace(ships, cells, rules, exceptId = null) {
  if (!cells || !cells.length) return false;
  const occ = occupancy(ships, exceptId);
  for (const p of cells) {
    if (!inBounds(p.r, p.c) || occ.has(key(p.r, p.c))) return false;
    if (!rules.touch) for (const n of around(p.r, p.c)) if (occ.has(key(n.r, n.c))) return false;
  }
  return true;
}

export function orientOf(cells) {
  return cells.length > 1 && cells[0].r !== cells[1].r ? 'V' : 'H';
}

/** Випадкова розстановка. Перезапускається, якщо зайшла в глухий кут (актуально для класики). */
export function randomFleet(rules, rnd = Math.random) {
  const list = fleetList(rules);
  for (let restart = 0; restart < 500; restart++) {
    const ships = [];
    let ok = true;
    for (const s of list) {
      let placed = false;
      for (let a = 0; a < 400 && !placed; a++) {
        const orient = rnd() < 0.5 ? 'H' : 'V';
        const cells = shipCells(Math.floor(rnd() * N), Math.floor(rnd() * N), s.size, orient);
        if (canPlace(ships, cells, rules)) { ships.push({ ...s, cells }); placed = true; }
      }
      if (!placed) { ok = false; break; }
    }
    if (ok) return ships;
  }
  throw new Error('Не вдалося розставити флот');
}

/** Повна перевірка розстановки: склад флоту, форма кораблів, межі, перетини, дотики. */
export function validateFleet(rules, ships) {
  if (!Array.isArray(ships)) return false;
  const expected = fleetList(rules);
  if (ships.length !== expected.length) return false;
  const byId = new Map(expected.map(s => [s.id, s]));
  const seen = new Set();
  const placed = [];
  for (const s of ships) {
    const ref = s && byId.get(s.id);
    if (!ref || seen.has(s.id) || !Array.isArray(s.cells) || s.cells.length !== ref.size) return false;
    seen.add(s.id);
    const first = s.cells[0];
    if (!first || !inBounds(first.r, first.c)) return false;
    const orient = orientOf(s.cells);
    const line = shipCells(first.r, first.c, ref.size, orient);
    if (!line || line.some((p, i) => p.r !== s.cells[i].r || p.c !== s.cells[i].c)) return false;
    if (!canPlace(placed, line, rules)) return false;
    placed.push({ ...ref, cells: line });
  }
  return true;
}

/* ---------- Поле захисника: приймає постріли ---------- */
export class Fleet {
  constructor(rules, ships) {
    this.rules = rules;
    this.ships = ships.map(s => ({ ...s, cells: s.cells.map(p => ({ ...p })), hits: 0, sunk: false }));
    this.shots = new Int8Array(N * N); // 0 — не стріляли, 1 — промах, 2 — влучання
    this.occ = occupancy(this.ships);
  }
  get alive() { return this.ships.filter(s => !s.sunk).length; }
  shipAt(r, c) { const id = this.occ.get(key(r, c)); return id ? this.ships.find(s => s.id === id) : null; }
  /** Повертає результат пострілу або null, якщо постріл некоректний/повторний. */
  receive(r, c) {
    if (!inBounds(r, c) || this.shots[key(r, c)]) return null;
    const ship = this.shipAt(r, c);
    this.shots[key(r, c)] = ship ? 2 : 1;
    if (!ship) return { r, c, hit: false, sunk: false };
    ship.hits++;
    if (ship.hits < ship.size) return { r, c, hit: true, sunk: false };
    ship.sunk = true;
    return { r, c, hit: true, sunk: true, id: ship.id, type: ship.type, cells: ship.cells.map(p => [p.r, p.c]), over: this.alive === 0 };
  }
}

/* ---------- Чесна гра: commit → reveal ---------- */
export function fleetPayload(ships) {
  return [...ships].sort((a, b) => a.id < b.id ? -1 : 1).map(s => ({ id: s.id, cells: s.cells.map(p => [p.r, p.c]) }));
}
export function fleetFromPayload(rules, payload) {
  if (!Array.isArray(payload) || payload.length > 20) return null;
  const ref = new Map(fleetList(rules).map(s => [s.id, s]));
  const ships = [];
  for (const s of payload) {
    if (!s || typeof s.id !== 'string' || !ref.has(s.id) || !Array.isArray(s.cells) || s.cells.length > 6) return null;
    const cells = [];
    for (const p of s.cells) {
      if (!Array.isArray(p) || !inBounds(p[0], p[1])) return null;
      cells.push({ r: p[0], c: p[1] });
    }
    ships.push({ ...ref.get(s.id), cells });
  }
  return ships;
}
export function commitString(salt, ships) {
  return JSON.stringify({ v: 2, salt, fleet: fleetPayload(ships) });
}

/**
 * Перевіряє розкриту розстановку суперника проти всіх отриманих від нього результатів.
 * log: [{r,c,hit,sunk,cells}] — відповіді суперника на наші постріли в порядку надходження.
 */
export function auditLog(rules, ships, log) {
  if (!validateFleet(rules, ships)) return { ok: false, reason: 'Розстановка порушує правила' };
  const fleet = new Fleet(rules, ships);
  for (const entry of log) {
    const real = fleet.receive(entry.r, entry.c);
    if (!real) return { ok: false, reason: 'Некоректна історія пострілів' };
    if (real.hit !== !!entry.hit) return { ok: false, reason: `Неправдива відповідь у ${coordName(entry.r, entry.c)}` };
    if (real.sunk !== !!entry.sunk) return { ok: false, reason: `Приховано потоплення в ${coordName(entry.r, entry.c)}` };
  }
  return { ok: true };
}

/** Миттєва перевірка повідомлення «потоплено»: клітинки утворюють лінію, містять постріл і всі вже вражені. */
export function plausibleSunk(rules, cells, r, c, hitSet) {
  if (!Array.isArray(cells) || !cells.length || cells.length > Math.max(...rules.fleet.map(t => t.size))) return false;
  const pts = [];
  for (const p of cells) { if (!Array.isArray(p) || !inBounds(p[0], p[1])) return false; pts.push({ r: p[0], c: p[1] }); }
  const line = shipCells(pts[0].r, pts[0].c, pts.length, orientOf(pts));
  if (!line || line.some((p, i) => p.r !== pts[i].r || p.c !== pts[i].c)) return false;
  if (!pts.some(p => p.r === r && p.c === c)) return false;
  if (!rules.fleet.some(t => t.size === pts.length)) return false;
  return pts.every(p => (p.r === r && p.c === c) || hitSet.has(key(p.r, p.c)));
}
