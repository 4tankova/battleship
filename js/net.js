// Пряме P2P-з'єднання (WebRTC DataChannel). Сервер PeerJS використовується лише як «поштар» для
// обміну SDP/ICE під час з'єднання — далі весь трафік гри йде напряму між гравцями.
// Стороння бібліотека не потрібна: жоден зовнішній скрипт не виконується на сторінці.

const SIGNAL_URL = 'wss://0.peerjs.com/peerjs';
const SIGNAL_KEY = 'peerjs';
const PREFIX = 'mbua2-';
const APP = 'morskyi-biy';
export const PROTO = 3;

const TURN_URL = 'https://battleship-ua.metered.live/api/v1/turn/credentials?apiKey=3e47d2e924270530b05f29d1aea8854f3bd8';
const FALLBACK_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
];

export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_RE = new RegExp(`^[${ROOM_ALPHABET}]{6}$`);

function randomString(len, alphabet) {
  const out = [];
  const max = 256 - (256 % alphabet.length);
  while (out.length < len) {
    const buf = crypto.getRandomValues(new Uint8Array(len * 2));
    for (const b of buf) if (b < max && out.length < len) out.push(alphabet[b % alphabet.length]);
  }
  return out.join('');
}
export const newRoomCode = () => randomString(6, ROOM_ALPHABET);
export const formatRoomCode = code => code.slice(0, 3) + '-' + code.slice(3);

/** Приймає код у будь-якому вигляді: «k7q-2xp», «K7Q2XP» або посилання з #join=K7Q2XP. */
export function parseRoomCode(input) {
  let s = String(input || '').trim();
  const m = s.match(/[#?&]join=([A-Za-z0-9-]{6,8})/);
  if (m) s = m[1];
  s = s.toUpperCase().replace(/[\s\-_.​-‍﻿]/g, '');
  // Неоднозначні символи (O, I, L, 0, 1) у кодах не використовуються.
  return ROOM_RE.test(s) ? s : null;
}

class Emitter {
  constructor() { this._h = new Map(); }
  on(ev, fn) { if (!this._h.has(ev)) this._h.set(ev, new Set()); this._h.get(ev).add(fn); return () => this._h.get(ev)?.delete(fn); }
  emit(ev, ...a) { for (const fn of [...(this._h.get(ev) || [])]) { try { fn(...a); } catch (e) { console.error(e); } } }
}

let iceCache = null;
async function getIceServers() {
  if (iceCache && Date.now() - iceCache.t < 10 * 60e3) return iceCache.v;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(TURN_URL, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
    clearTimeout(timer);
    if (!res.ok) throw new Error('turn');
    const data = await res.json();
    const list = (Array.isArray(data) ? data : data?.iceServers || []).filter(s => s && (typeof s.urls === 'string' || Array.isArray(s.urls)))
      .map(s => ({ urls: s.urls, username: typeof s.username === 'string' ? s.username : undefined, credential: typeof s.credential === 'string' ? s.credential : undefined }));
    if (!list.length) throw new Error('turn');
    iceCache = { t: Date.now(), v: [...list, ...FALLBACK_ICE] };
  } catch {
    iceCache = { t: Date.now() - 9 * 60e3, v: FALLBACK_ICE };
  }
  return iceCache.v;
}

/* ---------------- Сигнальний канал ---------------- */
class Signal extends Emitter {
  constructor(id) { super(); this.id = id; this.ws = null; this.hb = null; this.closed = false; }
  open(timeout = 12000) {
    return new Promise((resolve, reject) => {
      const token = randomString(16, 'abcdefghijklmnopqrstuvwxyz0123456789');
      const url = `${SIGNAL_URL}?key=${SIGNAL_KEY}&id=${encodeURIComponent(this.id)}&token=${token}&version=1.5.4`;
      let settled = false;
      const done = (err) => { if (settled) return; settled = true; clearTimeout(t); err ? reject(err) : resolve(); };
      const t = setTimeout(() => { done(new NetError('signal-timeout')); this.close(); }, timeout);
      let ws;
      try { ws = new WebSocket(url); } catch { done(new NetError('signal-failed')); return; }
      this.ws = ws;
      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string' || ev.data.length > 100000) return;
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || typeof msg.type !== 'string') return;
        switch (msg.type) {
          case 'OPEN': done(); break;
          case 'ID-TAKEN': done(new NetError('id-taken')); this.close(); break;
          case 'ERROR': done(new NetError('signal-failed')); this.emit('error', msg.payload?.msg); break;
          default: this.emit('message', msg);
        }
      };
      ws.onerror = () => done(new NetError('signal-failed'));
      ws.onclose = () => { this.stopHb(); done(new NetError('signal-failed')); if (!this.closed) this.emit('lost'); };
      ws.onopen = () => {
        this.hb = setInterval(() => { if (ws.readyState === 1) ws.send('{"type":"HEARTBEAT"}'); }, 5000);
      };
    });
  }
  send(type, dst, payload) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ type, dst, payload }));
  }
  stopHb() { clearInterval(this.hb); this.hb = null; }
  close() {
    this.closed = true; this.stopHb();
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }
}

