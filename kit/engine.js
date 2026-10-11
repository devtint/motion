/* Motion engine. Synced into each video by `node kit.mjs sync video.html`.
 *
 * Rule: everything visual is a pure function of scene time, and time comes only
 * from requestAnimationFrame timestamps. So browser playback, seeking, and the
 * frame-by-frame recorder (record_video.py) always agree.
 *
 * Features (all declarative attributes; see SKILL.md / reference/ui-kit.md):
 *   scenes        .scene[data-dur][data-key][data-name], data-in / data-out transitions
 *   counters      data-count="1200" data-count-from data-count-at data-count-dur data-count-dec data-count-prefix/suffix
 *   tweens        data-tween="--p 0 100 .5 1.2 out; --x -20 0 0 .8 back"   (name from to at dur [ease])
 *   timelines     data-timeline="0 happy, 1.2 surprised wave, 3 point"  -> sets data-now
 *   typing        data-type="text" data-type-at="1" data-type-cps="18"
 *   cursor        .cursor[data-path="0 @85/110, .9 #buy click, 1.8 #next"] data-move=".7" data-click-sfx="click"
 *   arrows        path[data-arrow] gets an auto arrowhead;  svg[data-connect="#a #b"] draws a connector
 *   stagger       data-stagger=".3 .1"  -> children get --d = .3 + i*.1
 *   characters    [data-character] gets the rigged SVG from <template id="kit-character">
 *   confetti      .confetti[data-confetti="1.2"] data-pieces="60" data-origin="50/60"
 *   sfx preview   data-sfx cues play from ./sfx/*.wav (node sfx.mjs lib video.html)
 * API: window.__motion = { total, starts, durs, seek(t), play(), pause(), time }
 */
