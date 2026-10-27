// Морський бій — інтерфейс, режими гри, онлайн, чат, файли, QR.
import { N, RULESETS, getRules, fleetList, fleetCount, shipCells, canPlace, randomFleet, orientOf, Fleet, key, inBounds, coordName,
  commitString, fleetPayload, fleetFromPayload, auditLog, plausibleSunk, halo } from './rules.js';
import { chooseShot, applyResult, UNKNOWN, MISS, HIT, SUNK } from './ai.js';
import * as net from './net.js';
import { play, unlockAudio, fx } from './sound.js';
import { qrMatrix } from './qr.js';

/* ================= Утиліти ================= */
const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const finePointer = matchMedia('(hover: hover) and (pointer: fine)');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) el.append(kid);
  return el;
}
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', '#i-' + name); svg.append(use); return svg;
}
function setIcon(btn, name) { btn.querySelector('use')?.setAttribute('href', '#i-' + name); }

const store = {
  get(k, d) { try { const v = localStorage.getItem('mb.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('mb.' + k, JSON.stringify(v)); } catch {} }
};

function toast(text, kind = '', ms = 2600) {
  const box = $('toasts');
  while (box.children.length > 2) box.firstChild.remove();
  const t = h('div', { class: 'toast ' + kind, text });
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, ms);
}

const fmtBytes = n => n < 1024 ? n + ' Б' : n < 1048576 ? (n / 1024).toFixed(1) + ' КБ' : n < 1073741824 ? (n / 1048576).toFixed(1) + ' МБ' : (n / 1073741824).toFixed(2) + ' ГБ';
const fmtTime = ms => { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const cleanText = (s, max) => String(s ?? '').replace(/[\u0000-\u0008\u000B-\u001F\u007F‪-‮⁦-⁩]/g, '').trim().slice(0, max);
function cleanFileName(s) {
  let n = cleanText(s, 200).replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  if (n.length > 120) { const dot = n.lastIndexOf('.'); const ext = dot > 0 && n.length - dot <= 12 ? n.slice(dot) : ''; n = n.slice(0, 120 - ext.length) + ext; }
  return n || 'file';
}
async function sha256hex(str) {
  if (!globalThis.crypto?.subtle) return null;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const randomHex = n => [...crypto.getRandomValues(new Uint8Array(n))].map(b => b.toString(16).padStart(2, '0')).join('');

/* Крипто для вкладень: PBKDF2 → AES-GCM. Працює лише в захищеному контексті (HTTPS). */
const subtle = globalThis.crypto?.subtle || null;
const te = new TextEncoder();
const KDF_ITERS = 210000;
function u8ToB64(u) { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
function b64ToU8(s) { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
async function deriveKey(pass, salt) {
  const base = await subtle.importKey('raw', te.encode(pass), 'PBKDF2', false, ['deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', salt, iterations: KDF_ITERS, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function aesEncrypt(key, plain) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12);
  return out;
}
async function aesDecrypt(key, frame) {
  const iv = frame.subarray(0, 12), ct = frame.subarray(12);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

/* ================= Налаштування й статистика ================= */
const settings = { rules: 'classic', level: 'normal', sound: true, ...store.get('settings', {}) };
if (!RULESETS[settings.rules]) settings.rules = 'classic';
if (!['easy', 'normal', 'hard'].includes(settings.level)) settings.level = 'normal';
const saveSettings = () => store.set('settings', settings);
let stats = { wins: 0, losses: 0, shots: 0, hits: 0, streak: 0, ...store.get('stats', {}) };
const LEVEL_NAME = { easy: 'Кадет', normal: 'Капітан', hard: 'Адмірал' };

function renderStats() {
  $('st-wins').textContent = stats.wins;
  $('st-losses').textContent = stats.losses;
  $('st-acc').textContent = stats.shots ? Math.round(stats.hits / stats.shots * 100) + '%' : '—';
  $('st-streak').textContent = stats.streak;
}

/* ================= Стан ================= */
const S = {
  screen: 'home',
  mode: null,          // 'bot' | 'online'
  rules: getRules(settings.rules),
  level: settings.level,
  role: null,          // 'host' | 'guest'
  link: null,
  op: null,            // поточна мережева операція (створення/приєднання)
  // розстановка
  ships: [], lastShips: null, sel: null, orient: 'H', ghost: null, pending: false, cursor: { r: 0, c: 0 },
  ready: false, oppReady: false, oppCommit: null, salt: null, myCommit: null,
  // бій
  phase: 'idle',       // idle | place | battle | over
  myFleet: null, myView: null, enemy: null, enemyView: null, enemySunk: [],
  myTurn: false, busy: false, aim: null, paused: false, pausedByMe: false,
  outSeq: 0, inSeq: 0, resultLog: [], suspicious: null, revealed: null, pendingReveal: null,
  shots: 0, hits: 0, t0: 0, t1: 0, outcome: null, botTimer: null, resultTimer: null,
  rematchMe: false, rematchThem: false, peerGone: false
};

/* ================= Екрани ================= */
function show(screen) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('is-active', s.id === 'screen-' + screen));
  S.screen = screen;
  updateChatAccess();
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

/* ================= Поле ================= */
function buildBoard(el, { interactive = false } = {}) {
  el.replaceChildren();
  el.append(h('div', { class: 'lab', 'aria-hidden': 'true' }));
  for (let c = 0; c < N; c++) el.append(h('div', { class: 'lab', 'aria-hidden': 'true', text: String.fromCharCode(65 + c) }));
  const cells = [];
  for (let r = 0; r < N; r++) {
    el.append(h('div', { class: 'lab', 'aria-hidden': 'true', text: String(r + 1) }));
    for (let c = 0; c < N; c++) {
      const i = key(r, c);
      let base = 'cell';
      if (i === 0) base += ' corner-tl'; else if (i === 9) base += ' corner-tr'; else if (i === 90) base += ' corner-bl'; else if (i === 99) base += ' corner-br';
      const cell = h('div', { class: base, 'data-i': i, role: interactive ? 'button' : null, tabindex: interactive ? (i === 0 ? '0' : '-1') : null, 'aria-label': coordName(r, c) });
      cell._base = base;
      cells.push(cell);
      el.append(cell);
    }
  }
  el._cells = cells;
  return cells;
}
/** Повертає Map(index → класи корпусу) для набору кораблів. */
function hullClasses(ships, extra) {
  const m = new Map();
  for (const s of ships) {
    const o = orientOf(s.cells) === 'V' ? 'o-v' : 'o-h';
    s.cells.forEach((p, i) => {
      const seg = s.cells.length === 1 ? 's-1' : i === 0 ? 's-s' : i === s.cells.length - 1 ? 's-e' : 's-m';
      m.set(key(p.r, p.c), `${extra} ${o} ${seg}`);
    });
  }
  return m;
}
const cellIndex = ev => { const c = ev.target.closest?.('.cell'); return c ? +c.dataset.i : -1; };

/* ================= Розстановка ================= */
const placeBoard = $('place-board');
buildBoard(placeBoard);
let lastPointer = 'mouse';

function remainingOfType(type) { return fleetList(S.rules).filter(s => s.type === type && !S.ships.some(p => p.id === s.id)); }
function nextShip() { return S.sel ? remainingOfType(S.sel)[0] || null : null; }
function autoSelect() {
  if (S.sel && remainingOfType(S.sel).length) return;
  const t = S.rules.fleet.find(t => remainingOfType(t.type).length);
  S.sel = t ? t.type : null;
}
function ghostCells() {
  const ship = nextShip();
  if (!ship || !S.ghost) return null;
  let { r, c } = S.ghost;
  if (S.orient === 'H') c = Math.min(c, N - ship.size); else r = Math.min(r, N - ship.size);
  return shipCells(r, c, ship.size, S.orient);
}

function goPlacement() {
  clearTimeout(S.botTimer); clearTimeout(S.resultTimer);
  Object.assign(S, { phase: 'place', ready: false, oppReady: false, oppCommit: null, salt: null, myCommit: null, ghost: null, pending: false,
    myTurn: false, busy: false, paused: false, over: false, outcome: null, revealed: null, pendingReveal: null, suspicious: null,
    rematchMe: false, rematchThem: false, resultLog: [], outSeq: 0, inSeq: 0, enemySunk: [] });
  S.ships = S.lastShips && S.lastShips.length === fleetCount(S.rules) ? S.lastShips.map(s => ({ ...s, cells: s.cells.map(p => ({ ...p })) })) : [];
  S.sel = null; autoSelect();
  closeDialogs();
  $('after-bar').hidden = true;
  $('place-mode').textContent = S.mode === 'bot' ? `Проти ШІ · ${LEVEL_NAME[S.level]} · ${S.rules.title}` : `Онлайн · ${S.rules.title} правила`;
  $('btn-ready').hidden = false;
  setPlaceStatus(S.mode === 'online' ? 'Суперник розставляє флот…' : '', S.mode === 'online' ? 'wait' : '');
  show('place');
  renderDock(); renderPlace(); placeHint();
}

function renderDock() {
  const dock = $('dock');
  dock.replaceChildren();
  for (const t of S.rules.fleet) {
    const left = remainingOfType(t.type).length;
    const btn = h('button', { class: 'ship-pick', type: 'button', role: 'radio', 'aria-checked': String(S.sel === t.type), disabled: left === 0 || S.ready,
      'aria-label': `${t.name}, ${t.size} кл., залишилось ${left}`, 'data-type': t.type },
      h('span', { class: 'nm', text: t.name }),
      h('span', { class: 'hull-mini' }, Array.from({ length: t.size }, () => h('i'))),
      t.count > 1 ? h('span', { class: 'cnt', text: '×' + left }) : null);
    dock.append(btn);
  }
}
$('dock').addEventListener('click', e => {
  const b = e.target.closest('.ship-pick');
  if (!b || b.disabled || S.ready) return;
  S.sel = b.dataset.type; S.pending = false; if (!finePointer.matches) S.ghost = null;
  play('tap'); renderDock(); renderPlace(); placeHint();
});

function renderPlace() {
  const cells = placeBoard._cells;
  const hull = hullClasses(S.ships, 'ship');
  const g = S.ready ? null : ghostCells();
  const ok = g && canPlace(S.ships, g, S.rules);
  const gm = g ? hullClasses([{ cells: g }], 'ghost' + (ok ? '' : ' bad') + (S.pending ? ' pending' : '')) : new Map();
  for (let i = 0; i < 100; i++) cells[i].className = cells[i]._base + ' ' + (gm.get(i) || hull.get(i) || '');
  $('confirm-bar').hidden = !(S.pending && g);
  $('btn-place-ok').disabled = !ok;
  $('btn-ready').disabled = S.ready || S.ships.length !== fleetCount(S.rules);
  $('orient-label').textContent = S.orient === 'H' ? 'Горизонтально' : 'Вертикально';
  $('btn-random').disabled = $('btn-clear').disabled = $('btn-rotate').disabled = S.ready;
}

function placeHint(text, kind = '') {
  const el = $('place-hint');
  if (!text) {
    const total = fleetCount(S.rules), done = S.ships.length;
    if (S.ready) text = S.mode === 'online' ? 'Флот готовий. Чекаємо на суперника…' : 'Флот готовий!';
    else if (done === total) { text = 'Усі кораблі на позиціях. Тисни «До бою»!'; kind = 'ok'; }
    else if (S.pending) text = 'Торкнись корабля ще раз або «Поставити». Інша клітинка — перемістити.';
    else {
      const ship = nextShip();
      text = (finePointer.matches ? 'Клікни на поле, щоб поставити: ' : 'Торкнись поля, щоб поставити: ') + (ship ? `${ship.name} (${ship.size})` : '') +
        `. ${S.rules.touch ? 'Кораблі можуть торкатися.' : 'Кораблі не можуть торкатися навіть кутами.'} Готовий корабель можна взяти й переставити.`;
    }
  }
  el.textContent = text; el.className = 'hint ' + kind;
}
function setPlaceStatus(text, kind = '') { const el = $('place-status'); el.textContent = text; el.className = 'status ' + kind; }

function placeAt(cells) {
  const ship = nextShip();
  if (!ship || !cells) return false;
  if (!canPlace(S.ships, cells, S.rules)) {
    play('error'); placeHint(S.rules.touch ? 'Тут не поміститься — клітинки зайняті.' : 'Занадто близько до іншого корабля. Залиш порожню клітинку.', 'warn');
    return false;
  }
  S.ships.push({ ...ship, cells });
  S.ghost = finePointer.matches && lastPointer === 'mouse' ? S.ghost : null; S.pending = false;
  autoSelect(); play('place');
  renderDock(); renderPlace(); placeHint();
  return true;
}
function pickUp(i) {
  const r = Math.floor(i / N), c = i % N;
  const idx = S.ships.findIndex(s => s.cells.some(p => p.r === r && p.c === c));
  if (idx < 0) return false;
  const [s] = S.ships.splice(idx, 1);
  S.sel = s.type; S.orient = orientOf(s.cells);
  S.ghost = { ...s.cells[0] }; S.pending = lastPointer !== 'mouse';
  play('rotate'); renderDock(); renderPlace(); placeHint(lastPointer === 'mouse' ? `${s.name} у руці — оберіть нове місце.` : undefined);
  return true;
}

placeBoard.addEventListener('pointerdown', e => { lastPointer = e.pointerType || 'mouse'; unlockAudio(); });
placeBoard.addEventListener('pointermove', e => {
  if (e.pointerType !== 'mouse' || S.ready || S.pending) return;
  const i = cellIndex(e); if (i < 0) return;
  const g = { r: Math.floor(i / N), c: i % N };
  if (!S.ghost || S.ghost.r !== g.r || S.ghost.c !== g.c) { S.ghost = g; renderPlace(); }
});
placeBoard.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse' && !S.pending && S.ghost) { S.ghost = null; renderPlace(); } });
placeBoard.addEventListener('click', e => {
  if (S.ready || S.phase !== 'place') return;
  const i = cellIndex(e); if (i < 0) return;
  const r = Math.floor(i / N), c = i % N;
  const g = ghostCells();
  if (lastPointer === 'mouse') {
    if (!nextShip() || (S.ships.some(s => s.cells.some(p => p.r === r && p.c === c)) && !(g && canPlace(S.ships, g, S.rules)))) { pickUp(i); return; }
    S.ghost = { r, c }; placeAt(ghostCells());
    return;
  }
  // сенсорний екран: перший дотик — примірка, другий по кораблю — підтвердження
  if (S.pending && g && g.some(p => p.r === r && p.c === c)) { placeAt(g); return; }
  if (!S.pending && S.ships.some(s => s.cells.some(p => p.r === r && p.c === c))) { pickUp(i); return; }
  if (!nextShip()) { placeHint('Усі кораблі вже на полі. Торкнись корабля, щоб переставити.'); return; }
  S.ghost = { r, c }; S.pending = true; play('tap');
  renderPlace(); placeHint();
});
placeBoard.tabIndex = 0;
placeBoard.addEventListener('keydown', e => {
  if (S.ready) return;
  const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  if (moves[e.key]) {
    e.preventDefault(); lastPointer = 'keyboard';
    const g = S.ghost || S.cursor;
    S.ghost = { r: Math.max(0, Math.min(N - 1, g.r + moves[e.key][0])), c: Math.max(0, Math.min(N - 1, g.c + moves[e.key][1])) };
    S.cursor = S.ghost; S.pending = false; renderPlace();
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault(); if (!S.ghost) { S.ghost = { ...S.cursor }; renderPlace(); } else placeAt(ghostCells());
  }
});

function rotate() {
  if (S.ready || S.phase !== 'place') return;
  S.orient = S.orient === 'H' ? 'V' : 'H'; play('rotate'); renderPlace();
}
$('btn-rotate').addEventListener('click', rotate);
$('btn-random').addEventListener('click', () => {
  if (S.ready) return;
  S.ships = randomFleet(S.rules); S.ghost = null; S.pending = false; S.sel = null;
  play('place'); renderDock(); renderPlace(); placeHint('Флот розставлено випадково. Можна переставити будь-який корабель.', 'ok');
});
$('btn-clear').addEventListener('click', () => {
  if (S.ready) return;
  S.ships = []; S.ghost = null; S.pending = false; S.sel = null; autoSelect();
  play('tap'); renderDock(); renderPlace(); placeHint();
});
$('btn-place-ok').addEventListener('click', () => placeAt(ghostCells()));
$('btn-place-cancel').addEventListener('click', () => { S.ghost = null; S.pending = false; play('tap'); renderPlace(); placeHint(); });
$('btn-ready').addEventListener('click', onReady);
$('btn-place-back').addEventListener('click', async () => {
  if (S.mode === 'online' && S.link?.open && !(await confirmDlg('Вийти з кімнати?', 'З’єднання із суперником буде розірвано.', 'Вийти'))) return;
  goHome();
});

async function onReady() {
  if (S.ready || S.ships.length !== fleetCount(S.rules)) return;
  S.ready = true; S.ghost = null; S.pending = false;
  S.lastShips = S.ships.map(s => ({ ...s, cells: s.cells.map(p => ({ ...p })) }));
  play('tap'); renderDock(); renderPlace(); placeHint();
  if (S.mode === 'bot') { startBattle(Math.random() < 0.5); return; }
  S.salt = randomHex(16);
  S.myCommit = await sha256hex(commitString(S.salt, S.ships));
  send({ t: 'ready', commit: S.myCommit });
  setPlaceStatus(S.oppReady ? 'Обидва готові!' : 'Чекаємо, поки суперник розставить флот…', 'wait');
  maybeStart();
}
function maybeStart() {
  if (S.mode !== 'online' || S.phase !== 'place' || !S.ready || !S.oppReady || S.role !== 'host') return;
  const first = Math.random() < 0.5 ? 'host' : 'guest';
  send({ t: 'start', first });
  startBattle(first === 'host');
}

/* ================= Бій ================= */
const enemyBoard = $('enemy-board'), myBoard = $('my-board');
buildBoard(enemyBoard, { interactive: true });
buildBoard(myBoard);

function startBattle(meFirst) {
  S.phase = 'battle'; S.over = false;
  S.myFleet = new Fleet(S.rules, S.ships);
  S.myView = new Int8Array(100);
  S.enemyView = new Int8Array(100);
  S.enemySunk = []; S.autoEnemy = new Set(); S.revealed = null;
  S.enemy = S.mode === 'bot' ? new Fleet(S.rules, randomFleet(S.rules)) : null;
  S.myTurn = meFirst; S.busy = false; S.paused = false; S.aim = null;
  S.shots = 0; S.hits = 0; S.t0 = Date.now(); S.t1 = 0;
  S.outSeq = 0; S.inSeq = 0; S.resultLog = [];
  $('enemy-label').textContent = S.mode === 'bot' ? `ШІ · ${LEVEL_NAME[S.level]}` : 'Суперник';
  $('btn-pause').hidden = false; $('btn-surrender').hidden = false; $('after-bar').hidden = true;
  show('game');
  renderBattle();
  setMsg(meFirst ? 'Ви стріляєте першим. Оберіть клітинку на полі суперника.' : (S.mode === 'bot' ? 'ШІ стріляє першим…' : 'Суперник стріляє першим…'), meFirst ? 'good' : 'warn');
  toast(meFirst ? 'Жереб: ви починаєте!' : 'Жереб: першим ходить суперник', meFirst ? 'good' : '');
  wakeLock(true);
  if (meFirst) focusEnemy(); else if (S.mode === 'bot') botTurn();
}

function setMsg(text, kind = '') { const m = $('game-msg'); m.textContent = text; m.className = 'game-msg ' + kind; }

function renderPips(el, list, deadIds) {
  el.replaceChildren(...list.map(s => h('span', { class: 'pip' + (deadIds.has(s.id) ? ' dead' : ''), title: s.name }, Array.from({ length: s.size }, () => h('i')))));
}
function enemyDeadIds() {
  // Співставляємо потоплені кораблі з типами флоту (порядок не важливий для відображення)
  const dead = new Set(), list = fleetList(S.rules);
  for (const s of S.enemySunk) { const m = list.find(x => x.size === s.cells.length && (!s.type || x.type === s.type) && !dead.has(x.id)) || list.find(x => x.size === s.cells.length && !dead.has(x.id)); if (m) dead.add(m.id); }
  return dead;
}

function renderBattle(fresh = {}) {
  const list = fleetList(S.rules), total = list.length;
  // моє поле
  const mine = hullClasses(S.myFleet.ships, 'ship');
  const mySunk = hullClasses(S.myFleet.ships.filter(s => s.sunk), 'sunk');
  const mc = myBoard._cells;
  for (let i = 0; i < 100; i++) {
    const v = S.myView[i];
    let cls = mc[i]._base + ' ' + (mySunk.get(i) || mine.get(i) || '');
    if (v === HIT) cls += ' hit'; else if (v === MISS) cls += ' miss' + (S.myFleet.shots[i] ? '' : ' auto');
    if (fresh.mine === i) cls += ' fresh last';
    mc[i].className = cls;
  }
  // поле суперника
  const sunkMap = hullClasses(S.enemySunk, 'sunk');
  const revealMap = S.revealed ? hullClasses(S.revealed, 'reveal') : new Map();
  const ec = enemyBoard._cells;
  for (let i = 0; i < 100; i++) {
    const v = S.enemyView[i];
    let cls = ec[i]._base + ' ' + (sunkMap.get(i) || revealMap.get(i) || '');
    let label = coordName(Math.floor(i / N), i % N);
    if (v === HIT) { cls += ' hit'; label += ', влучання'; }
    else if (v === SUNK) { label += ', потоплено'; }
    else if (v === MISS) { cls += ' miss' + (fresh.auto?.has(i) || S.autoEnemy?.has(i) ? ' auto' : ''); label += ', промах'; }
    if (fresh.enemy === i) cls += ' fresh last';
    if (S.aim === i) cls += ' aim';
    ec[i].className = cls;
    ec[i].setAttribute('aria-label', label);
  }
  const myAlive = S.myFleet.alive, enemyAlive = total - S.enemySunk.length;
  renderPips($('pips-me'), [...S.myFleet.ships].sort((a, b) => b.size - a.size), new Set(S.myFleet.ships.filter(s => s.sunk).map(s => s.id)));
  renderPips($('pips-enemy'), list, enemyDeadIds());
  $('me-count').textContent = `${myAlive}/${total}`;
  $('enemy-count').textContent = `${enemyAlive}/${total}`;
  $('hud-me-n').textContent = `${myAlive}/${total}`;
  $('hud-enemy-n').textContent = `${enemyAlive}/${total}`;
  renderTurn();
}
function renderTurn() {
  const t = $('turn'), txt = $('turn-text');
  const mine = S.phase === 'battle' && S.myTurn && !S.paused;
  const theirs = S.phase === 'battle' && !S.myTurn && !S.paused;
  t.className = 'turn ' + (mine ? '' : theirs ? 'theirs' : 'idle');
  txt.textContent = S.phase === 'over' ? (S.outcome === 'win' ? 'Перемога' : 'Поразка') : S.paused ? 'Пауза' : mine ? 'Ваш хід' : (S.mode === 'bot' ? 'ШІ цілиться' : 'Хід суперника');
  $('enemy-card').classList.toggle('active', mine);
  $('me-card').classList.toggle('active', theirs);
  $('enemy-card').classList.toggle('dim', theirs);
  $('enemy-card').classList.toggle('focus', !theirs);
  $('me-card').classList.toggle('focus', theirs);
  enemyBoard.classList.toggle('locked', !mine || S.busy);
}

function canFire() { return S.phase === 'battle' && S.myTurn && !S.busy && !S.paused; }
async function fire(i) {
  if (!canFire()) {
    if (S.phase === 'battle' && !S.myTurn && !S.paused) toast('Зараз хід суперника');
    return;
  }
  if (S.enemyView[i] !== UNKNOWN) { play('error'); return; }
  const r = Math.floor(i / N), c = i % N;
  S.busy = true; S.aim = i; S.shots++;
  play('shot'); renderBattle();
  setMsg(`Залп по ${coordName(r, c)}…`, 'warn');
  if (S.mode === 'bot') {
    await sleep(reduceMotion.matches ? 80 : 420);
    if (S.phase !== 'battle') return;
    onResult(S.enemy.receive(r, c));
  } else {
    S.pendingShot = { r, c, n: ++S.outSeq };
    send({ t: 'shot', r, c, n: S.outSeq });
    clearTimeout(S.resultTimer);
    S.resultTimer = setTimeout(() => { if (S.busy && S.phase === 'battle') setMsg('Суперник не відповідає… Перевіряємо з’єднання.', 'warn'); }, 12000);
  }
}
enemyBoard.addEventListener('click', e => { unlockAudio(); const i = cellIndex(e); if (i >= 0) fire(i); });
enemyBoard.addEventListener('keydown', e => {
  const i = cellIndex(e); if (i < 0) return;
  const moves = { ArrowUp: -N, ArrowDown: N, ArrowLeft: -1, ArrowRight: 1 };
  if (moves[e.key] != null) {
    e.preventDefault();
    let j = i + moves[e.key];
    if ((e.key === 'ArrowLeft' && i % N === 0) || (e.key === 'ArrowRight' && i % N === N - 1) || j < 0 || j >= 100) j = i;
    focusEnemy(j);
  } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fire(i); }
});
function focusEnemy(j) {
  const cells = enemyBoard._cells;
  const kb = enemyBoard.contains(document.activeElement);
  if (j == null) { j = cells.findIndex(c => c.tabIndex === 0); if (j < 0) j = 0; }
  cells.forEach((c, k) => { c.tabIndex = k === j ? 0 : -1; });
  if (kb || (finePointer.matches && S.screen === 'game')) cells[j].focus({ preventScroll: true });
}

function onResult(res) {
  clearTimeout(S.resultTimer);
  S.busy = false; S.aim = null; S.pendingShot = null;
  const auto = applyResult(S.enemyView, res, S.rules.touch);
  S.autoEnemy = S.autoEnemy || new Set();
  if (S.mode === 'online') S.resultLog.push({ r: res.r, c: res.c, hit: res.hit, sunk: res.sunk });
  const i = key(res.r, res.c);
  if (res.hit) {
    S.hits++;
    if (res.sunk) {
      S.enemySunk.push({ type: res.type, cells: res.cells.map(([r, c]) => ({ r, c })) });
      auto.forEach(p => S.autoEnemy.add(key(p.r, p.c)));
      const name = S.rules.fleet.find(t => t.type === res.type)?.name || 'Корабель';
      play('sink'); shake();
      setMsg(`${name} суперника потоплено! Стріляйте ще.`, 'good');
      toast(`Потоплено: ${name}`, 'good');
    } else { play('hit'); shake(true); setMsg(`Влучання в ${coordName(res.r, res.c)}! Ще один постріл.`, 'good'); }
  } else {
    play('miss');
    S.myTurn = false;
    setMsg(`Промах у ${coordName(res.r, res.c)}. ${S.mode === 'bot' ? 'ШІ цілиться…' : 'Хід суперника.'}`);
  }
  renderBattle({ enemy: i, auto: new Set(auto.map(p => key(p.r, p.c))) });
  if (S.enemySunk.length === fleetCount(S.rules)) { finish('win'); return; }
  if (S.myTurn) focusEnemy(i);
  else if (S.mode === 'bot') botTurn();
}

function receiveShot(r, c) {
  const res = S.myFleet.receive(r, c);
  if (!res) return null;
  applyResult(S.myView, res, S.rules.touch);
  if (res.hit) {
    if (res.sunk) { play('sink'); shake(); setMsg(`Ваш ${S.rules.fleet.find(t => t.type === res.type)?.name.toLowerCase() || 'корабель'} потоплено в ${coordName(r, c)}!`, 'bad'); }
    else { play('hit'); shake(true); setMsg(`Влучання по вашому кораблю в ${coordName(r, c)}!`, 'bad'); }
  } else {
    play('miss'); S.myTurn = true;
    setMsg(`Суперник промахнувся (${coordName(r, c)}). Ваш хід!`, 'good');
  }
  renderBattle({ mine: key(r, c) });
  if (res.over) finish('lose');
  else if (S.myTurn) focusEnemy();
  return res;
}

function botTurn() {
  clearTimeout(S.botTimer);
  if (S.mode !== 'bot' || S.phase !== 'battle' || S.myTurn || S.paused) return;
  const delay = reduceMotion.matches ? 250 : S.level === 'easy' ? 900 : 650 + Math.random() * 450;
  S.botTimer = setTimeout(() => {
    if (S.phase !== 'battle' || S.myTurn || S.paused) return;
    const sizes = S.myFleet.ships.filter(s => !s.sunk).map(s => s.size);
    const t = chooseShot(S.myView, sizes, { level: S.level, touch: S.rules.touch });
    if (!t) return;
    receiveShot(t.r, t.c);
    if (S.phase === 'battle' && !S.myTurn) botTurn();
  }, delay);
}

function shake(light) {
  if (reduceMotion.matches) return;
  const app = $('app'); app.classList.remove('shake'); void app.offsetWidth;
  if (!light) app.classList.add('shake');
}

/* ---------- Пауза / здача ---------- */
function pause(byMe = true, auto = false) {
  if (S.phase !== 'battle' || S.paused) return;
  if (byMe && S.busy) { toast('Дочекайтеся результату пострілу'); return; }
  S.paused = true; S.pausedByMe = byMe; clearTimeout(S.botTimer);
  if (byMe && S.mode === 'online') send({ t: 'pause' });
  $('pause-text').textContent = byMe ? (auto ? 'Гру поставлено на паузу, поки вкладка була прихована.' : 'Гру призупинено.') : 'Суперник поставив гру на паузу. Продовжити може лише він.';
  $('btn-resume').hidden = !byMe;
  openDialog('dlg-pause'); renderTurn();
}
function resume(byMe = true) {
  if (!S.paused || (byMe && !S.pausedByMe) || (!byMe && S.pausedByMe)) return;
  S.paused = false;
  if (byMe && S.mode === 'online') send({ t: 'resume' });
  closeDialog('dlg-pause'); renderTurn();
  if (!byMe) toast('Гру продовжено');
  if (S.mode === 'bot' && !S.myTurn) botTurn();
}
$('btn-pause').addEventListener('click', () => pause(true));
$('btn-resume').addEventListener('click', () => resume(true));
$('btn-pause-home').addEventListener('click', async () => {
  closeDialog('dlg-pause');
  if (await confirmDlg('Вийти в меню?', S.mode === 'online' ? 'Гру буде завершено, а з’єднання — розірвано.' : 'Поточний бій буде втрачено.', 'Вийти')) goHome();
  else if (S.paused) openDialog('dlg-pause');
});
$('dlg-pause').addEventListener('cancel', e => { e.preventDefault(); if (S.pausedByMe) resume(true); });
$('btn-surrender').addEventListener('click', async () => {
  if (S.phase !== 'battle') return;
  if (!(await confirmDlg('Здатися?', 'Поразку буде зараховано в статистику.', 'Здатися'))) return;
  if (S.phase !== 'battle') return;
  if (S.mode === 'online') send({ t: 'surrender' });
  finish('lose', 'surrender');
});

/* ---------- Кінець гри ---------- */
function finish(outcome, reason = '') {
  if (S.phase !== 'battle') return;
  S.phase = 'over'; S.over = true; S.outcome = outcome; S.t1 = Date.now();
  S.busy = false; S.paused = false; S.aim = null;
  clearTimeout(S.botTimer); clearTimeout(S.resultTimer);
  closeDialog('dlg-pause');
  wakeLock(false);
  stats.shots += S.shots; stats.hits += S.hits;
  if (outcome === 'win') { stats.wins++; stats.streak = Math.max(1, stats.streak + 1); } else { stats.losses++; stats.streak = 0; }
  store.set('stats', stats);
  if (S.mode === 'bot') S.revealed = S.enemy.ships.filter(s => !s.sunk);
  if (S.mode === 'online') {
    send({ t: 'reveal', salt: S.salt, fleet: fleetPayload(S.myFleet.ships) });
    if (S.pendingReveal) { const p = S.pendingReveal; S.pendingReveal = null; onReveal(p); }
  }
  renderBattle();
  setMsg(outcome === 'win' ? 'Ворожий флот знищено!' : 'Ваш флот знищено.', outcome === 'win' ? 'good' : 'bad');
  $('btn-pause').hidden = true; $('btn-surrender').hidden = true;
  play(outcome === 'win' ? 'win' : 'lose');
  const d = $('dlg-end');
  d.className = 'dialog end ' + outcome;
  $('end-title').textContent = outcome === 'win' ? 'Перемога!' : 'Поразка';
  $('end-text').textContent = reason === 'surrender'
    ? (outcome === 'win' ? 'Суперник здався. Флот цілий — слава флоту!' : 'Ви здалися. Наступного разу вийде!')
    : outcome === 'win' ? `Ворожий флот пішов на дно за ${S.shots} пострілів.` : 'Ваші кораблі потоплено. Час на реванш!';
  $('es-shots').textContent = S.shots;
  $('es-hits').textContent = S.hits;
  $('es-acc').textContent = S.shots ? Math.round(S.hits / S.shots * 100) + '%' : '—';
  $('es-time').textContent = fmtTime(S.t1 - S.t0);
  $('after-text').textContent = outcome === 'win' ? 'Перемога!' : 'Поразка';
  renderFair();
  updateRematchUI();
  setTimeout(() => { if (S.phase === 'over' && S.screen === 'game') openDialog('dlg-end'); }, reason === 'surrender' ? 150 : 1100);
}
function renderFair() {
  const f = $('end-fair');
  if (S.mode !== 'online') { f.hidden = true; return; }
  f.hidden = false; f.replaceChildren();
  if (S.suspicious) { f.className = 'fair bad'; f.append(icon('shield'), `Підозріло: ${S.suspicious}`); }
  else if (S.revealed) { f.className = 'fair ok'; f.append(icon('shield'), 'Чесна гра підтверджена криптографічно'); }
  else if (!S.oppCommit) { f.className = 'fair wait'; f.append(icon('shield'), 'Перевірка чесності недоступна (потрібен HTTPS)'); }
  else { f.className = 'fair wait'; f.append(h('span', { class: 'spinner' }), 'Перевіряємо розстановку суперника…'); }
}
function updateRematchUI() {
  const label = S.mode === 'bot' ? 'Ще раз' : S.peerGone ? 'Суперник пішов' : S.rematchMe ? 'Чекаємо…' : S.rematchThem ? 'Прийняти реванш' : 'Реванш';
  $('again-label').textContent = label;
  const dis = S.mode === 'online' && (S.peerGone || S.rematchMe);
  $('btn-end-again').disabled = dis; $('btn-after-again').disabled = dis;
  $('btn-after-again').lastChild.textContent = label;
}
function again() {
  closeDialog('dlg-end');
  if (S.mode === 'bot') { goPlacement(); return; }
  if (S.peerGone || S.rematchMe) return;
  S.rematchMe = true; send({ t: 'rematch' }); updateRematchUI();
  if (S.rematchThem) goPlacement(); else { toast('Запрошення на реванш надіслано'); $('after-bar').hidden = false; }
}
$('btn-end-again').addEventListener('click', again);
$('btn-after-again').addEventListener('click', again);
$('btn-end-home').addEventListener('click', goHome);
$('btn-after-home').addEventListener('click', goHome);
$('btn-end-view').addEventListener('click', () => { closeDialog('dlg-end'); $('after-bar').hidden = false; });
$('dlg-end').addEventListener('close', () => { if (S.phase === 'over') $('after-bar').hidden = false; });

/* ================= Онлайн ================= */
function send(msg) { if (S.mode === 'online' && S.link?.open) S.link.send(msg); }

$('btn-create').addEventListener('click', () => { unlockAudio(); play('tap'); createRoom(); });
$('btn-join').addEventListener('click', () => { unlockAudio(); play('tap'); openJoin(); });
$('btn-lobby-cancel').addEventListener('click', goHome);
$('btn-join-back').addEventListener('click', goHome);

function lobbyStatus(text, kind = '', spin = false) {
  const el = $('lobby-status'); el.replaceChildren(); if (spin) el.append(h('span', { class: 'spinner' })); el.append(text); el.className = 'status ' + kind;
}
function joinStatus(text, kind = '', spin = false) {
  const el = $('join-status'); el.replaceChildren(); if (spin) el.append(h('span', { class: 'spinner' })); el.append(text); el.className = 'status ' + kind;
}
let roomCode = null;
const joinLink = code => location.origin + location.pathname + '#join=' + code;

function createRoom() {
  resetSession();
  S.mode = 'online'; S.rules = getRules(settings.rules);
  roomCode = null;
  $('room-code').textContent = '———';
  $('qr-loading').hidden = false;
  $('lobby-rules').textContent = `Правила: ${S.rules.title} (${S.rules.note})`;
  $('btn-copy').disabled = $('btn-share').disabled = true;
  lobbyStatus('Створюємо кімнату…', 'wait', true);
  show('lobby');
  if (!window.RTCPeerConnection) { lobbyStatus('Цей браузер не підтримує онлайн-гру (WebRTC).', 'err'); return; }
  const op = net.hostRoom({
    onCode(code) {
      if (S.op !== op) return;
      roomCode = code;
      $('room-code').textContent = net.formatRoomCode(code);
      drawQR($('qr'), joinLink(code)); $('qr-loading').hidden = true;
      $('btn-copy').disabled = false; $('btn-share').disabled = false;
      lobbyStatus('Чекаємо на суперника…', 'wait', true);
    },
    onStatus(s) { if (S.op === op) lobbyStatus(s === 'connecting' ? 'Суперник під’єднується…' : 'Чекаємо на суперника…', 'wait', true); }
  });
  S.op = op;
  op.promise.then(link => { if (S.op === op) { S.op = null; onLinked('host', link); } else link.close(); })
    .catch(e => { if (S.op === op) { S.op = null; const t = net.netErrorText(e); if (t) lobbyStatus(t, 'err'); } });
}
async function copyCode() {
  if (!roomCode) return;
  try { await navigator.clipboard.writeText(joinLink(roomCode)); toast('Посилання на кімнату скопійовано', 'good'); }
  catch { toast('Код: ' + net.formatRoomCode(roomCode)); }
}
$('btn-copy').addEventListener('click', copyCode);
$('room-code').addEventListener('click', copyCode);
$('btn-share').addEventListener('click', async () => {
  if (!roomCode) return;
  const data = { title: 'Морський бій', text: `Го в Морський бій! Код кімнати: ${net.formatRoomCode(roomCode)}`, url: joinLink(roomCode) };
  if (navigator.share) { try { await navigator.share(data); } catch {} } else copyCode();
});

function openJoin(prefill = '') {
  resetSession();
  show('join');
  $('join-code').value = prefill ? net.formatRoomCode(prefill) : '';
  $('join-code').removeAttribute('aria-invalid');
  joinStatus('');
  $('btn-connect').disabled = false;
  if (!prefill && finePointer.matches) $('join-code').focus();
}
$('join-code').addEventListener('input', e => {
  const el = e.target; el.removeAttribute('aria-invalid');
  const parsed = net.parseRoomCode(el.value);
  if (parsed && el.value.length > 7) el.value = net.formatRoomCode(parsed);
});
$('join-form').addEventListener('submit', e => { e.preventDefault(); unlockAudio(); joinRoom(); });

function joinRoom(codeArg) {
  const code = codeArg || net.parseRoomCode($('join-code').value);
  if (!code) { $('join-code').setAttribute('aria-invalid', 'true'); joinStatus('Код має містити 6 символів, наприклад ABC-234.', 'err'); play('error'); return; }
  if (S.op) return;
  if (!window.RTCPeerConnection) { joinStatus('Цей браузер не підтримує онлайн-гру (WebRTC).', 'err'); return; }
  $('join-code').value = net.formatRoomCode(code);
  $('btn-connect').disabled = true;
  joinStatus('Шукаємо кімнату…', 'wait', true);
  S.mode = 'online';
  const op = net.joinRoom(code, { onStatus(s) { if (S.op === op && s === 'connecting') joinStatus('Встановлюємо пряме з’єднання…', 'wait', true); } });
  S.op = op;
  op.promise.then(link => { if (S.op === op) { S.op = null; onLinked('guest', link); } else link.close(); })
    .catch(e => { if (S.op === op) { S.op = null; $('btn-connect').disabled = false; const t = net.netErrorText(e); if (t) joinStatus(t, 'err'); play('error'); } });
}

function onLinked(role, link) {
  S.role = role; S.link = link; S.peerGone = false; S.mode = 'online';
  link.on('message', onMessage);
  link.on('binary', onBinary);
  link.on('close', reason => { if (S.link === link) onPeerLost(reason); });
  play('join');
  chatSys('Суперник на зв’язку. Чат захищено шифруванням WebRTC.');
  if (role === 'host') { send({ t: 'hello', v: net.PROTO, rules: S.rules.id }); lobbyStatus('Суперник під’єднався!', 'ok'); }
  else joinStatus('З’єднано! Отримуємо правила…', 'ok');
}

function onPeerLost(reason) {
  if (S.peerGone) return;
  S.peerGone = true;
  cancelFileTransfers();
  chatSys('Суперник відключився.');
  updateRematchUI(); updateChatAccess();
  if (S.phase === 'over' || S.screen === 'home') { toast('Суперник вийшов'); return; }
  clearTimeout(S.resultTimer);
  if (S.phase === 'battle') { S.phase = 'idle'; wakeLock(false); }
  closeDialogs();
  $('lost-text').textContent = reason === 'bye' ? 'Суперник вийшов з гри.' : reason === 'timeout' ? 'Суперник не відповідає — схоже, зник інтернет.' : 'З’єднання із суперником розірвано.';
  openDialog('dlg-lost');
}
$('btn-lost-home').addEventListener('click', goHome);
$('dlg-lost').addEventListener('cancel', e => e.preventDefault());

const isBool = v => typeof v === 'boolean';
function onMessage(m) {
  switch (m.t) {
    case 'hello': {
      if (m.v !== net.PROTO) { toast('Різні версії гри — оновіть сторінку', 'bad'); goHome(); return; }
      if (S.role === 'guest' && S.phase === 'idle') {
        if (!RULESETS[m.rules]) return;
        S.rules = getRules(m.rules);
        send({ t: 'hello', v: net.PROTO });
        toast(`Правила суперника: ${S.rules.title}`);
        goPlacement();
      } else if (S.role === 'host' && S.phase === 'idle') goPlacement();
      break;
    }
    case 'ready':
      if (S.phase !== 'place' || S.oppReady) return;
      S.oppReady = true;
      S.oppCommit = typeof m.commit === 'string' && /^[0-9a-f]{64}$/.test(m.commit) ? m.commit : null;
      setPlaceStatus(S.ready ? 'Обидва готові!' : 'Суперник готовий! Завершуйте розстановку.', 'ok');
      maybeStart();
      break;
    case 'start':
      if (S.role !== 'guest' || S.phase !== 'place' || !S.ready || !S.oppReady || !['host', 'guest'].includes(m.first)) return;
      startBattle(m.first === 'guest');
      break;
    case 'shot': {
      if (S.phase !== 'battle' || S.myTurn || !inBounds(m.r, m.c) || m.n !== S.inSeq + 1 || S.myFleet.shots[key(m.r, m.c)]) return;
      S.inSeq++;
      const res = S.myFleet.shots[key(m.r, m.c)] ? null : peekShot(m.r, m.c);
      if (!res) return;
      send({ t: 'result', n: m.n, r: m.r, c: m.c, hit: res.hit, sunk: res.sunk, type: res.type, cells: res.cells });
      receiveShot(m.r, m.c);
      break;
    }
    case 'result': {
      const p = S.pendingShot;
      if (S.phase !== 'battle' || !S.busy || !p || m.n !== p.n || m.r !== p.r || m.c !== p.c || !isBool(m.hit) || !isBool(m.sunk)) return;
      let res = { r: p.r, c: p.c, hit: m.hit, sunk: false };
      if (m.hit && m.sunk) {
        const hitSet = new Set(); S.enemyView.forEach((v, i) => { if (v === HIT) hitSet.add(i); });
        const typeOk = S.rules.fleet.some(t => t.type === m.type && Array.isArray(m.cells) && t.size === m.cells.length);
        const left = typeOk && fleetList(S.rules).filter(s => s.type === m.type).length > S.enemySunk.filter(s => s.type === m.type).length;
        if (plausibleSunk(S.rules, m.cells, p.r, p.c, hitSet) && left) res = { ...res, sunk: true, type: m.type, cells: m.cells.map(x => [x[0], x[1]]) };
        else flagSuspicious('некоректне повідомлення про потоплення');
      } else if (!m.hit && m.sunk) flagSuspicious('некоректна відповідь на постріл');
      onResult(res);
      break;
    }
    case 'pause': if (S.phase === 'battle' && !S.paused) pause(false); break;
    case 'resume': if (S.paused && !S.pausedByMe) resume(false); break;
    case 'surrender': if (S.phase === 'battle') { toast('Суперник здався!', 'good'); finish('win', 'surrender'); } break;
    case 'reveal': if (S.over) onReveal(m); else if (S.phase === 'battle') S.pendingReveal = m; break;
    case 'rematch':
      if (S.phase !== 'over' || S.rematchThem) return;
      S.rematchThem = true; updateRematchUI();
      if (S.rematchMe) goPlacement();
      else { toast('Суперник пропонує реванш!', 'good'); chatSys('Суперник пропонує реванш.'); }
      break;
    case 'chat': onChat(m); break;
    case 'ack': markTick(m.id, m.read ? 'read' : 'delivered'); break;
    case 'read': if (Number.isInteger(m.upTo)) for (const [id] of sentTicks) if (id <= m.upTo) markTick(id, 'read'); break;
    case 'file-offer': onFileOffer(m); break;
    case 'file-accept': onFileAccept(m); break;
    case 'file-reject': onFileReject(m); break;
    case 'file-done': onFileDone(m); break;
    case 'file-abort': onFileAbort(m); break;
    case 'bye': S.link?.close('bye'); onPeerLost('bye'); break;
  }
}
/** Обчислює результат без зміни стану (щоб відповісти до анімації). */
function peekShot(r, c) {
  const ship = S.myFleet.shipAt(r, c);
  if (!ship) return { hit: false, sunk: false };
  const sunk = ship.hits + 1 === ship.size;
  return { hit: true, sunk, type: sunk ? ship.type : undefined, cells: sunk ? ship.cells.map(p => [p.r, p.c]) : undefined };
}
function flagSuspicious(reason) {
  if (!S.suspicious) { S.suspicious = reason; toast('Підозріла відповідь суперника', 'bad'); }
}
async function onReveal(m) {
  if (S.revealed || S.mode !== 'online') return;
  const ships = typeof m.salt === 'string' && m.salt.length <= 64 ? fleetFromPayload(S.rules, m.fleet) : null;
  if (!ships) { flagSuspicious('суперник надіслав некоректну розстановку'); renderFair(); return; }
  if (S.oppCommit) {
    const hash = await sha256hex(commitString(m.salt, ships));
    if (hash !== S.oppCommit) { flagSuspicious('розстановку змінено під час гри'); renderFair(); return; }
    const audit = auditLog(S.rules, ships, S.resultLog);
    if (!audit.ok) { flagSuspicious(audit.reason.toLowerCase()); renderFair(); return; }
  }
  const sunkKeys = new Set(S.enemySunk.flatMap(s => s.cells.map(p => key(p.r, p.c))));
  S.revealed = ships.filter(s => !s.cells.every(p => sunkKeys.has(key(p.r, p.c))));
  if (!S.oppCommit) S.revealedUnverified = true;
  renderBattle(); renderFair();
}

/* ================= Чат ================= */
let chatOpen = false, unread = 0, chatId = 0, lastTheirId = 0;
const sentTicks = new Map();
function updateChatAccess() {
  const online = S.mode === 'online' && !!S.link && ['place', 'game'].includes(S.screen);
  $('chat-fab').hidden = !online || chatOpen || S.screen === 'game';
  $('btn-chat-hud').hidden = !online;
  $('chat-peer').textContent = S.peerGone ? 'Суперник не в мережі' : 'Суперник онлайн';
  $('chat-peer').style.color = S.peerGone ? 'var(--muted)' : '';
  if (!online && chatOpen) closeChat();
}
function setUnread(n) {
  unread = n;
  for (const id of ['badge-fab', 'badge-hud']) { const b = $(id); b.hidden = !n; b.textContent = n > 9 ? '9+' : n; }
}
function openChat() {
  chatOpen = true; document.body.classList.add('chat-open'); $('chat').hidden = false; setUnread(0); updateChatAccess();
  if (lastTheirId) send({ t: 'read', upTo: lastTheirId });
  const log = $('chat-log'); log.scrollTop = log.scrollHeight;
  if (finePointer.matches) $('chat-input').focus();
}
function closeChat() { chatOpen = false; document.body.classList.remove('chat-open'); $('chat').hidden = true; updateChatAccess(); }
$('chat-fab').addEventListener('click', () => { play('tap'); openChat(); });
$('btn-chat-hud').addEventListener('click', () => { play('tap'); chatOpen ? closeChat() : openChat(); });
$('chat-close').addEventListener('click', closeChat);
function chatEmptyCheck() {
  const log = $('chat-log');
  if (!log.querySelector('.msg')) log.replaceChildren(h('p', { class: 'chat-empty', text: 'Тут можна підколоти суперника 😉' }));
  else log.querySelector('.chat-empty')?.remove();
}
function appendMsg(el) {
  const log = $('chat-log');
  log.querySelector('.chat-empty')?.remove();
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  log.append(el);
  while (log.children.length > 300) log.firstChild.remove();
  if (atBottom || el.classList.contains('me')) log.scrollTop = log.scrollHeight;
}
const timeNow = () => new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
function chatSys(text) { appendMsg(h('div', { class: 'msg sys', text })); }
function chatMsg(text, me, id) {
  const tick = me ? h('span', { class: 'tick', text: '✓' }) : null;
  const el = h('div', { class: 'msg ' + (me ? 'me' : 'them') }, h('span', { text }), h('div', { class: 'meta' }, h('span', { text: timeNow() }), tick));
  if (me && id) sentTicks.set(id, tick);
  appendMsg(el);
}
function markTick(id, state) {
  const t = sentTicks.get(id); if (!t) return;
  t.textContent = '✓✓'; if (state === 'read') { t.classList.add('read'); sentTicks.delete(id); }
}
$('chat-form').addEventListener('submit', e => {
  e.preventDefault();
  const input = $('chat-input');
  let text = cleanText(input.value, 300);
  if (!text) return;
  if (text.includes('@dsk')) { // прихована панель вкладень
    text = cleanText(text.replace(/@dsk/g, ''), 300);
    openDesk();
    if (!text) { input.value = ''; return; }
  }
  if (!S.link?.open) { toast('Немає з’єднання із суперником', 'bad'); return; }
  const id = ++chatId;
  send({ t: 'chat', id, text });
  chatMsg(text, true, id);
  input.value = '';
});
$('emoji-row').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const input = $('chat-input');
  input.value = (input.value + b.textContent).slice(0, 300);
  if (finePointer.matches) input.focus();
});
function onChat(m) {
  if (!Number.isInteger(m.id) || m.id <= lastTheirId) return;
  const text = cleanText(m.text, 300);
  if (!text) return;
  lastTheirId = m.id;
  chatMsg(text, false);
  send({ t: 'ack', id: m.id, read: chatOpen });
  if (!chatOpen) { setUnread(unread + 1); play('chat'); if (S.screen === 'game') toast('💬 ' + (text.length > 60 ? text.slice(0, 60) + '…' : text)); }
}

/* ================= Вкладення (до 500 МБ, P2P, з шифруванням) =================
   Канал WebRTC уже захищено (DTLS) між двома пристроями — сервери-посередники
   бачать лише зашифрований потік. Пароль додає наскрізний замок поверх цього:
   файл шифрується AES-256-GCM із ключем, похідним від пароля (PBKDF2), тож
   відкрити його зможе лише той, хто знає пароль. Пароль нікуди не передається. */
const FILE_MAX = 500 * 1024 * 1024, CHUNK = 15 * 1024, MAGIC = 0x46;
const VERIFY_TOKEN = 'mb-verify-v1';
const outFile = { id: 0, file: null, state: 'idle', cancel: false, key: null };
const inFile = { id: null, name: '', size: 0, chunks: 0, got: 0, bytes: 0, parts: [], t0: 0, state: 'idle', enc: false, key: null, queue: Promise.resolve(), broken: false };
const blobUrls = [];

function openDesk() { $('desk').hidden = false; if (!chatOpen) openChat(); updateDeskPass(); }
$('desk-hide').addEventListener('click', () => { $('desk').hidden = true; });
function updateDeskPass() {
  const warn = $('desk-pass-warn');
  if (warn) warn.hidden = !!subtle;
  $('desk-pass').disabled = !subtle;
}
$('desk-file').addEventListener('change', e => {
  const f = e.target.files?.[0];
  $('desk-name').textContent = f ? `${cleanFileName(f.name)} · ${fmtBytes(f.size)}` : 'Обрати файл';
});
$('desk-pass-eye')?.addEventListener('click', () => {
  const inp = $('desk-pass'); inp.type = inp.type === 'password' ? 'text' : 'password';
});
function deskProgress(pct, text, lock) {
  $('desk-progress').hidden = pct == null;
  if (pct != null) $('desk-bar').style.width = Math.max(0, Math.min(100, pct)) + '%';
  const stat = $('desk-stat'); stat.replaceChildren(); if (lock) stat.append(icon('shield')); if (text) stat.append(text);
}
$('desk-send').addEventListener('click', async () => {
  const f = $('desk-file').files?.[0];
  if (!S.link?.open) { toast('Немає з’єднання', 'bad'); return; }
  if (!f) { toast('Оберіть файл'); return; }
  if (f.size > FILE_MAX) { toast('Файл більший за 500 МБ', 'bad'); return; }
  if (outFile.state !== 'idle') { toast('Передача вже триває'); return; }
  const pass = subtle ? $('desk-pass').value : '';
  outFile.id = (outFile.id + 1) >>> 0 || 1; outFile.file = f; outFile.state = 'offered'; outFile.cancel = false; outFile.key = null;
  const offer = { t: 'file-offer', id: outFile.id, name: cleanFileName(f.name), size: f.size, chunks: Math.ceil(f.size / CHUNK), enc: false };
  if (pass) {
    try {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      $('desk-send').disabled = true; deskProgress(0, 'Готуємо шифрування…');
      outFile.key = await deriveKey(pass, salt);
      const check = await aesEncrypt(outFile.key, te.encode(VERIFY_TOKEN));
      offer.enc = true; offer.salt = u8ToB64(salt); offer.check = u8ToB64(check);
    } catch { endOut('Не вдалося підготувати шифрування.'); return; }
    if (outFile.state !== 'offered') return;
  }
  send(offer);
  $('desk-stop').hidden = false; $('desk-send').disabled = true;
  deskProgress(0, offer.enc ? 'Зашифровано. Чекаємо, поки суперник прийме…' : 'Чекаємо, поки суперник прийме файл…', offer.enc);
  outFile.timer = setTimeout(() => { if (outFile.state === 'offered') { send({ t: 'file-abort', id: outFile.id }); endOut('Суперник не відповів на запит.'); } }, 60000);
});
$('desk-stop').addEventListener('click', () => {
  if (outFile.state === 'idle') return;
  outFile.cancel = true; send({ t: 'file-abort', id: outFile.id }); endOut('Передачу скасовано.');
});
function endOut(text) {
  clearTimeout(outFile.timer);
  outFile.state = 'idle'; outFile.file = null; outFile.key = null;
  $('desk-stop').hidden = true; $('desk-send').disabled = false;
  deskProgress(null, text);
}
function onFileReject(m) { if (m.id === outFile.id && outFile.state === 'offered') { endOut('Суперник відхилив файл.'); toast('Файл відхилено'); } }
async function onFileAccept(m) {
  if (m.id !== outFile.id || outFile.state !== 'offered') return;
  clearTimeout(outFile.timer);
  outFile.state = 'sending';
  const f = outFile.file, link = S.link, key = outFile.key, total = Math.ceil(f.size / CHUNK), t0 = Date.now();
  chatSys(`Надсилання «${cleanFileName(f.name)}»${key ? ' 🔒' : ''} (${fmtBytes(f.size)})…`);
  try {
    let lastUi = 0;
    for (let i = 0; i < total; i++) {
      if (outFile.cancel || !link.open) throw new Error('stop');
      let payload = new Uint8Array(await f.slice(i * CHUNK, Math.min(f.size, (i + 1) * CHUNK)).arrayBuffer());
      if (key) payload = await aesEncrypt(key, payload);
      const frame = new Uint8Array(9 + payload.length);
      const dv = new DataView(frame.buffer);
      dv.setUint8(0, MAGIC); dv.setUint32(1, outFile.id); dv.setUint32(5, i);
      frame.set(payload, 9);
      await link.drain();
      if (outFile.cancel || !link.open) throw new Error('stop');
      link.sendBinary(frame.buffer);
      const now = Date.now();
      if (now - lastUi > 150 || i === total - 1) {
        lastUi = now;
        const sent = Math.min(f.size, (i + 1) * CHUNK), sec = (now - t0) / 1000;
        deskProgress(sent / f.size * 100, `${fmtBytes(sent)} / ${fmtBytes(f.size)} · ${sec > 0.3 ? fmtBytes(sent / sec) + '/с' : ''}`, !!key);
      }
    }
    if (f.size === 0) deskProgress(100, '', !!key);
    send({ t: 'file-done', id: outFile.id });
    chatSys(`Файл «${cleanFileName(f.name)}» надіслано ✓`);
    endOut(key ? 'Надіслано зашифровано ✓' : 'Надіслано ✓');
    $('desk-file').value = ''; $('desk-name').textContent = 'Обрати файл'; $('desk-pass').value = '';
  } catch {
    if (outFile.state !== 'idle') { send({ t: 'file-abort', id: outFile.id }); endOut('Передачу перервано.'); }
  }
}
function encPayloadLen(ptLen) { return 12 + ptLen + 16; } // iv + ciphertext + GCM-тег
function onFileOffer(m) {
  const ok = Number.isInteger(m.id) && m.id > 0 && Number.isSafeInteger(m.size) && m.size >= 0 && m.size <= FILE_MAX && m.chunks === Math.ceil(m.size / CHUNK);
  if (!ok) return;
  if (inFile.state !== 'idle') { send({ t: 'file-reject', id: m.id }); return; }
  const enc = m.enc === true;
  if (enc && (!subtle || typeof m.salt !== 'string' || typeof m.check !== 'string' || m.salt.length > 64 || m.check.length > 256)) { send({ t: 'file-reject', id: m.id }); toast('Зашифрований файл потребує HTTPS', 'bad'); return; }
  Object.assign(inFile, { id: m.id, name: cleanFileName(m.name), size: m.size, chunks: m.chunks, got: 0, bytes: 0, parts: [], state: 'asking', enc, salt: m.salt, check: m.check, key: null, queue: Promise.resolve(), broken: false });
  $('file-name').textContent = inFile.name;
  $('file-size').textContent = fmtBytes(inFile.size);
  $('file-lock').hidden = !enc;
  play('chat');
  openDialog('dlg-file');
}
$('btn-file-yes').addEventListener('click', () => {
  if (inFile.state !== 'asking') { closeDialog('dlg-file'); return; }
  // 'auth' — прийнято, але ще не підтверджено (щоб подія close діалогу не вважалася відмовою)
  inFile.state = 'auth';
  closeDialog('dlg-file');
  if (inFile.enc) askPassphrase(); else startReceiving();
});
$('btn-file-no').addEventListener('click', () => closeDialog('dlg-file'));
$('dlg-file').addEventListener('close', () => { if (inFile.state === 'asking') { send({ t: 'file-reject', id: inFile.id }); resetIn(); } });

function askPassphrase(error) {
  $('pass-err').textContent = error || '';
  $('pass-err').hidden = !error;
  $('pass-input').value = '';
  openDialog('dlg-pass');
  if (finePointer.matches) setTimeout(() => $('pass-input').focus(), 50);
}
$('pass-eye').addEventListener('click', () => { const i = $('pass-input'); i.type = i.type === 'password' ? 'text' : 'password'; });
$('pass-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (inFile.state !== 'auth') { closeDialog('dlg-pass'); return; }
  const pass = $('pass-input').value;
  if (!pass) { askPassphrase('Введіть пароль.'); return; }
  $('pass-ok').disabled = true;
  try {
    const key = await deriveKey(pass, b64ToU8(inFile.salt));
    await aesDecrypt(key, b64ToU8(inFile.check)); // кине помилку при невірному паролі
    inFile.key = key;
    closeDialog('dlg-pass');
    startReceiving();
  } catch {
    askPassphrase('Невірний пароль. Спробуйте ще раз.');
    play('error');
  } finally { $('pass-ok').disabled = false; }
});
$('pass-cancel').addEventListener('click', () => { closeDialog('dlg-pass'); if (inFile.state === 'auth') { send({ t: 'file-reject', id: inFile.id }); resetIn(); } });
$('dlg-pass').addEventListener('cancel', e => { e.preventDefault(); $('pass-cancel').click(); });

function startReceiving() {
  if (inFile.state !== 'auth') return;
  inFile.state = 'receiving'; inFile.t0 = Date.now(); inFile.got = 0; inFile.bytes = 0; inFile.parts = []; inFile.broken = false; inFile.queue = Promise.resolve();
  openDesk(); deskProgress(0, `Отримання «${inFile.name}»…`, inFile.enc);
  send({ t: 'file-accept', id: inFile.id });
}
function resetIn() { Object.assign(inFile, { id: null, parts: [], state: 'idle', got: 0, bytes: 0, key: null, enc: false, broken: false, queue: Promise.resolve() }); }
function breakIn(text) {
  if (inFile.broken || inFile.state !== 'receiving') return;
  inFile.broken = true;
  send({ t: 'file-abort', id: inFile.id });
  resetIn(); deskProgress(null, text);
}
let lastInUi = 0;
function ptLenAt(idx) { return idx < inFile.chunks - 1 ? CHUNK : inFile.size - CHUNK * (inFile.chunks - 1); }
function onBinary(buf) {
  if (inFile.state !== 'receiving' || inFile.broken || buf.byteLength < 9) return;
  const dv = new DataView(buf);
  if (dv.getUint8(0) !== MAGIC || dv.getUint32(1) !== inFile.id) return;
  const idx = dv.getUint32(5), payload = new Uint8Array(buf, 9);
  const id = inFile.id;
  // Послідовна обробка: розшифрування асинхронне, тож черга зберігає порядок.
  inFile.queue = inFile.queue.then(async () => {
    if (inFile.broken || inFile.state !== 'receiving' || inFile.id !== id) return;
    const expPt = ptLenAt(idx);
    const expLen = inFile.enc ? encPayloadLen(expPt) : expPt;
    if (idx !== inFile.got || payload.length !== expLen || inFile.bytes + expPt > inFile.size) { breakIn('Файл пошкоджено — передачу зупинено.'); return; }
    let plain = payload;
    if (inFile.enc) {
      try { plain = await aesDecrypt(inFile.key, payload); } catch { breakIn('Помилка розшифрування — передачу зупинено.'); return; }
      if (plain.length !== expPt) { breakIn('Файл пошкоджено — передачу зупинено.'); return; }
    }
    inFile.parts.push(plain); inFile.got++; inFile.bytes += plain.length;
    const now = Date.now();
    if (now - lastInUi > 150) {
      lastInUi = now; const sec = (now - inFile.t0) / 1000;
      deskProgress(inFile.bytes / Math.max(1, inFile.size) * 100, `${fmtBytes(inFile.bytes)} / ${fmtBytes(inFile.size)} · ${sec > 0.3 ? fmtBytes(inFile.bytes / sec) + '/с' : ''}`, inFile.enc);
    }
  }).catch(() => breakIn('Помилка отримання файлу.'));
}
function onFileDone(m) {
  if (inFile.state !== 'receiving' || m.id !== inFile.id) return;
  const id = inFile.id, enc = inFile.enc;
  inFile.queue = inFile.queue.then(() => {
    if (inFile.broken || inFile.state !== 'receiving' || inFile.id !== id) return;
    if (inFile.got !== inFile.chunks || inFile.bytes !== inFile.size) { deskProgress(null, 'Файл отримано не повністю.'); resetIn(); return; }
    const name = inFile.name, size = inFile.size, parts = inFile.parts;
    // Тип завжди application/octet-stream — браузер лише зберігає файл, не відкриває як сторінку.
    const blob = new Blob(parts, { type: 'application/octet-stream' });
    const url = URL.createObjectURL(blob); blobUrls.push(url);
    const a = h('a', { href: url, download: name, rel: 'noopener' }, icon('download'), 'Зберегти');
    appendMsg(h('div', { class: 'msg them file' }, h('div', {}, enc ? '🔒 ' : '', h('b', { text: name }), ' · ' + fmtBytes(size)), a));
    deskProgress(100, enc ? 'Отримано й розшифровано ✓' : 'Файл отримано ✓', enc); play('chat'); toast('Файл отримано', 'good');
    resetIn();
    if (!chatOpen) setUnread(unread + 1);
  }).catch(() => breakIn('Помилка збирання файлу.'));
}
function onFileAbort(m) {
  if (m.id === inFile.id && inFile.state !== 'idle') {
    if (inFile.state === 'asking' || inFile.state === 'auth') { closeDialog('dlg-file'); closeDialog('dlg-pass'); }
    resetIn(); deskProgress(null, 'Суперник скасував передачу.');
  }
  if (m.id === outFile.id && outFile.state !== 'idle') { outFile.cancel = true; endOut('Суперник зупинив передачу.'); }
}
function cancelFileTransfers() {
  if (outFile.state !== 'idle') { outFile.cancel = true; endOut(''); }
  if (inFile.state !== 'idle') { if (inFile.state === 'asking' || inFile.state === 'auth') { closeDialog('dlg-file'); closeDialog('dlg-pass'); } resetIn(); deskProgress(null, ''); }
}

/* ================= QR: малювання й сканування ================= */
function drawQR(canvas, text) {
  const m = qrMatrix(text), n = m.length, quiet = 2;
  const size = canvas.width, scale = Math.floor(size / (n + quiet * 2)), off = Math.floor((size - scale * n) / 2);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4fffd'; ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#04202a';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) ctx.fillRect(off + c * scale, off + r * scale, scale, scale);
}

const scan = { stream: null, track: null, raf: 0, detector: null, devices: [], devIdx: -1, torch: false, busy: false };
$('btn-scan').addEventListener('click', () => { unlockAudio(); startScan(); });
$('btn-scan-close').addEventListener('click', () => closeDialog('dlg-scan'));
$('dlg-scan').addEventListener('close', stopScan);
function scanStatus(t) { $('scan-status').textContent = t; }
async function startScan(deviceId) {
  if (!('BarcodeDetector' in window)) {
    joinStatus('Цей браузер не сканує QR усередині сторінки. Наведіть звичайну камеру телефону на QR-код — посилання одразу відкриє гру. Або введіть код вручну.', 'wait');
    return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { joinStatus('Камера доступна лише через HTTPS. Введіть код вручну.', 'err'); return; }
  try {
    const formats = await BarcodeDetector.getSupportedFormats?.() || ['qr_code'];
    if (!formats.includes('qr_code')) throw new Error('fmt');
    scan.detector = scan.detector || new BarcodeDetector({ formats: ['qr_code'] });
  } catch { joinStatus('Сканер QR недоступний у цьому браузері. Введіть код вручну.', 'err'); return; }
  stopScan(true);
  if (!$('dlg-scan').open) openDialog('dlg-scan');
  scanStatus('Запуск камери…');
  scan.busy = true;
  try {
    const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
    if (deviceId) video.deviceId = { exact: deviceId }; else video.facingMode = { ideal: 'environment' };
    scan.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    if (!$('dlg-scan').open) { stopScan(true); return; }
    scan.track = scan.stream.getVideoTracks()[0];
    const v = $('scan-video'); v.srcObject = scan.stream; await v.play().catch(() => {});
    try { const caps = scan.track.getCapabilities?.() || {};
      if (caps.focusMode?.includes('continuous')) await scan.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] });
      $('btn-scan-torch').hidden = !caps.torch; } catch {}
    scan.devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
    const cur = scan.track.getSettings?.().deviceId;
    scan.devIdx = Math.max(0, scan.devices.findIndex(d => d.deviceId === cur));
    $('btn-scan-switch').hidden = scan.devices.length < 2;
    scanStatus('Наведіть камеру на QR-код суперника');
    scanLoop();
  } catch (e) {
    scanStatus(e?.name === 'NotAllowedError' ? 'Доступ до камери заборонено. Дозвольте його в налаштуваннях браузера або введіть код вручну.' : 'Не вдалося увімкнути камеру. Спробуйте іншу або введіть код вручну.');
  } finally { scan.busy = false; }
}
function scanLoop() {
  let last = 0;
  const tick = async (t) => {
    if (!scan.stream) return;
    scan.raf = requestAnimationFrame(tick);
    if (t - last < 160) return; last = t;
    const v = $('scan-video');
    if (v.readyState < 2) return;
    try {
      const codes = await scan.detector.detect(v);
      for (const c of codes) {
        const code = net.parseRoomCode(c.rawValue);
        if (code && scan.stream) { play('join'); closeDialog('dlg-scan'); $('join-code').value = net.formatRoomCode(code); toast('QR розпізнано!', 'good'); joinRoom(code); return; }
      }
    } catch {}
  };
  scan.raf = requestAnimationFrame(tick);
}
function stopScan(keepDialog) {
  cancelAnimationFrame(scan.raf);
  scan.stream?.getTracks().forEach(t => t.stop());
  scan.stream = null; scan.track = null; scan.torch = false;
  const v = $('scan-video'); v.srcObject = null;
  if (keepDialog !== true && $('dlg-scan').open) closeDialog('dlg-scan');
}
$('btn-scan-switch').addEventListener('click', () => {
  if (scan.busy || scan.devices.length < 2) return;
  scan.devIdx = (scan.devIdx + 1) % scan.devices.length;
  startScan(scan.devices[scan.devIdx].deviceId);
});
$('btn-scan-torch').addEventListener('click', async () => {
  if (!scan.track) return;
  scan.torch = !scan.torch;
  try { await scan.track.applyConstraints({ advanced: [{ torch: scan.torch }] }); } catch { scan.torch = false; }
});

