// Синтезовані звуки (без аудіофайлів) + вібрація.
let ctx = null, master = null, noiseBuf = null;
export const fx = { on: true };

function ensure() {
  if (!fx.on) return null;
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { return null; }
    master = ctx.createGain(); master.gain.value = 0.55; master.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
export const unlockAudio = () => { ensure(); };

function tone(freq, to, dur, type = 'sine', vol = 0.2, at = 0) {
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur, freq, vol = 0.4, at = 0, q = 0.8, type = 'lowpass') {
  const t = ctx.currentTime + at;
  const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
  s.buffer = noiseBuf; f.type = type; f.frequency.setValueAtTime(freq, t); f.frequency.exponentialRampToValueAtTime(Math.max(60, freq / 6), t + dur); f.Q.value = q;
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(f); f.connect(g); g.connect(master); s.start(t); s.stop(t + dur + 0.05);
}
const buzz = p => { if (fx.on && navigator.vibrate) try { navigator.vibrate(p); } catch {} };

export function play(kind) {
  if (!ensure() || ctx.state !== 'running') { if (fx.on) haptic(kind); return; }
  switch (kind) {
    case 'tap': tone(700, 900, 0.05, 'triangle', 0.08); break;
    case 'place': tone(260, 180, 0.12, 'triangle', 0.18); noise(0.12, 900, 0.08); break;
    case 'rotate': tone(500, 700, 0.08, 'sine', 0.1); break;
    case 'error': tone(220, 160, 0.16, 'square', 0.06); break;
    case 'shot': noise(0.35, 2400, 0.12, 0, 1, 'bandpass'); tone(900, 140, 0.3, 'sine', 0.06); break;
    case 'miss': noise(0.5, 1400, 0.16, 0.05, 0.6); tone(420, 220, 0.25, 'sine', 0.05, 0.05); break;
    case 'hit': noise(0.55, 1800, 0.5); tone(120, 40, 0.45, 'sawtooth', 0.18); break;
    case 'sink': noise(1.1, 1200, 0.55); tone(160, 30, 1.0, 'sawtooth', 0.2); tone(90, 30, 1.0, 'sine', 0.25, 0.15); break;
    case 'win': [523, 659, 784, 1047].forEach((f, i) => tone(f, 0, 0.35, 'triangle', 0.16, i * 0.12)); break;
    case 'lose': [392, 330, 262, 196].forEach((f, i) => tone(f, 0, 0.4, 'sine', 0.14, i * 0.16)); break;
    case 'chat': tone(880, 0, 0.09, 'sine', 0.1); tone(1320, 0, 0.12, 'sine', 0.08, 0.07); break;
    case 'join': [440, 660, 880].forEach((f, i) => tone(f, 0, 0.18, 'triangle', 0.12, i * 0.08)); break;
  }
  haptic(kind);
}
function haptic(kind) {
  ({ tap: () => buzz(8), place: () => buzz(15), error: () => buzz([20, 40, 20]), shot: () => buzz(12), miss: () => buzz(10),
     hit: () => buzz([40, 30, 60]), sink: () => buzz([60, 40, 80, 40, 140]), win: () => buzz([30, 50, 30, 50, 120]) })[kind]?.();
}