(() => {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';
  const stage = document.getElementById('stage') || document.querySelector('.stage');
  if (!stage) { console.error('motion: no #stage element'); return; }
  const scenes = [...stage.querySelectorAll('.scene')];
  const D = scenes.map(s => parseFloat(s.dataset.dur) || 0);
  const S = []; let TOTAL = 0; for (const d of D) { S.push(TOTAL); TOTAL += d; }
  scenes.forEach((s, i) => s.style.setProperty('--dur', D[i] + 's'));

  const $ = id => document.getElementById(id);
  const clamp01 = x => (x < 0 ? 0 : x > 1 ? 1 : x);
  const parseT = v => { const m = String(v ?? '').trim().match(/^(-?\d*\.?\d+)\s*(ms|s)?$/); return m ? parseFloat(m[1]) / (m[2] === 'ms' ? 1000 : 1) : null; };
  const fmt = s => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
  const ownD = el => parseT(el.style.getPropertyValue('--d'));            // own inline --d only (matches sfx.mjs)
  const within = (s, sel) => [...(s.matches(sel) ? [s] : []), ...s.querySelectorAll(sel)];
  const EASE = {
    linear: x => x,
    in: x => x * x * x,
    out: x => 1 - (1 - x) ** 3,
    inout: x => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
    back: x => 1 + 2.70158 * (x - 1) ** 3 + 1.70158 * (x - 1) ** 2,
    spring: x => (x >= 1 ? 1 : 1 - Math.cos(x * Math.PI * 4.5) * Math.exp(-x * 6)),
  };
  const ease = n => EASE[n] || EASE.out;
  const rng = seed => () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };

  // ---------- one-time setup ----------
  const charTpl = $('kit-character');
  document.querySelectorAll('[data-character]').forEach(el => {
    el.classList.add('char');
    if (el.querySelector('svg.ch')) return;
    if (!charTpl) { console.error('motion: <template id="kit-character"> missing. Run: node kit.mjs sync <file>'); return; }
    el.prepend(charTpl.content.cloneNode(true));
  });

  document.querySelectorAll('[data-stagger]').forEach(p => {
    const [d0, gap] = p.dataset.stagger.trim().split(/\s+/).map(parseT);
    [...p.children].forEach((c, i) => {
      if (!c.style.getPropertyValue('--d')) c.style.setProperty('--d', ((d0 || 0) + i * (gap ?? 0.08)).toFixed(3) + 's');
    });
  });

  const copyTiming = (from, to) => { for (const p of ['--d', '--dd']) { const v = from.style.getPropertyValue(p); if (v) to.style.setProperty(p, v); } };
  function addHead(path, size) {
    let head = path.__head;
    if (!head) {
      head = document.createElementNS(NS, 'path');
      head.setAttribute('class', 'arrow-head');
      path.after(head); path.__head = head; copyTiming(path, head);
    }
    if (!path.hasAttribute('pathLength')) path.setAttribute('pathLength', '1');
    const L = path.getTotalLength(); if (!L) return;
    const e = path.getPointAtLength(L), b = path.getPointAtLength(Math.max(0, L - Math.min(L, 3)));
    const a = Math.atan2(e.y - b.y, e.x - b.x), s = size || parseFloat(path.dataset.arrow) || 12;
    const pt = da => (e.x - s * Math.cos(a + da)).toFixed(2) + ' ' + (e.y - s * Math.sin(a + da)).toFixed(2);
    head.setAttribute('d', `M${pt(0.55)}L${e.x.toFixed(2)} ${e.y.toFixed(2)}L${pt(-0.55)}`);
  }
  document.querySelectorAll('path[data-arrow]').forEach(p => addHead(p));

  // Position of an element relative to the stage, ignoring CSS transforms (entrances move things).
  function box(el) {
    let x = 0, y = 0, e = el;
    while (e && e !== stage && e.offsetParent !== undefined) { x += e.offsetLeft; y += e.offsetTop; e = e.offsetParent; }
    if (e !== stage) { const r = el.getBoundingClientRect(), s = stage.getBoundingClientRect(); return { x: r.left - s.left, y: r.top - s.top, w: r.width, h: r.height }; }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  }
  const find = q => { const el = stage.querySelector(q); if (!el) console.error('motion: target not found:', q); return el; };

  // ---------- per-scene declarations ----------
  const per = fn => scenes.map((s, i) => fn(s, i));

  const counters = per(s => within(s, '[data-count]').map(el => ({
    el, to: +el.dataset.count, from: +(el.dataset.countFrom || 0), at: parseT(el.dataset.countAt) ?? ownD(el) ?? 0,
    dur: parseT(el.dataset.countDur) || 1, dec: +(el.dataset.countDec || 0),
    pre: el.dataset.countPrefix || '', suf: el.dataset.countSuffix || '', ease: ease(el.dataset.countEase) })));

  const tweens = per(s => {
    const groups = new Map();
    for (const el of within(s, '[data-tween]')) {
      for (const spec of el.dataset.tween.split(';').map(x => x.trim()).filter(Boolean)) {
        const [name, from, to, at, dur, e] = spec.split(/\s+/);
        const key = el, list = groups.get(key) || new Map();
        const arr = list.get(name) || [];
        arr.push({ from: +from, to: +to, at: parseT(at) || 0, dur: parseT(dur) || 1, ease: ease(e) });
        list.set(name, arr.sort((a, b) => a.at - b.at)); groups.set(key, list);
      }
    }
    return [...groups].flatMap(([el, m]) => [...m].map(([name, segs]) => ({ el, name, segs })));
  });

  const typers = per(s => within(s, '[data-type]').map(el => {
    const text = el.dataset.type || el.textContent.trim().replace(/\s+/g, " ");
    return { el, text, at: parseT(el.dataset.typeAt) ?? ownD(el) ?? 0, cps: +el.dataset.typeCps || 18, n: -1 };
  }));

  const timelines = per(s => within(s, '[data-timeline]').map(el => ({
    el, base: el.dataset.now || '', cur: null,
    keys: el.dataset.timeline.split(',').map(x => x.trim()).filter(Boolean).map(x => {
      const m = x.match(/^(\S+)\s*(.*)$/); return { at: parseT(m[1]) || 0, now: m[2].trim() };
    }).sort((a, b) => a.at - b.at) })));

  const CURSOR_SVG = '<svg viewBox="0 0 24 26"><path d="M2 1.5V21l5.4-5.1 3.5 7.6 3.6-1.6-3.4-7.5 7.4-.2z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const cursors = per(s => within(s, '.cursor[data-path]').map(el => {
    if (!el.querySelector('svg')) el.insertAdjacentHTML('afterbegin', CURSOR_SVG);
    if (!el.querySelector('.cursor-ripple')) el.insertAdjacentHTML('beforeend', '<i class="cursor-ripple"></i>');
    const steps = el.dataset.path.split(',').map(x => x.trim()).filter(Boolean).map(x => {
      const [at, target, ...flags] = x.split(/\s+/); return { at: parseT(at) || 0, target, click: flags.includes('click') };
    });
    return { el, steps, move: parseT(el.dataset.move) || 0.7, ripple: el.querySelector('.cursor-ripple'), pts: [] };
  }));

  const links = per(s => within(s, 'svg[data-connect]'));

  const confetti = per((s, si) => within(s, '[data-confetti]').map((el, k) => {
    const r = rng(9973 * (si + 1) + 131 * (k + 1)), n = +el.dataset.pieces || 50;
    const [ox, oy] = (el.dataset.origin || '50/50').split('/').map(Number);
    const colors = (el.dataset.colors || 'var(--accent) var(--accent-2) var(--good) var(--warn,#E9B949) var(--ink)').split(/\s+(?![^(]*\))/);
    el.textContent = '';
    const bits = Array.from({ length: n }, (_, j) => {
      const p = document.createElement('i');
      if (r() < 0.3) p.className = 'c';
      p.style.background = colors[j % colors.length];
      el.appendChild(p);
      const ang = (-90 + (r() - 0.5) * 120) * Math.PI / 180, sp = 45 + r() * 70;
      return { p, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp, vr: (r() - 0.5) * 1100, r0: r() * 360, f: 6 + r() * 8 };
    });
    return { el, at: parseT(el.dataset.confetti) ?? ownD(el) ?? 0, ox, oy, bits };
  }));

  // SFX preview cues. Same timing rules as sfx.mjs:
  //   scene start + (data-sfx-at ?? data-type-at ?? own inline --d ?? 0) + @offset;  cursor clicks via data-click-sfx
  const sfxDir = stage.dataset.sfxDir || 'sfx/';
  const cues = per((s, i) => {
    const out = [];
    for (const e of within(s, '[data-sfx]')) {
      const at = parseT(e.dataset.sfxAt) ?? (e.hasAttribute('data-type') ? parseT(e.dataset.typeAt) : null) ?? ownD(e) ?? 0;
      const typeDur = e.hasAttribute('data-type') ? (e.dataset.type || e.textContent.trim().replace(/\s+/g, " ")).length / (+e.dataset.typeCps || 18) : null;
      for (const x of e.dataset.sfx.split(',').map(v => v.trim()).filter(Boolean)) {
        const [n, o] = x.split('@');
        out.push({ at: at + (parseT(o) || 0), name: n.trim(), vol: +(e.dataset.sfxVol || 1), pitch: +(e.dataset.sfxPitch || 0), dur: parseT(e.dataset.sfxDur) ?? typeDur });
      }
    }
    for (const c of cursors[i]) {
      const snd = c.el.dataset.clickSfx; if (!snd || snd === 'none') continue;
      for (const st of c.steps) if (st.click) out.push({ at: st.at, name: snd, vol: +(c.el.dataset.sfxVol || 1), pitch: 0, dur: null });
    }
    return out;
  });
  try {
    const sheet = $('sfx-cues');
    if (sheet) for (const c of JSON.parse(sheet.textContent)) {
      const t0 = parseT(c.t), si = t0 != null ? sceneAtT(t0) : scenes.findIndex(s => s.dataset.key === c.scene);
      if (si >= 0) cues[si].push({ at: t0 != null ? t0 - S[si] : parseT(c.at) || 0, name: c.sfx || c.name, vol: +(c.vol ?? 1), pitch: +(c.pitch || 0), dur: parseT(c.dur) });
    }
  } catch (e) { console.warn('sfx-cues:', e.message); }
  const audible = !navigator.webdriver;
  function playSfx(c) {
    if (!audible) return;
    const a = new Audio(/\.\w+$/.test(c.name) ? c.name : sfxDir + c.name + '.wav');
    a.volume = Math.min(1, c.vol); a.preservesPitch = false; a.playbackRate = 2 ** (c.pitch / 12);
    a.play().catch(() => {});
    if (c.dur) setTimeout(() => a.pause(), c.dur * 1000);
  }

  // ---------- layout (needs the scene visible; re-run on resize) ----------
  function layoutLinks(i) {
    const W = stage.clientWidth, H = stage.clientHeight;
    for (const svg of links[i]) {
      const [a, b] = svg.dataset.connect.trim().split(/\s+/).map(find);
      if (!a || !b) continue;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      let path = svg.querySelector('path.link-path');
      if (!path) {
        path = document.createElementNS(NS, 'path');
        path.setAttribute('class', 'link-path'); path.setAttribute('pathLength', '1');
        copyTiming(svg, path); svg.appendChild(path);
      }
      const A = box(a), B = box(b), gap = W * 0.008, bend = parseFloat(svg.dataset.bend ?? 0.5);
      const ax = A.x + A.w / 2, ay = A.y + A.h / 2, bx = B.x + B.w / 2, by = B.y + B.h / 2;
      let p1, p2, c1, c2;
      if (Math.abs(bx - ax) >= Math.abs(by - ay)) {
        const dir = bx >= ax ? 1 : -1;
        p1 = [ax + dir * (A.w / 2 + gap), ay]; p2 = [bx - dir * (B.w / 2 + gap), by];
        const k = (p2[0] - p1[0]) * bend; c1 = [p1[0] + k, p1[1]]; c2 = [p2[0] - k, p2[1]];
      } else {
        const dir = by >= ay ? 1 : -1;
        p1 = [ax, ay + dir * (A.h / 2 + gap)]; p2 = [bx, by - dir * (B.h / 2 + gap)];
        const k = (p2[1] - p1[1]) * bend; c1 = [p1[0], p1[1] + k]; c2 = [p2[0], p2[1] - k];
      }
      const f = p => p.map(v => v.toFixed(1)).join(' ');
      path.setAttribute('d', `M${f(p1)}C${f(c1)} ${f(c2)} ${f(p2)}`);
      if (svg.dataset.head !== 'none') addHead(path, W * 0.012);
    }
  }
  function layoutCursors(i) {
    const W = stage.clientWidth, H = stage.clientHeight;
    for (const c of cursors[i]) c.pts = c.steps.map(st => {
      if (st.target.startsWith('@')) { const [px, py] = st.target.slice(1).split('/').map(Number); return [px / 100 * W, py / 100 * H]; }
      const el = find(st.target); st.el = el;
      if (!el) return [W / 2, H / 2];
      const b = box(el); return [b.x + b.w / 2, b.y + b.h / 2];
    });
  }
  function layout(i) {
    scenes[i].querySelectorAll('path[data-arrow]').forEach(p => addHead(p));
    layoutLinks(i); layoutCursors(i);
  }

  // ---------- state ----------
  let idx = -1, t = 0, last = null, playing = !window.__PAUSE_AUTOPLAY, prevEl = 0;
  const bornAt = new WeakMap();      // animations started by a timeline change -> their start time
  function sceneAtT(x) { let i = 0; while (i < D.length - 1 && x >= S[i + 1]) i++; return i; }

  function enter(i) {
    for (const tl of timelines[i]) { tl.el.dataset.now = tl.base; tl.cur = tl.base; }
    for (const ty of typers[i]) ty.n = -1;
    scenes.forEach(s => s.classList.remove('active'));
    void stage.offsetWidth;                         // reflow so keyframes restart on re-entry
    scenes[i].classList.add('active');
    idx = i; prevEl = -1e-6;
    layout(i);
  }

  function render() {
    const el = t - S[idx], sc = scenes[idx], W = stage.clientWidth, H = stage.clientHeight;

    for (const c of counters[idx]) {
      const p = c.ease(clamp01((el - c.at) / c.dur));
      c.el.textContent = c.pre + (c.from + (c.to - c.from) * p).toFixed(c.dec) + c.suf;
    }
    for (const tw of tweens[idx]) {
      let seg = tw.segs[0];
      for (const s of tw.segs) if (el >= s.at) seg = s;
      const v = seg.from + (seg.to - seg.from) * seg.ease(clamp01((el - seg.at) / seg.dur));
      tw.el.style.setProperty(tw.name, +v.toFixed(4));
    }
    for (const ty of typers[idx]) {
      const n = Math.max(0, Math.min(ty.text.length, Math.floor((el - ty.at) * ty.cps + 1e-6)));
      if (n !== ty.n) { ty.el.textContent = ty.text.slice(0, n); ty.n = n; }
      ty.el.classList.toggle('typing', el >= ty.at - 0.4 && n < ty.text.length);
    }
    for (const tl of timelines[idx]) {
      let v = tl.base, since = 0;
      for (const k of tl.keys) if (el >= k.at) { v = k.now; since = k.at; }
      if (v !== tl.cur) {
        const before = new Set(sc.getAnimations({ subtree: true }));
        tl.el.dataset.now = v; tl.cur = v;
        for (const a of sc.getAnimations({ subtree: true })) if (!before.has(a)) bornAt.set(a, S[idx] + since);
      }
    }
    for (const c of cursors[idx]) renderCursor(c, el);
    for (const cf of confetti[idx]) {
      const dt = el - cf.at;
      cf.el.style.visibility = dt < 0 ? 'hidden' : 'visible';
      if (dt < 0) continue;
      const k = 1.6, drag = (1 - Math.exp(-k * dt)) / k, aspect = H / W, fade = 1 - clamp01((dt - 1.8) / 0.7);
      for (const b of cf.bits) {
        const x = cf.ox + b.vx * drag, y = cf.oy * aspect + b.vy * drag + 0.5 * 45 * dt * dt;
        b.p.style.transform = `translate(${x.toFixed(2)}cqw,${y.toFixed(2)}cqw) rotate(${(b.r0 + b.vr * dt).toFixed(1)}deg) scaleY(${Math.cos(dt * b.f + b.r0).toFixed(3)})`;
        b.p.style.opacity = fade;
      }
    }
    if (playing) for (const c of cues[idx]) if (c.at > prevEl && c.at <= el) playSfx(c);
    prevEl = el;

    if (seekEl) seekEl.value = t;
    if (timeEl) timeEl.textContent = fmt(t) + ' / ' + fmt(TOTAL);
    if (playBtn) playBtn.textContent = playing ? 'Pause' : 'Play';
  }

  function renderCursor(c, el) {
    const { steps, pts } = c; if (!pts.length) return;
    let x = pts[0][0], y = pts[0][1];
    for (let k = 1; k < steps.length; k++) {
      const s0 = Math.max(steps[k - 1].at, steps[k].at - c.move);
      if (el < s0) break;
      const p = EASE.inout(clamp01((el - s0) / Math.max(1e-3, steps[k].at - s0)));
      const [x0, y0] = pts[k - 1], [x1, y1] = pts[k], arc = Math.sin(Math.PI * p) * 0.08;
      x = x0 + (x1 - x0) * p - (y1 - y0) * arc; y = y0 + (y1 - y0) * p + (x1 - x0) * arc;
    }
    let scale = 1, ripple = null;
    const pressed = new Set();
    for (const st of steps) {
      if (!st.click || el < st.at) continue;
      const dt = el - st.at;
      if (dt < 0.2) { scale = 1 - 0.18 * Math.sin(Math.PI * dt / 0.2); if (st.el) pressed.add(st.el); }
      if (dt < 0.6) ripple = dt;
    }
    for (const st of steps) if (st.el) st.el.classList.toggle('pressed', pressed.has(st.el));
    c.el.style.transform = `translate(${x.toFixed(1)}px,${y.toFixed(1)}px) scale(${scale.toFixed(3)})`;
    if (c.ripple) {
      c.ripple.style.opacity = ripple == null ? 0 : (1 - ripple / 0.6).toFixed(3);
      c.ripple.style.transform = `scale(${ripple == null ? 0.3 : (0.3 + EASE.out(ripple / 0.6) * 1.1).toFixed(3)})`;
    }
  }

  // Seek: rebuild the scene at time x; CSS animations are placed at their matching offsets.
  function seek(x) {
    t = Math.max(0, Math.min(TOTAL, x));
    const i = sceneAtT(t);
    enter(i);
    prevEl = t - S[i];                // do not replay sound cues we jumped over
    render();
    for (const a of scenes[i].getAnimations({ subtree: true })) {
      a.currentTime = (t - (bornAt.get(a) ?? S[i])) * 1000;
      playing ? a.play() : a.pause();
    }
  }
  const setPlaying = p => {
    playing = p; last = null;
    for (const a of scenes[idx].getAnimations({ subtree: true })) p ? a.play() : a.pause();
    render();
  };

  function tick(ts) {
    if (last === null) last = ts;
    const dt = (ts - last) / 1000; last = ts;
    if (playing) {
      t += dt;
      if (t >= TOTAL) { t = TOTAL; playing = false; }   // hold the last frame
      const i = sceneAtT(t);
      if (i !== idx) enter(i);
    }
    render();
    requestAnimationFrame(tick);
  }

  // ---------- controls (all optional) ----------
  const seekEl = $('seek'), timeEl = $('time'), playBtn = $('play');
  if (seekEl) { seekEl.max = TOTAL; seekEl.step = 0.01; seekEl.oninput = () => seek(+seekEl.value); }
  if (playBtn) playBtn.onclick = () => { if (t >= TOTAL) seek(0); setPlaying(!playing); };
  if ($('prev')) $('prev').onclick = () => seek(S[Math.max(0, idx - (t - S[idx] < 0.5 ? 1 : 0))]);
  if ($('next')) $('next').onclick = () => seek(S[Math.min(scenes.length - 1, idx + 1)]);
  if ($('replay')) $('replay').onclick = () => { seek(0); setPlaying(true); };
  if ($('fs')) $('fs').onclick = () => (document.fullscreenElement ? document.exitFullscreen() : stage.requestFullscreen());
  document.addEventListener('keydown', e => {
    if (e.target.closest && e.target.closest('input,textarea')) return;
    if (e.code === 'Space') { e.preventDefault(); if (t >= TOTAL) seek(0); setPlaying(!playing); }
    if (e.code === 'ArrowRight') seek(S[Math.min(scenes.length - 1, idx + 1)]);
    if (e.code === 'ArrowLeft') seek(S[Math.max(0, idx - (t - S[idx] < 0.5 ? 1 : 0))]);
  });

  new ResizeObserver(() => { if (idx >= 0) { layout(idx); render(); } }).observe(stage);
  if (document.fonts) document.fonts.ready.then(() => { if (idx >= 0) { layout(idx); render(); } });

  window.__motion = {
    total: TOTAL, starts: S, durs: D, seek,
    play: () => setPlaying(true), pause: () => setPlaying(false),
    get time() { return t; },
  };
  enter(0);
  render();
  requestAnimationFrame(tick);
})();