/* ================= Діалоги ================= */
function openDialog(id) { const d = $(id); if (!d.open) { try { d.showModal(); } catch { d.setAttribute('open', ''); } } }
function closeDialog(id) { const d = $(id); if (d.open) d.close(); }
function closeDialogs() { for (const id of ['dlg-confirm', 'dlg-pause', 'dlg-end', 'dlg-lost', 'dlg-file', 'dlg-pass', 'dlg-scan']) closeDialog(id); }
function confirmDlg(title, text, okText = 'Так') {
  return new Promise(resolve => {
    const d = $('dlg-confirm');
    $('confirm-title').textContent = title; $('confirm-text').textContent = text; $('confirm-ok').textContent = okText;
    d.returnValue = '';
    d.addEventListener('close', () => resolve(d.returnValue === 'ok'), { once: true });
    openDialog('dlg-confirm');
  });
}

/* ================= Головна / скидання ================= */
function resetSession() {
  if (S.op) { S.op.cancel(); S.op = null; }
  if (S.link) { const l = S.link; S.link = null; try { l.send({ t: 'bye' }); } catch {} setTimeout(() => l.close('local'), 120); }
  clearTimeout(S.botTimer); clearTimeout(S.resultTimer);
  cancelFileTransfers();
  stopScan();
  wakeLock(false);
  closeChat();
  Object.assign(S, { mode: null, role: null, phase: 'idle', over: false, paused: false, busy: false, peerGone: false, ready: false, oppReady: false,
    rematchMe: false, rematchThem: false, revealed: null, pendingReveal: null, suspicious: null, lastShips: null, autoEnemy: null });
  $('chat-log').replaceChildren(); chatEmptyCheck();
  sentTicks.clear(); chatId = 0; lastTheirId = 0; setUnread(0);
  $('desk').hidden = true; deskProgress(null, '');
  while (blobUrls.length) URL.revokeObjectURL(blobUrls.pop());
}
function goHome() {
  closeDialogs();
  resetSession();
  renderStats();
  show('home');
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);
}
$('brand').addEventListener('click', async () => {
  if (S.screen === 'home') return;
  if ((S.phase === 'battle' || (S.mode === 'online' && S.link)) && !(await confirmDlg('Вийти в меню?', 'Поточну гру буде завершено.', 'Вийти'))) return;
  goHome();
});

