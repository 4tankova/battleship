// Штучний інтелект. Бачить лише публічну інформацію: промахи, влучання, потоплені кораблі.
import { N, key, inBounds, shipCells, around } from './rules.js';

export const UNKNOWN = 0, MISS = 1, HIT = 2, SUNK = 3;

const pick = (arr, rnd) => arr[Math.floor(rnd() * arr.length)];

function cellsWhere(view, state) {
  const out = [];
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (view[key(r, c)] === state) out.push({ r, c });
  return out;
}

/** Групи суміжних (по горизонталі/вертикалі) влучань у ще не потоплені кораблі. */
function hitGroups(view) {
  const seen = new Set(), groups = [];
  for (const h of cellsWhere(view, HIT)) {
    const k0 = key(h.r, h.c);
    if (seen.has(k0)) continue;
    const g = [], stack = [h];
    seen.add(k0);
    while (stack.length) {
      const p = stack.pop(); g.push(p);
      for (const n of around(p.r, p.c, false)) {
        const k = key(n.r, n.c);
        if (view[k] === HIT && !seen.has(k)) { seen.add(k); stack.push(n); }
      }
    }
    groups.push(g);
  }
  return groups;
}

/** Цілі «добивання» для звичайного рівня: продовжуємо лінію або перевіряємо сусідів. */
function targetCells(view, touch) {
  const groups = hitGroups(view);
  if (!groups.length) return [];
  for (const g of groups.sort((a, b) => b.length - a.length)) {
    let cand = [];
    if (g.length > 1) {
      const sameRow = g.every(p => p.r === g[0].r), sameCol = g.every(p => p.c === g[0].c);
      if (sameRow || sameCol) {
        const along = g.map(p => sameRow ? p.c : p.r);
        const lo = Math.min(...along) - 1, hi = Math.max(...along) + 1;
        const ends = sameRow ? [{ r: g[0].r, c: lo }, { r: g[0].r, c: hi }] : [{ r: lo, c: g[0].c }, { r: hi, c: g[0].c }];
        cand = ends.filter(p => inBounds(p.r, p.c) && view[key(p.r, p.c)] === UNKNOWN);
      }
    }
    if (!cand.length) {
      const set = new Map();
      for (const p of g) for (const n of around(p.r, p.c, false)) if (view[key(n.r, n.c)] === UNKNOWN) set.set(key(n.r, n.c), n);
      cand = [...set.values()];
    }
    if (!touch) {
      // Без дотиків: діагональні сусіди влучання не можуть містити корабель.
      cand = cand.filter(p => !g.some(h => Math.abs(h.r - p.r) === 1 && Math.abs(h.c - p.c) === 1));
    }
    if (cand.length) return cand;
  }
  return [];
}

/** Карта ймовірностей: скільки допустимих розміщень кораблів, що залишились, покриває клітинку. */
export function densityMap(view, sizes, touch) {
  const score = new Float64Array(N * N);
  const anyHits = view.some(v => v === HIT);
  for (const size of sizes) for (const orient of size === 1 ? ['H'] : ['H', 'V']) for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const cells = shipCells(r, c, size, orient);
    if (!cells) continue;
    let hits = 0, bad = false;
    const own = new Set();
    for (const p of cells) {
      const v = view[key(p.r, p.c)];
      if (v === MISS || v === SUNK) { bad = true; break; }
      if (v === HIT) hits++;
      own.add(key(p.r, p.c));
    }
    if (bad) continue;
    if (!touch) {
      // Сусідня клітинка не може бути влучанням в інший корабель або потопленим кораблем.
      for (const p of cells) {
        for (const n of around(p.r, p.c)) {
          const k = key(n.r, n.c);
          if (own.has(k)) continue;
          if (view[k] === SUNK || view[k] === HIT) { bad = true; break; }
        }
        if (bad) break;
      }
      if (bad) continue;
    }
    if (anyHits && !hits) {
      for (const p of cells) score[key(p.r, p.c)] += 0.02;
      continue;
    }
    const w = hits ? Math.pow(40, hits) : 1;
    for (const p of cells) if (view[key(p.r, p.c)] === UNKNOWN) score[key(p.r, p.c)] += w;
  }
  return score;
}

/**
 * Вибір пострілу.
 * view — Int8Array(100) зі станами UNKNOWN/MISS/HIT/SUNK; sizes — розміри кораблів, що лишились.
 */
export function chooseShot(view, sizes, { level = 'normal', touch = true, rnd = Math.random } = {}) {
  const unknown = cellsWhere(view, UNKNOWN);
  if (!unknown.length) return null;

  if (level === 'easy') {
    const t = targetCells(view, touch);
    if (t.length && rnd() < 0.3) return pick(t, rnd);
    return pick(unknown, rnd);
  }

  if (level === 'normal') {
    const t = targetCells(view, touch);
    if (t.length) return pick(t, rnd);
    const minSize = Math.max(1, Math.min(...sizes));
    const parity = unknown.filter(p => (p.r + p.c) % minSize === 0);
    return pick(parity.length ? parity : unknown, rnd);
  }

  // hard — щільність ймовірностей + шаховий порядок пошуку
  const score = densityMap(view, sizes, touch);
  let best = -1, pool = [];
  const minSize = Math.max(1, Math.min(...sizes));
  const anyHits = view.some(v => v === HIT);
  for (const p of unknown) {
    let s = score[key(p.r, p.c)];
    if (!anyHits && minSize > 1 && (p.r + p.c) % 2 === 0) s *= 1.08;
    if (s > best + 1e-9) { best = s; pool = [p]; }
    else if (Math.abs(s - best) <= 1e-9) pool.push(p);
  }
  return pick(pool.length ? pool : unknown, rnd);
}

/** Оновлює погляд стрільця після відповіді. Повертає клітинки, автоматично позначені промахами. */
export function applyResult(view, res, touch) {
  view[key(res.r, res.c)] = res.hit ? HIT : MISS;
  const auto = [];
  if (res.sunk && Array.isArray(res.cells)) {
    const pts = res.cells.map(([r, c]) => ({ r, c }));
    for (const p of pts) view[key(p.r, p.c)] = SUNK;
    if (!touch) for (const p of pts) for (const n of around(p.r, p.c)) {
      const k = key(n.r, n.c);
      if (view[k] === UNKNOWN) { view[k] = MISS; auto.push(n); }
    }
  }
  return auto;
}