export class NetError extends Error {
  constructor(code) { super(code); this.code = code; }
}

/* ---------------- Ігровий канал ---------------- */
export class Link extends Emitter {
  constructor(pc, dc) {
    super();
    this.pc = pc; this.dc = dc; this.closed = false;
    this.lastRx = Date.now();
    this.bucket = { tokens: 120, t: Date.now() };
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;
    dc.onmessage = (ev) => {
      this.lastRx = Date.now();
      if (typeof ev.data === 'string') {
        if (ev.data.length > 32768 || !this.allow()) return;
        let msg; try { msg = JSON.parse(ev.data); } catch { return; }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string') return;
        if (msg.t === 'ping') return;
        this.emit('message', msg);
      } else if (ev.data instanceof ArrayBuffer) {
        if (ev.data.byteLength > 70000) return;
        this.emit('binary', ev.data);
      }
    };
    dc.onclose = () => this.close('closed');
    dc.onerror = () => {};
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'failed' || s === 'closed') this.close('failed');
      else if (s === 'disconnected') {
        clearTimeout(this.dcTimer);
        this.dcTimer = setTimeout(() => { if (pc.connectionState === 'disconnected') this.close('failed'); }, 10000);
      }
    };
    this.onVis = () => { if (!document.hidden) this.lastRx = Date.now(); };
    document.addEventListener('visibilitychange', this.onVis);
    this.hb = setInterval(() => {
      if (this.closed) return;
      if (dc.readyState === 'open') dc.send('{"t":"ping"}');
      if (!document.hidden && Date.now() - this.lastRx > 30000) this.close('timeout');
    }, 3000);
  }
  allow() {
    const now = Date.now(), b = this.bucket;
    b.tokens = Math.min(120, b.tokens + (now - b.t) * 0.06); b.t = now; // ~60 повідомлень/с
    if (b.tokens < 1) return false;
    b.tokens--; return true;
  }
  get open() { return !this.closed && this.dc.readyState === 'open'; }
  send(obj) { if (this.open) this.dc.send(JSON.stringify(obj)); }
  sendBinary(buf) { if (this.open) this.dc.send(buf); }
  get buffered() { return this.dc.bufferedAmount; }
  drain() {
    if (this.dc.bufferedAmount <= this.dc.bufferedAmountLowThreshold) return Promise.resolve();
    return new Promise(res => {
      const done = () => { this.dc.removeEventListener('bufferedamountlow', done); clearInterval(poll); res(); };
      const poll = setInterval(() => { if (this.closed || this.dc.bufferedAmount <= this.dc.bufferedAmountLowThreshold) done(); }, 200);
      this.dc.addEventListener('bufferedamountlow', done);
    });
  }
  close(reason = 'local') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.hb); clearTimeout(this.dcTimer);
    document.removeEventListener('visibilitychange', this.onVis);
    try { this.dc.close(); } catch {}
    try { this.pc.close(); } catch {}
    this.emit('close', reason);
  }
}