$('btn-bot').addEventListener('click', () => {
  unlockAudio(); play('tap');
  resetSession();
  S.mode = 'bot'; S.rules = getRules(settings.rules); S.level = settings.level;
  goPlacement();
});

// Перемикачі правил і складності
for (const input of document.querySelectorAll('input[name="rules"]')) {
  input.checked = input.value === settings.rules;
  input.addEventListener('change', () => { settings.rules = input.value; saveSettings(); play('tap'); });
}
for (const input of document.querySelectorAll('input[name="level"]')) {
  input.checked = input.value === settings.level;
  input.addEventListener('change', () => { settings.level = input.value; saveSettings(); play('tap'); });
}

/* ================= Звук, wake lock, встановлення ================= */
function applySound() {
  fx.on = settings.sound;
  const b = $('btn-sound'); b.setAttribute('aria-pressed', String(fx.on)); setIcon(b, fx.on ? 'sound' : 'mute');
}
$('btn-sound').addEventListener('click', () => { settings.sound = !settings.sound; saveSettings(); applySound(); unlockAudio(); play('tap'); });
applySound();

let lock = null, wantLock = false;
async function wakeLock(on) {
  wantLock = on;
  try {
    if (on && !lock && 'wakeLock' in navigator && !document.hidden) { lock = await navigator.wakeLock.request('screen'); lock.addEventListener('release', () => { lock = null; }); }
    else if (!on && lock) { await lock.release(); lock = null; }
  } catch { lock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    if (S.mode === 'bot' && S.phase === 'battle' && !S.paused) pause(true, true);
    if ($('dlg-scan').open) closeDialog('dlg-scan');
  } else if (wantLock) wakeLock(true);
});

