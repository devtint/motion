#!/usr/bin/env node
/**
 * sfx.mjs — procedural sound effects + frame-exact audio track for HTML motion videos.
 *
 * Zero dependencies (Node >= 18). Every sound is synthesized from math, so there are
 * no audio assets to license or ship, and the same input always renders the same bytes.
 *
 * Cues live in the HTML, next to the thing that makes the sound:
 *
 *   <button class="p" style="--d:.6s" data-sfx="click">Buy</button>      at scene start + 0.6s (from --d)
 *   <div data-sfx="typing" data-sfx-at="1.2" data-sfx-dur="2">...</div>   explicit time + length
 *   <section class="scene" data-dur="5" data-sfx="whoosh">                at scene start
 *   <span data-sfx="pop, correct@0.4" data-sfx-vol="0.6" data-sfx-pitch="3" data-sfx-pan="-0.5">
 *   <div data-sfx="assets/boom.mp3">                                      your own file (decoded by ffmpeg)
 *
 * or as an absolute-time cue sheet anywhere in the page:
 *
 *   <script type="application/json" id="sfx-cues">
 *     [{"t": 12.5, "sfx": "boom"}, {"scene": "close", "at": 0.8, "sfx": "chime", "vol": 0.7}]
 *   </script>
 *
 * Commands:
 *   node sfx.mjs list                                 list built-in sounds
 *   node sfx.mjs play <name> [--dur s] [--pitch st]   audition a sound (ffplay)
 *   node sfx.mjs cues <video.html> [--json]           print the cue sheet (timecodes)
 *   node sfx.mjs lib  <video.html | dir>              write every sound as WAV into <dir>/sfx (browser preview)
 *   node sfx.mjs track <video.html> [-o out.wav]      render the mixed audio track
 *   node sfx.mjs mux  <video.html> <video.mp4> [-o out.mp4]   render track + mux into the MP4
 *
 * Track / mux options:
 *   --vol 0.9               master volume (default 0.9)
 *   --music bed.mp3         background music under the SFX (looped, faded out at the end)
 *   --music-vol 0.25        music volume (default 0.25)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SR = 48000;
const TAU = Math.PI * 2;
const HERE = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// DSP primitives
// ---------------------------------------------------------------------------

/** xorshift32 — deterministic randomness so renders are byte-identical. */
function rng(seed) {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const samples = (sec) => Math.max(1, Math.round(sec * SR));

/** Linear attack, exponential decay (time constant d). */
const env = (t, a, d) => (t < 0 ? 0 : t < a ? t / a : Math.exp(-(t - a) / d));

/** Fill a buffer from fn(t, i). */
function gen(sec, fn) {
  const out = new Float32Array(samples(sec));
  for (let i = 0; i < out.length; i++) out[i] = fn(i / SR, i);
  return out;
}

/** RBJ biquad. `freq` may be a number or a function of time (swept filter). */
function filt(x, type, freq, q = 0.707) {
  const y = new Float32Array(x.length);
  const fn = typeof freq === 'function' ? freq : null;
  let b0, b1, b2, a1, a2, x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const set = (f) => {
    f = Math.min(Math.max(f, 20), SR * 0.45);
    const w = (TAU * f) / SR, c = Math.cos(w), al = Math.sin(w) / (2 * q), a0 = 1 + al;
    if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; }
    else if (type === 'hp') { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; }
    else { b0 = al; b1 = 0; b2 = -al; } // band-pass, 0 dB peak
    b0 /= a0; b1 /= a0; b2 /= a0; a1 = (-2 * c) / a0; a2 = (1 - al) / a0;
  };
  set(fn ? fn(0) : freq);
  for (let i = 0; i < x.length; i++) {
    if (fn && (i & 31) === 0) set(fn(i / SR));
    const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}

function noise(sec, r, type, freq, q) {
  const n = gen(sec, () => r() * 2 - 1);
  return type ? filt(n, type, freq, q) : n;
}

/** Oscillator with a constant or time-varying frequency. */
function osc(sec, freq, wave = 'sine') {
  const fn = typeof freq === 'function' ? freq : () => freq;
  let ph = 0;
  return gen(sec, (t) => {
    ph += fn(t) / SR; ph -= Math.floor(ph);
    switch (wave) {
      case 'square': return Math.tanh(4 * Math.sin(TAU * ph)) * 0.8; // band-limited-ish
      case 'tri': return 1 - 4 * Math.abs(ph - 0.5);
      case 'saw': return 2 * ph - 1;
      default: return Math.sin(TAU * ph);
    }
  });
}

/** Bell / chime: sum of partials with a shared exponential decay. */
function bell(f, decay, partials = [[1, 1], [2, 0.25], [3, 0.08]], len = decay * 5) {
  return gen(len, (t) => {
    let v = 0;
    for (const [m, a] of partials) v += a * Math.sin(TAU * f * m * t) * Math.exp(-t * m * 0.6 / decay);
    return v * env(t, 0.003, decay);
  });
}

/** Mix `src` into `dst` at `sec` with `gain`; grows nothing, clips to dst length. */
function place(dst, src, sec, gain = 1) {
  const o = Math.round(sec * SR);
  for (let i = 0; i < src.length && o + i < dst.length; i++) if (o + i >= 0) dst[o + i] += src[i] * gain;
  return dst;
}

function peakOf(x) { let p = 0; for (let i = 0; i < x.length; i++) p = Math.max(p, Math.abs(x[i])); return p; }

function normalize(x, peak) {
  const p = peakOf(x);
  if (p > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / p;
  return x;
}

/** Short fades so a cut sound never clicks. `head` is off for synths: it would blunt their attack. */
function fadeEdges(x, sec = 0.004, head = true) {
  const n = Math.min(samples(sec), x.length >> 1);
  for (let i = 0; i < n; i++) { const g = i / n; if (head) x[i] *= g; x[x.length - 1 - i] *= g; }
  return x;
}

/** Linear-interpolation resample: rate > 1 = higher pitch and shorter. */
function resample(x, rate) {
  if (rate === 1) return x;
  const out = new Float32Array(Math.max(1, Math.floor(x.length / rate)));
  for (let i = 0; i < out.length; i++) {
    const p = i * rate, k = Math.floor(p), f = p - k;
    out[i] = (x[k] || 0) * (1 - f) + (x[k + 1] || 0) * f;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sound library. make({ r, dur }) returns a mono Float32Array; it is then
// normalized to `peak` so every sound sits at a consistent loudness.
// ---------------------------------------------------------------------------

const LIB = {
  click: {
    desc: 'UI button click', peak: 0.7,
    make: ({ r }) => {
      const n = noise(0.05, r, 'hp', 3000), s = osc(0.05, 3400);
      return gen(0.05, (t, i) => (n[i] * 0.7 + s[i] * 0.45) * env(t, 0.0004, 0.004));
    },
  },
  tick: {
    desc: 'clock tick / small UI tick', peak: 0.55,
    make: ({ r }) => {
      const n = noise(0.03, r, 'bp', 5200, 3), s = osc(0.03, 2600);
      return gen(0.03, (t, i) => (n[i] * 0.6 + s[i] * 0.5) * env(t, 0.0002, 0.0018));
    },
  },
  pop: {
    desc: 'bubbly pop for elements appearing', peak: 0.75,
    make: () => {
      const s = osc(0.14, (t) => 280 + 1000 * Math.exp(-t / 0.018));
      return gen(0.14, (t, i) => s[i] * env(t, 0.001, 0.035));
    },
  },
  bubble: {
    desc: 'rising bloop', peak: 0.65,
    make: () => {
      const s = osc(0.16, (t) => 350 + 1300 * (1 - Math.exp(-t / 0.03)));
      return gen(0.16, (t, i) => s[i] * env(t, 0.002, 0.04));
    },
  },
  toggle: {
    desc: 'switch flipped (two-part click)', peak: 0.6,
    make: ({ r }) => {
      const out = new Float32Array(samples(0.1));
      place(out, LIB.click.make({ r }), 0, 1);
      place(out, resample(LIB.click.make({ r }), 1.5), 0.035, 0.6);
      return out;
    },
  },
  key: {
    desc: 'single keyboard keystroke', peak: 0.6,
    make: ({ r }) => {
      const fc = 1700 + r() * 1500, rel = 0.045 + r() * 0.03, thumpF = 140 + r() * 40;
      const n = noise(0.14, r, 'bp', fc, 1.4), n2 = noise(0.14, r, 'bp', fc * 1.3, 2), th = osc(0.14, thumpF);
      return gen(0.14, (t, i) =>
        n[i] * env(t, 0.0005, 0.007) + th[i] * 0.35 * env(t, 0.001, 0.012) + n2[i] * 0.4 * env(t - rel, 0.0005, 0.005));
    },
  },
  typing: {
    desc: 'burst of typing (use data-sfx-dur, default 1.5s)', peak: 0.55, dur: 1.5,
    make: ({ r, dur }) => {
      const out = new Float32Array(samples(dur + 0.15));
      let t = 0.01, k = 0;
      while (t < dur - 0.04) {
        const kr = rng(Math.floor(r() * 2 ** 32));
        const space = r() < 0.12;
        let key = LIB.key.make({ r: kr });
        if (space) key = resample(key, 0.8); // spacebar: deeper
        place(out, key, t, 0.65 + 0.35 * r());
        t += 0.055 + r() * 0.085 + (r() < 0.07 ? 0.18 : 0);
        k++;
      }
      return out;
    },
  },
  correct: {
    desc: 'right answer / success (two rising notes)', peak: 0.6,
    make: () => {
      const out = new Float32Array(samples(1.2));
      place(out, bell(880, 0.22), 0);
      place(out, bell(1318.5, 0.35), 0.1);
      return out;
    },
  },
  wrong: {
    desc: 'wrong answer / error buzz (two falling notes)', peak: 0.4,
    make: () => {
      const note = (f, len) => {
        const a = osc(len, f, 'square'), b = osc(len, f * 1.007, 'square');
        const raw = gen(len, (t, i) => (a[i] + b[i]) * 0.5 * Math.min(1, t / 0.005, (len - t) / 0.04));
        return filt(raw, 'lp', 1400);
      };
      const out = new Float32Array(samples(0.5));
      place(out, note(233, 0.16), 0);
      place(out, note(175, 0.28), 0.17);
      return out;
    },
  },
  ding: {
    desc: 'single bright bell', peak: 0.55,
    make: () => bell(1568, 0.45, [[1, 1], [2, 0.35], [2.76, 0.18], [5.4, 0.06]], 1.6),
  },
  notify: {
    desc: 'notification ping (two quick notes)', peak: 0.55,
    make: () => {
      const out = new Float32Array(samples(1));
      place(out, bell(1318.5, 0.16), 0);
      place(out, bell(1975.5, 0.28), 0.11);
      return out;
    },
  },
  chime: {
    desc: 'reveal arpeggio (C-E-G-C bells)', peak: 0.55,
    make: () => {
      const out = new Float32Array(samples(2));
      [1046.5, 1318.5, 1568, 2093].forEach((f, i) => place(out, bell(f, 0.5), i * 0.075, 1 - i * 0.12));
      return out;
    },
  },
  levelup: {
    desc: 'celebration / achievement arpeggio', peak: 0.5,
    make: () => {
      const notes = [523.25, 659.25, 783.99, 1046.5, 1318.5];
      const out = new Float32Array(samples(1));
      notes.forEach((f, i) => {
        const last = i === notes.length - 1, len = last ? 0.55 : 0.14, s = osc(len, f, 'tri');
        place(out, gen(len, (t, k) => s[k] * env(t, 0.003, last ? 0.22 : 0.07)), i * 0.065);
      });
      return out;
    },
  },
  coin: {
    desc: 'collect / reward blip', peak: 0.45,
    make: () => {
      const a = osc(0.075, 987.77, 'square'), b = osc(0.45, 1318.5, 'square');
      const out = new Float32Array(samples(0.55));
      place(out, gen(0.075, (t, i) => a[i] * Math.min(1, t / 0.002)), 0);
      place(out, gen(0.45, (t, i) => b[i] * env(t, 0.001, 0.12)), 0.075);
      return filt(out, 'lp', 5000);
    },
  },
  whoosh: {
    desc: 'scene transition swoosh (data-sfx-dur, default 0.7s)', peak: 0.7, dur: 0.7,
    make: ({ r, dur }) => {
      const f = (t) => 350 + 2600 * Math.pow(Math.sin((Math.PI * Math.min(t, dur)) / dur), 1.5);
      const hi = noise(dur, r, 'bp', f, 0.8), lo = noise(dur, r, 'lp', (t) => f(t) * 0.4);
      return gen(dur, (t, i) => (hi[i] + lo[i] * 0.5) * Math.pow(Math.sin((Math.PI * t) / dur), 2));
    },
  },
  swipe: {
    desc: 'short fast swipe (cards, slides)', peak: 0.55, dur: 0.28,
    make: ({ r, dur }) => {
      const n = noise(dur, r, 'bp', (t) => 1200 + 4000 * (t / dur), 1.2);
      return gen(dur, (t, i) => n[i] * Math.pow(Math.sin((Math.PI * t) / dur), 1.5));
    },
  },
  riser: {
    desc: 'tension build-up (data-sfx-dur, default 1.6s) - end it on the hit', peak: 0.6, dur: 1.6,
    make: ({ r, dur }) => {
      const n = noise(dur, r, 'bp', (t) => 300 * 2 ** ((t / dur) * 4.3), 1.6);
      const s = filt(osc(dur, (t) => 110 * 2 ** ((t / dur) * 3), 'saw'), 'lp', 3000);
      return gen(dur, (t, i) => {
        const p = t / dur;
        return (n[i] * Math.pow(p, 2.2) + s[i] * 0.25 * p * p) * Math.min(1, (dur - t) / 0.015);
      });
    },
  },
  boom: {
    desc: 'deep impact / bass hit', peak: 0.95,
    make: ({ r }) => {
      const s = osc(1.6, (t) => 38 + 90 * Math.exp(-t / 0.07));
      const crack = noise(1.6, r, 'lp', 1200);
      return gen(1.6, (t, i) => Math.tanh(1.6 * (s[i] * env(t, 0.002, 0.38) + crack[i] * 0.6 * env(t, 0.0005, 0.03))));
    },
  },
  shutter: {
    desc: 'camera shutter / screenshot', peak: 0.6,
    make: ({ r }) => {
      const n = noise(0.22, r, 'hp', 1800), th = osc(0.22, 90);
      return gen(0.22, (t, i) => {
        let v = 0;
        for (const at of [0, 0.07]) v += n[i] * env(t - at, 0.0005, 0.012) + th[i] * 0.5 * env(t - at, 0.001, 0.02);
        return v;
      });
    },
  },
  glitch: {
    desc: 'digital glitch stutter', peak: 0.42, dur: 0.45,
    make: ({ r, dur }) => {
      const out = new Float32Array(samples(dur));
      let i = 0;
      while (i < out.length) {
        const len = samples(0.012 + r() * 0.033), kind = Math.floor(r() * 4), f = 200 + r() * 1800, hold = 2 + Math.floor(r() * 12);
        let held = 0;
        for (let k = 0; k < len && i < out.length; k++, i++) {
          if (kind === 0) out[i] = r() * 2 - 1;
          else if (kind === 1) out[i] = Math.sign(Math.sin((TAU * f * k) / SR)) * 0.6;
          else if (kind === 2) out[i] = 0;
          else { if (k % hold === 0) held = r() * 2 - 1; out[i] = held; }
        }
      }
      for (let k = 0; k < out.length; k++) out[k] = Math.round(out[k] * 6) / 6; // bit-crush
      return out;
    },
  },
  alert: {
    desc: 'warning double-beep', peak: 0.35,
    make: () => {
      const b = filt(osc(0.085, 1046.5, 'square'), 'lp', 3000);
      const out = new Float32Array(samples(0.3));
      place(out, fadeEdges(b, 0.005), 0);
      place(out, fadeEdges(Float32Array.from(b), 0.005), 0.15);
      return out;
    },
  },
  beep: {
    desc: 'single sine beep (countdowns)', peak: 0.35,
    make: () => fadeEdges(osc(0.14, 1000), 0.006),
  },
  sparkle: {
    desc: 'magic shimmer (many tiny bells)', peak: 0.45,
    make: ({ r }) => {
      const out = new Float32Array(samples(1.1));
      for (let k = 0; k < 12; k++) place(out, bell(2600 + r() * 3600, 0.12, [[1, 1], [2.4, 0.2]], 0.5), r() * 0.55, 0.3 + r() * 0.5);
      return out;
    },
  },
};

const ALIASES = {
  success: 'correct', right: 'correct', error: 'wrong', fail: 'wrong',
  impact: 'boom', hit: 'boom', drop: 'boom', type: 'typing', keystroke: 'key',
  swoosh: 'whoosh', transition: 'whoosh', camera: 'shutter', reward: 'coin',
  celebrate: 'levelup', achievement: 'levelup', ping: 'notify', bell: 'ding',
  reveal: 'chime', switch: 'toggle', countdown: 'beep', warning: 'alert', magic: 'sparkle',
};

const AUDIO_FILE = /\.(wav|mp3|ogg|m4a|aac|flac|opus)$/i;

function resolveName(name) {
  const n = name.toLowerCase();
  return LIB[n] ? n : ALIASES[n] || null;
}

/** Render one built-in sound as mono Float32Array. */
function synth(name, { seed = 1, dur, pitch = 0 } = {}) {
  const key = resolveName(name);
  if (!key) throw new Error(`Unknown sound "${name}". Run "node sfx.mjs list".`);
  const def = LIB[key];
  const x = def.make({ r: rng(seed), dur: dur || def.dur || 1 });
  normalize(x, def.peak);
  fadeEdges(x, 0.002, false);
  return resample(x, 2 ** (pitch / 12));
}

// ---------------------------------------------------------------------------
// ffmpeg helpers
// ---------------------------------------------------------------------------

function findTool(name) {
  const probe = spawnSync(name, ['-version'], { stdio: 'ignore' });
  if (!probe.error && probe.status === 0) return name;
  const dirs = [path.join(HERE, 'tools'), path.join(os.homedir(), '.claude', 'skills', 'motion', 'tools')];
  const want = new Set([name, `${name}.exe`]);
  const walk = (d) => {
    if (!fs.existsSync(d)) return null;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { const hit = walk(p); if (hit) return hit; }
      else if (want.has(e.name.toLowerCase())) return p;
    }
    return null;
  };
  for (const d of dirs) { const hit = walk(d); if (hit) return hit; }
  return null;
}

function requireTool(name) {
  const p = findTool(name);
  if (!p) die(`${name} not found on PATH or in ./tools/.`);
  return p;
}

/** Decode any audio file to stereo float32 at SR. */
function decodeFile(file) {
  const ff = requireTool('ffmpeg');
  const res = spawnSync(ff, ['-v', 'error', '-i', file, '-f', 'f32le', '-ac', '2', '-ar', String(SR), '-'],
    { maxBuffer: 1 << 30 });
  if (res.status !== 0) die(`ffmpeg could not decode ${file}:\n${res.stderr}`);
  const all = new Float32Array(res.stdout.buffer.slice(res.stdout.byteOffset, res.stdout.byteOffset + res.stdout.length));
  const L = new Float32Array(all.length >> 1), R = new Float32Array(all.length >> 1);
  for (let i = 0; i < L.length; i++) { L[i] = all[2 * i]; R[i] = all[2 * i + 1]; }
  return { L, R };
}

function wavBytes(L, R = L) {
  const n = L.length, b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  const q = (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
  for (let i = 0; i < n; i++) { b.writeInt16LE(q(L[i]), 44 + i * 4); b.writeInt16LE(q(R[i]), 46 + i * 4); }
  return b;
}

// ---------------------------------------------------------------------------
// Cue extraction (must match the preview logic in kit/engine.js)
//   time = scene start + (data-sfx-at ?? data-type-at ?? element's own inline --d ?? 0) + @offset
//   cursor clicks: .cursor[data-path][data-click-sfx] -> one cue per "click" step
// ---------------------------------------------------------------------------

const decode = (s) => s.trim().replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/\s+/g, ' ');

function parseTime(v) {
  if (v == null) return null;
  const m = String(v).trim().match(/^(-?\d*\.?\d+)\s*(ms|s)?$/);
  return m ? parseFloat(m[1]) / (m[2] === 'ms' ? 1000 : 1) : null;
}

const num = (v, d) => (v == null || v === '' || isNaN(+v) ? d : +v);

function parseAttrs(s) {
  const o = {}, re = /([^\s=\/"'>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s))) o[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  return o;
}

function parseSpec(spec) {
  return String(spec).split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
    const [name, off] = x.split('@');
    return { name: name.trim(), off: parseTime(off) || 0 };
  });
}

export function extractCues(html) {
  const warnings = [];
  const sheet = html.match(/<script\b[^>]*\bid\s*=\s*["']sfx-cues["'][^>]*>([\s\S]*?)<\/script>/i);
  const clean = html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|template)\b[\s\S]*?<\/\1\s*>/gi, '');

  const scenes = [], cues = [];
  let total = 0, cur = null, m;
  const tagRe = /<([a-zA-Z][\w-]*)(\s[^>]*)?>/g;
  while ((m = tagRe.exec(clean))) {
    const a = parseAttrs(m[2] || '');
    const cls = (a.class || '').split(/\s+/).filter(Boolean);
    if (cls.includes('scene') && 'data-dur' in a) {
      const dur = parseFloat(a['data-dur']) || 0;
      cur = { index: scenes.length, key: a['data-key'] || `scene-${scenes.length}`, name: a['data-name'] || '', start: total, dur };
      scenes.push(cur);
      total += dur;
    }
    const src = `<${m[1]}${a.id ? '#' + a.id : cls.length ? '.' + cls[0] : ''}>`;

    // Cursor clicks: <div class="cursor" data-path="0 @80/110, 1.2 #btn click" data-click-sfx="click">
    if ('data-path' in a && a['data-click-sfx'] && a['data-click-sfx'] !== 'none' && cur) {
      for (const step of a['data-path'].split(',').map((x) => x.trim().split(/\s+/))) {
        if (!step.includes('click')) continue;
        const at = parseTime(step[0]) || 0;
        cues.push({ t: cur.start + at, scene: cur.key, at, name: a['data-click-sfx'], vol: num(a['data-sfx-vol'], 1), pitch: 0, pan: 0, dur: null, src: `${src} click` });
      }
    }

    if (!('data-sfx' in a) || !a['data-sfx'].trim()) continue;
    if (!cur) { warnings.push(`data-sfx="${a['data-sfx']}" sits outside any .scene; ignored`); continue; }
    // Same rule as kit/engine.js: data-sfx-at ?? data-type-at (typing elements) ?? own inline --d ?? 0
    const inlineD = (a.style || '').match(/--d\s*:\s*([\d.]+\s*(?:ms|s)?)/);
    const typed = 'data-type' in a;
    const at = parseTime(a['data-sfx-at']) ?? (typed ? parseTime(a['data-type-at']) : null) ?? (inlineD ? parseTime(inlineD[1]) : null) ?? 0;
    let typeDur = null;
    if (typed) {
      const text = a['data-type'] || decode((clean.slice(m.index + m[0].length).match(/^[^<]*/) || [''])[0]);
      typeDur = text.length / (num(a['data-type-cps'], 0) || 18);
    }
    for (const { name, off } of parseSpec(a['data-sfx'])) {
      cues.push({
        t: cur.start + at + off, scene: cur.key, at: at + off, name,
        vol: num(a['data-sfx-vol'], 1), pitch: num(a['data-sfx-pitch'], 0), pan: num(a['data-sfx-pan'], 0),
        dur: parseTime(a['data-sfx-dur']) ?? typeDur,
        src,
      });
    }
  }

  if (sheet) {
    let items = [];
    try { items = JSON.parse(sheet[1]); } catch (e) { warnings.push(`#sfx-cues is not valid JSON: ${e.message}`); }
    for (const it of Array.isArray(items) ? items : []) {
      const name = it.sfx || it.name;
      let t = parseTime(it.t);
      let sc = null;
      if (t == null && it.scene != null) {
        sc = scenes.find((s) => s.key === it.scene) || scenes[it.scene];
        if (!sc) { warnings.push(`#sfx-cues: unknown scene "${it.scene}"`); continue; }
        t = sc.start + (parseTime(it.at) || 0);
      }
      if (!name || t == null) { warnings.push(`#sfx-cues: entry needs "sfx" and "t" (or "scene"+"at"): ${JSON.stringify(it)}`); continue; }
      sc = sc || [...scenes].reverse().find((s) => t >= s.start) || scenes[0];
      cues.push({ t, scene: sc ? sc.key : '', at: sc ? t - sc.start : t, name, vol: num(it.vol, 1), pitch: num(it.pitch, 0), pan: num(it.pan, 0), dur: parseTime(it.dur), src: '#sfx-cues' });
    }
  }

  cues.sort((a, b) => a.t - b.t);
  for (const c of cues) {
    if (!AUDIO_FILE.test(c.name) && !resolveName(c.name)) warnings.push(`unknown sound "${c.name}" at ${fmt(c.t)} (${c.src})`);
    if (c.t >= total) warnings.push(`cue "${c.name}" at ${fmt(c.t)} is past the end of the video (${fmt(total)})`);
  }
  return { scenes, total, cues, warnings };
}

// ---------------------------------------------------------------------------
// Track rendering
// ---------------------------------------------------------------------------

function renderTrack(info, baseDir, { vol = 0.9, music, musicVol = 0.25 } = {}) {
  const n = samples(info.total);
  const L = new Float32Array(n), R = new Float32Array(n);
  const fileCache = new Map();

  info.cues.forEach((c, idx) => {
    let l, r;
    if (AUDIO_FILE.test(c.name)) {
      const file = path.resolve(baseDir, c.name);
      if (!fs.existsSync(file)) die(`Audio file not found: ${file}`);
      if (!fileCache.has(file)) fileCache.set(file, decodeFile(file));
      const d = fileCache.get(file), rate = 2 ** (c.pitch / 12);
      l = resample(d.L, rate); r = resample(d.R, rate);
      if (c.dur) { l = fadeEdges(l.slice(0, samples(c.dur))); r = fadeEdges(r.slice(0, samples(c.dur))); }
    } else {
      l = r = synth(c.name, { seed: hash(`${c.name}|${idx}|${c.t.toFixed(4)}`), dur: c.dur, pitch: c.pitch });
    }
    const pan = Math.max(-1, Math.min(1, c.pan));
    const g = c.vol * vol;
    place(L, l, c.t, g * (pan > 0 ? 1 - pan : 1));
    place(R, r, c.t, g * (pan < 0 ? 1 + pan : 1));
  });

  if (music) {
    const d = decodeFile(path.resolve(baseDir, music));
    const fade = samples(Math.min(1.5, info.total / 4));
    for (let i = 0; i < n && d.L.length; i++) {
      const k = i % d.L.length;
      const g = musicVol * Math.min(1, i / samples(0.3), (n - i) / fade);
      L[i] += d.L[k] * g; R[i] += d.R[k] * g;
    }
  }

  const peak = Math.max(peakOf(L), peakOf(R));
  if (peak > 0.98) {
    const s = 0.98 / peak;
    for (let i = 0; i < n; i++) { L[i] *= s; R[i] *= s; }
    console.log(`  [INFO] Overlapping cues peaked at ${peak.toFixed(2)}; track scaled by ${s.toFixed(2)} to avoid clipping.`);
  }
  return { L, R };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function fmt(t) {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function die(msg) { console.error(`[FAIL] ${msg}`); process.exit(1); }

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o') opt.output = argv[++i];
    else if (a.startsWith('--')) {
      const k = a.slice(2), v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) opt[k] = true; else { opt[k] = v; i++; }
    } else pos.push(a);
  }
  return { pos, opt };
}

function loadHtml(p) {
  if (!p || !fs.existsSync(p)) die(`HTML file not found: ${p}`);
  const info = extractCues(fs.readFileSync(p, 'utf8'));
  for (const w of info.warnings) console.warn(`  [WARN] ${w}`);
  return info;
}

function cmdList() {
  console.log('Built-in sounds (use in data-sfx="..."):\n');
  for (const [k, v] of Object.entries(LIB)) console.log(`  ${k.padEnd(9)} ${v.desc}`);
  const byTarget = {};
  for (const [a, t] of Object.entries(ALIASES)) (byTarget[t] ||= []).push(a);
  console.log('\nAliases:');
  for (const [t, as] of Object.entries(byTarget)) console.log(`  ${as.join(', ')} -> ${t}`);
  console.log('\nAny audio file path also works: data-sfx="assets/my-sound.mp3"');
}

function cmdCues(htmlPath, opt) {
  const info = loadHtml(htmlPath);
  if (opt.json) { console.log(JSON.stringify(info, null, 2)); return; }
  console.log(`Cue sheet: ${path.basename(htmlPath)}  (${info.cues.length} cues, ${fmt(info.total)} total)\n`);
  console.log('| Time | Scene | SFX | Source |');
  console.log('| :--- | :--- | :--- | :--- |');
  for (const c of info.cues) {
    const extra = [c.dur ? `${+c.dur.toFixed(2)}s` : '', c.vol !== 1 ? `vol ${c.vol}` : '', c.pitch ? `${c.pitch > 0 ? '+' : ''}${c.pitch}st` : '', c.pan ? `pan ${c.pan}` : ''].filter(Boolean).join(', ');
    console.log(`| \`${fmt(c.t)}\` | \`${c.scene}\` | ${c.name}${extra ? ` (${extra})` : ''} | \`${c.src}\` |`);
  }
  if (info.warnings.length) process.exitCode = 1;
}

function cmdLib(target) {
  let dir = target || 'sfx';
  if (/\.html?$/i.test(dir)) dir = path.join(path.dirname(path.resolve(dir)), 'sfx');
  fs.mkdirSync(dir, { recursive: true });
  for (const k of Object.keys(LIB)) {
    const x = synth(k, { seed: hash(k), dur: k === 'typing' ? 4 : undefined });
    fs.writeFileSync(path.join(dir, `${k}.wav`), wavBytes(x));
  }
  for (const [a, t] of Object.entries(ALIASES)) fs.copyFileSync(path.join(dir, `${t}.wav`), path.join(dir, `${a}.wav`));
  console.log(`  [OK] Wrote ${Object.keys(LIB).length + Object.keys(ALIASES).length} WAVs to ${dir}`);
}

function cmdPlay(name, opt) {
  if (!name) die('usage: node sfx.mjs play <name> [--dur s] [--pitch semitones]');
  const x = synth(name, { seed: hash(name), dur: parseTime(opt.dur), pitch: num(opt.pitch, 0) });
  const tmp = path.join(os.tmpdir(), `sfx-${process.pid}-${name}.wav`);
  fs.writeFileSync(tmp, wavBytes(x));
  const ffplay = findTool('ffplay');
  if (!ffplay) { console.log(`  ffplay not found; wrote ${tmp}`); return; }
  spawnSync(ffplay, ['-nodisp', '-autoexit', '-loglevel', 'error', tmp], { stdio: 'inherit' });
  fs.rmSync(tmp, { force: true });
}

function trackOpts(opt) {
  return { vol: num(opt.vol, 0.9), music: opt.music, musicVol: num(opt['music-vol'], 0.25) };
}

function cmdTrack(htmlPath, opt) {
  const info = loadHtml(htmlPath);
  const out = opt.output || htmlPath.replace(/\.html?$/i, '') + '-sfx.wav';
  const { L, R } = renderTrack(info, path.dirname(path.resolve(htmlPath)), trackOpts(opt));
  fs.writeFileSync(out, wavBytes(L, R));
  console.log(`  [OK] ${info.cues.length} cues -> ${out} (${fmt(info.total)})`);
}

function cmdMux(htmlPath, videoPath, opt) {
  if (!videoPath || !fs.existsSync(videoPath)) die(`Video not found: ${videoPath}`);
  const info = loadHtml(htmlPath);
  if (!info.cues.length && !opt.music) die('No data-sfx cues or #sfx-cues found in the HTML; nothing to mux.');
  const ff = requireTool('ffmpeg');
  const out = opt.output || videoPath.replace(/\.mp4$/i, '') + '-sfx.mp4';
  const tmpWav = path.join(os.tmpdir(), `sfx-track-${process.pid}.wav`);
  const inPlace = path.resolve(out) === path.resolve(videoPath);
  const tmpOut = inPlace ? out.replace(/\.mp4$/i, '') + `.muxing-${process.pid}.mp4` : out;

  const { L, R } = renderTrack(info, path.dirname(path.resolve(htmlPath)), trackOpts(opt));
  fs.writeFileSync(tmpWav, wavBytes(L, R));
  const res = spawnSync(ff, ['-y', '-v', 'error', '-i', videoPath, '-i', tmpWav, '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tmpOut], { encoding: 'utf8' });
  fs.rmSync(tmpWav, { force: true });
  if (res.status !== 0) { fs.rmSync(tmpOut, { force: true }); die(`ffmpeg mux failed:\n${res.stderr}`); }
  if (inPlace) fs.renameSync(tmpOut, out);
  console.log(`  [OK] Muxed ${info.cues.length} SFX cues${opt.music ? ' + music' : ''} -> ${out}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  switch (cmd) {
    case 'list': cmdList(); break;
    case 'play': cmdPlay(pos[0], opt); break;
    case 'cues': cmdCues(pos[0], opt); break;
    case 'lib': cmdLib(pos[0]); break;
    case 'track': cmdTrack(pos[0], opt); break;
    case 'mux': cmdMux(pos[0], pos[1], opt); break;
    default: {
      const doc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1];
      console.log(doc.replace(/^ \* ?/gm, ''));
      process.exit(cmd ? 1 : 0);
    }
  }
}