function validSdp(s) { return typeof s === 'string' && s.length > 10 && s.length < 30000 && s.startsWith('v=0'); }
function validCandidate(c) {
  return c && typeof c === 'object' && typeof c.candidate === 'string' && c.candidate.length < 2000 &&
    (c.sdpMid == null || typeof c.sdpMid === 'string') && (c.sdpMLineIndex == null || Number.isInteger(c.sdpMLineIndex));
}

function wirePc(pc, signal, peerId, sid) {
  const queue = [];
  let remoteSet = false;
  pc.onicecandidate = (e) => { if (e.candidate) signal.send('CANDIDATE', peerId, { app: APP, sid, c: e.candidate.toJSON() }); };
  return {
    async setRemote(desc) { await pc.setRemoteDescription(desc); remoteSet = true; for (const c of queue.splice(0)) pc.addIceCandidate(c).catch(() => {}); },
    addCandidate(c) { if (!validCandidate(c)) return; if (remoteSet) pc.addIceCandidate(c).catch(() => {}); else if (queue.length < 50) queue.push(c); }
  };
}

/**
 * Створює кімнату. onCode(code) викликається, коли код зареєстровано і можна ділитися.
 * Повертає { promise: Promise<Link>, cancel() }.
 */
export function hostRoom({ onCode, onStatus } = {}) {
  let signal = null, cancelled = false, pc = null, timer = null;
  const cancel = () => { cancelled = true; clearTimeout(timer); signal?.close(); try { pc?.close(); } catch {} };
  const promise = (async () => {
    const ice = await getIceServers();
    let code;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (cancelled) throw new NetError('cancelled');
      code = newRoomCode();
      signal = new Signal(PREFIX + code);
      try { await signal.open(); break; }
      catch (e) { signal.close(); signal = null; if (e.code !== 'id-taken' || attempt === 3) throw e; }
    }
    if (cancelled) { signal.close(); throw new NetError('cancelled'); }
    onCode?.(code);
    return await new Promise((resolve, reject) => {
      let busy = false;
      signal.on('lost', () => { if (!cancelled && !busy) reject(new NetError('signal-lost')); });
      let wired = null, sid = null, peer = null;
      const reset = () => { busy = false; wired = null; sid = null; peer = null; try { pc?.close(); } catch {} pc = null; onStatus?.('waiting'); };
      signal.on('message', async (msg) => {
        if (cancelled) return;
        const p = msg.payload, src = msg.src;
        if (!p || p.app !== APP || typeof src !== 'string' || src.length > 64 || typeof p.sid !== 'string' || p.sid.length > 40) return;
        if (msg.type === 'OFFER') {
          if (busy) { signal.send('ANSWER', src, { app: APP, sid: p.sid, error: 'busy' }); return; }
          if (p.v !== PROTO) { signal.send('ANSWER', src, { app: APP, sid: p.sid, error: 'version' }); return; }
          if (!validSdp(p.sdp)) return;
          busy = true; sid = p.sid; peer = src;
          onStatus?.('connecting');
          pc = new RTCPeerConnection({ iceServers: ice });
          const myPc = pc;
          wired = wirePc(pc, signal, src, sid);
          pc.ondatachannel = (e) => {
            const dc = e.channel;
            if (dc.label !== 'mb') { dc.close(); return; }
            const opened = () => {
              if (myPc !== pc || cancelled) return;
              clearTimeout(timer);
              const link = new Link(myPc, dc);
              setTimeout(() => signal.close(), 1500);
              resolve(link);
            };
            if (dc.readyState === 'open') opened(); else dc.onopen = opened;
          };
          timer = setTimeout(() => { if (myPc === pc) reset(); }, 30000);
          try {
            await wired.setRemote({ type: 'offer', sdp: p.sdp });
            const ans = await pc.createAnswer();
            await pc.setLocalDescription(ans);
            signal.send('ANSWER', src, { app: APP, sid, sdp: pc.localDescription.sdp });
          } catch { if (myPc === pc) reset(); }
        } else if (msg.type === 'CANDIDATE' && src === peer && p.sid === sid) {
          wired?.addCandidate(p.c);
        } else if ((msg.type === 'LEAVE' || msg.type === 'EXPIRE') && src === peer) {
          reset();
        }
      });
    });
  })();
  return { promise, cancel };
}