let installEvt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installEvt = e; $('btn-install').hidden = false; });
window.addEventListener('appinstalled', () => { $('btn-install').hidden = true; installEvt = null; toast('Гру встановлено!', 'good'); });
$('btn-install').addEventListener('click', async () => {
  if (!installEvt) return;
  installEvt.prompt(); try { await installEvt.userChoice; } catch {}
  installEvt = null; $('btn-install').hidden = true;
});

// Клавіатура
document.addEventListener('keydown', e => {
  if (e.target.closest?.('input, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  if (S.screen === 'place' && (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К')) { e.preventDefault(); rotate(); }
  else if (S.screen === 'game' && (e.key === 'p' || e.key === 'P' || e.key === 'з' || e.key === 'З')) { S.paused ? resume(true) : pause(true); }
  else if (e.key === 'Escape' && chatOpen && !document.querySelector('dialog[open]')) closeChat();
});
window.addEventListener('beforeunload', () => { if (S.link?.open) try { S.link.send({ t: 'bye' }); } catch {} });

/* ================= Service Worker (через Trusted Types) ================= */
const ttPolicy = window.trustedTypes?.createPolicy('mb', {
  createScriptURL: u => { if (u === './sw.js') return u; throw new TypeError('blocked'); }
});
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register(ttPolicy ? ttPolicy.createScriptURL('./sw.js') : './sw.js').catch(() => {}); });
}

/* ================= Старт ================= */
renderStats();
chatEmptyCheck();
function joinFromHash() {
  if (!/join=/.test(location.hash)) return;
  const code = net.parseRoomCode(location.hash);
  history.replaceState(null, '', location.pathname + location.search);
  if (!code || S.phase === 'battle' || S.link) return;
  openJoin(code); setTimeout(() => joinRoom(code), 250);
}
window.addEventListener('hashchange', joinFromHash);
joinFromHash();