/** Під'єднання до кімнати за кодом. Повертає { promise: Promise<Link>, cancel() }. */
export function joinRoom(code, { onStatus } = {}) {
  let signal = null, cancelled = false, pc = null, timer = null;
  const cancel = () => { cancelled = true; clearTimeout(timer); signal?.close(); try { pc?.close(); } catch {} };
  const promise = (async () => {
    const ice = await getIceServers();
    if (cancelled) throw new NetError('cancelled');
    signal = new Signal(PREFIX + 'g-' + randomString(12, 'abcdefghijklmnopqrstuvwxyz0123456789'));
    await signal.open();
    if (cancelled) { signal.close(); throw new NetError('cancelled'); }
    onStatus?.('connecting');
    const hostId = PREFIX + code;
    const sid = randomString(16, 'abcdefghijklmnopqrstuvwxyz0123456789');
    pc = new RTCPeerConnection({ iceServers: ice });
    const dc = pc.createDataChannel('mb', { ordered: true });
    const wired = wirePc(pc, signal, hostId, sid);
    return await new Promise(async (resolve, reject) => {
      const fail = (c) => { clearTimeout(timer); signal.close(); try { pc.close(); } catch {} reject(new NetError(c)); };
      timer = setTimeout(() => fail('join-timeout'), 30000);
      signal.on('lost', () => { if (dc.readyState !== 'open') fail('signal-lost'); });
      signal.on('message', async (msg) => {
        const p = msg.payload;
        if (msg.src !== hostId) return;
        if (msg.type === 'EXPIRE') { fail('no-room'); return; }
        if (!p || p.app !== APP || p.sid !== sid) return;
        if (msg.type === 'ANSWER') {
          if (p.error) { fail(p.error === 'busy' ? 'room-busy' : p.error === 'version' ? 'version' : 'join-failed'); return; }
          if (!validSdp(p.sdp)) return;
          try { await wired.setRemote({ type: 'answer', sdp: p.sdp }); } catch { fail('join-failed'); }
        } else if (msg.type === 'CANDIDATE') {
          wired.addCandidate(p.c);
        }
      });
      dc.onopen = () => {
        if (cancelled) return;
        clearTimeout(timer);
        const link = new Link(pc, dc);
        setTimeout(() => signal.close(), 1500);
        resolve(link);
      };
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        signal.send('OFFER', hostId, { app: APP, v: PROTO, sid, sdp: pc.localDescription.sdp });
      } catch { fail('join-failed'); }
    });
  })();
  return { promise, cancel };
}

export function netErrorText(e) {
  const code = e?.code || '';
  return ({
    'signal-timeout': 'Сервер з’єднання не відповідає. Перевірте інтернет і спробуйте ще раз.',
    'signal-failed': 'Не вдалося під’єднатися до сервера гри. Перевірте інтернет.',
    'signal-lost': 'З’єднання з сервером перервалося. Спробуйте ще раз.',
    'id-taken': 'Не вдалося створити кімнату. Спробуйте ще раз.',
    'no-room': 'Кімнату не знайдено. Перевірте код — можливо, її вже закрили.',
    'room-busy': 'У цій кімнаті вже грають.',
    'version': 'У суперника інша версія гри. Оновіть сторінку на обох пристроях.',
    'join-timeout': 'Не вдалося встановити пряме з’єднання. Спробуйте іншу мережу (наприклад, мобільний інтернет).',
    'join-failed': 'Не вдалося під’єднатися до кімнати.',
    'cancelled': ''
  })[code] ?? 'Помилка мережі. Спробуйте ще раз.';
}
