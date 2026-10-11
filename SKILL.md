---
name: motion
description: Build self-contained HTML/CSS/SVG motion videos (16:9, 9:16, 1:1) such as product demos, UI walkthroughs, explainers, pitches, social reels, with a built-in motion kit (85 draw-on icons, a rigged pebble mascot ("Blip") with poses and moods, auto-headed arrows and connectors, a scripted mouse cursor that clicks and types, UI widgets, counters, confetti, scene transitions). Adds frame-synced sound effects synthesized in Node.js and exports a frame-perfect 1080p/4K MP4 via Playwright + FFmpeg. Use for any animated video, motion graphic, app/UI demo video, or HTML animation that should become an MP4.
---

# HTML Motion Video Engine

A video is **one HTML file**: scenes of HTML/CSS/SVG on a 16:9 (or 9:16, 1:1) stage, animated
by declarative attributes, previewable in any browser, exported to a frame-perfect MP4 with a
sample-exact sound-effects track.

| File | Role |
| :--- | :--- |
| `kit.mjs` | `new` a video, `sync` the kit into it (run after every edit), list `icons`, build the `gallery` |
| `kit/` | The motion kit: `kit.css`, `engine.js`, `icons.svg`, `character.svg`, `skeleton.html`, `gallery.html` (visual catalog) |
| `reference/ui-kit.md` | **Full attribute and class reference.** Read it before building scenes. |
| `template.html` | Showcase video using every feature (character, cursor + typing UI demo, connectors, ring, confetti, SFX). Copy patterns from it. |
| `record_video.py` | Deterministic capture to MP4 (virtual clock). Muxes SFX automatically. |
| `sfx.mjs` | Node.js, zero deps: 23 synthesized sounds, cue extraction, mixing, muxing. |
| `verify_video.py` | Audits bounds, JS errors, contract, icons/rig, kit sync, sound cues, MP4. |
| `tools/` | Optional local FFmpeg (e.g. a Windows build extracted here) if it is not on PATH. |

Requirements: Python 3.9+ with `pip install playwright && playwright install chromium`; Node 18+; FFmpeg (PATH or `tools/`).

**Paths:** the tools live in this skill's folder (`~/.claude/skills/motion/`). Run them by full path
(`node ~/.claude/skills/motion/kit.mjs new …`, `python ~/.claude/skills/motion/record_video.py …`) and keep
the videos in the user's project or working folder, never inside the skill folder.

---

## 1. Ask before building (one batch)

**First, look around.** If you are running inside the user's project (a repo, an app or a site folder),
do the brand discovery in section 2 *before* asking, so the questions can offer what you found
("I found your logo, 42 icons in `src/assets/icons`, and an indigo/amber palette in `tailwind.config.js`. Use them?").

1. **Scope:** full overview (problem → idea → features → how → CTA), one feature or flow, or before/after?
2. **Style:** *UI-driven* (app screens, cursor clicks, typing, toasts), *character-led* (host character reacts and points), *visual-first* (icons, diagrams, metrics, minimal text), or *typographic*.
3. **Character:** which host, if any?
   - **Built-in Blip** (pebble mascot; can be recoloured to the brand with `--shirt`/`--bulb`, given `data-top="sprout"` or glasses).
   - **Their own character**: an existing mascot or logo-character SVG from the project, or one they describe that you draw (section 2b).
   - **No character.**
4. **Look:** the project's own branding (if found), a built-in palette (`studio` `fintech` `cyber` `emerald` `mono` `neon`), or brand hex codes, logo and fonts they give you.
5. **Purpose:** showcase · social (hook in 3s) · pitch (problem → solution → impact → demo → ask) · tutorial · internal demo.
6. **Duration:** 15–20s (2–3 scenes) · 30–45s (4–6) · 60–90s (7–10) · or exact.
7. **Sound:** silent · SFX (clicks, typing, pops, whooshes, correct, impacts) · plus music file? VO markers?
8. **Format:** 16:9 · 9:16 · 1:1. **Mode:** pure motion (no controls) or presenter (controls).
9. **Deliverable:** HTML only, or HTML + MP4 (1080p60; 4K optional)?
10. **Content:** CTA line/URL, must-have stats/logos/copy, must-nots.

Use the AskUserQuestion tool when available (at most 4 questions per call; merge related ones, e.g. look + format, sound + deliverable).

> Quick defaults if the user says "just make it": 16:9, ~30s, UI-driven + Blip host, **the project's branding if found** (otherwise studio), SFX on, pure motion, HTML + 1080p60 MP4, visual inspection on.

---

## 2. Using the user's project (brand discovery)

When the skill runs inside someone's project, the video should look like **their** product, not like the kit.
Read the project first (only read it: never modify their source files), then map what you find:

| Look for | Where (typical) | Use it as |
| :--- | :--- | :--- |
| Name, tagline, pitch | `README*`, `package.json` (`name`, `description`), `<title>`/meta tags, landing page copy | headline, kicker, CTA wording |
| Logo / wordmark | `public/`, `static/`, `assets/`, `src/assets/`, `favicon.svg`, `logo*.svg|png` | intro and CTA scenes; corner brand bug |
| Icon set | `assets/icons/`, `src/icons/`, `components/icons/`, an icon package in `package.json` (lucide, heroicons, tabler, phosphor…) | `--icons <dir>` (or copy the SVGs they use into a folder first) |
| Colors | `tailwind.config.*` (`theme.extend.colors`), CSS variables in `globals.css`/`:root`, SCSS `$variables`, `theme.ts`, design tokens JSON, Figma exports | override the palette tokens (below) |
| Fonts | `@font-face`, Google Fonts links, `next/font`, the Tailwind `fontFamily` | `--sans` / `--display` / `--mono` |
| Real UI | page components, screenshots in `docs/`, the running app | recreate key screens with the kit widgets (browser/phone frames, inputs, toasts); same copy, same labels |
| Mascot / illustration | `assets/mascot*.svg`, `illustrations/`, brand docs | custom character (2b) |

**Colors → palette tokens.** Pick the closest built-in palette as the base (light → `studio`/`fintech`/`emerald`/`mono`, dark → `cyber`/`neon`),
then override in the video's own `<style>` (never inside `kit-css`):

```css
:root{ --accent:#6366F1; --accent-2:#F59E0B; --on-accent:#FFFFFF; --tint:#EEF2FF;
       --bg:#F8FAFC; --stage:#FFFFFF; --surface:#FFFFFF; --ink:#0F172A; --muted:#64748B; --line:#E2E8F0;
       --good:#16A34A; --bad:#DC2626; --sans:'Geist', system-ui, sans-serif; --display:var(--sans); }
```

Map the brand primary color → `--accent`, secondary → `--accent-2`, and the text, background and border colors to `--ink`, `--bg`/`--stage`/`--surface` and `--line`.
Check contrast (`--on-accent` on `--accent`, `--muted` on `--surface`). Add the brand font's `<link>` or `@font-face` in `<head>`.

**Icons.** Point the kit at their icon folder; every SVG there becomes `#i-<file-name>` (and overrides a built-in with the same name):

```bash
node kit.mjs new video/promo.html --palette fintech --icons src/assets/icons --character src/assets/mascot.svg
node kit.mjs icons --icons src/assets/icons        # list what's available
```

The folders are remembered in the video's `<html data-icon-dirs="…">`, so later `sync` runs reuse them. Stroke icons
keep their own stroke settings, and filled icons keep their fills (use `class="icon fill"` to tint a single-colour filled icon with `color:`).
Mixing sets looks cheap, so prefer the project's icons and fall back to built-ins only for what's missing.
If the project uses an npm icon package, copy just the needed SVGs from `node_modules/<pkg>` into a folder and point `--icons` at it.

**Logo.** Inline the logo SVG directly in the scene (or `<img src="data:…">` for PNG) so the video stays one file.
**Copy.** Use the product's real wording and feature names, and show its real flows. Avoid lorem ipsum and invented features.

### 2b. Their own character

- **Project has a mascot SVG:** `--character path/to/mascot.svg` (remembered as `data-character-src`). It is injected instead of Blip.
  To make poses and moods work, the SVG needs the rig's class names (`ch-all`, `ch-upper`, `ch-head`, `ch-eyes`/`ch-eye`, `ch-arm-l/r` > `ch-fore-l/r`,
  `ch-leg-l/r`, `ch-m-smile`/`ch-m-talk`/…, `ch-shadow`) at the pivots in `kit/character.svg` (shoulders 52,150 / 148,150 · elbows 38,172 / 162,172 · hips 84,212 / 116,212, in a 200×270 viewBox).
  Without those classes it still works as a static mascot: animate it with entrance, loop and attention classes (`.bi`, `.float`, `.tada`) on a wrapper.
- **User describes one:** draw it by copying `kit/character.svg` and keeping its structure, groups and class names, so every pose and mood keeps working.
  Change only the shapes and colours, save it in the project (e.g. `video/mascot.svg`), and pass `--character`.
- **Recolour Blip to the brand:** `<div data-character style="--shirt:var(--accent);--bulb:var(--accent-2)">`.

---

## 3. Workflow

```bash
node kit.mjs new my-video.html --palette studio --aspect 16:9   # skeleton + kit inlined
#   in a project, add: --icons <their icon dir> --character <their mascot.svg> (section 2)
#   ...write scenes (see section 4 and reference/ui-kit.md)...
node kit.mjs sync my-video.html                 # after EVERY edit: kit + used icons + character rig
python verify_video.py my-video.html --screenshots   # audit + PNG per scene -> Read each PNG
python record_video.py my-video.html            # -> my-video-1080p.mp4 (+ SFX)
python verify_video.py my-video.html            # also audits the MP4
node sfx.mjs cues my-video.html                 # cue sheet to deliver when sound/VO was requested
```

The kit lives between id'd blocks (`<style id="kit-css">`, `<svg id="kit-icons">`,
`<template id="kit-character">`, `<script id="kit-engine">`). **Never edit inside them**: `sync`
overwrites them. Video styles go in the second `<style>`. The engine script must stay last in `<body>`.

---

## 4. Building scenes

```html
<section class="scene" data-key="signup" data-dur="6" data-name="Sign up" data-in="left" data-out="fade">
  <div class="browser a" style="--d:.1s">
    <div class="bar-top"><i></i><i></i><i></i><span class="url">app.example.com</span></div>
    <div class="body">
      <div class="input" id="email" data-timeline="1.3 focus">
        <svg class="icon"><use href="#i-mail"/></svg>
        <span data-type="you@studio.dev" data-type-at="1.5" data-type-cps="12" data-sfx="typing">you@studio.dev</span>
      </div>
      <button class="btn" id="join">Join the beta</button>
    </div>
  </div>
  <div class="toast p" style="--d:4.2s" data-sfx="correct">…</div>
  <div class="cursor" data-path="0 @88/112, 1.2 #email click, 3.9 #join click" data-click-sfx="click"></div>
</section>
```

The vocabulary (full details in `reference/ui-kit.md`; visual catalog in `kit/gallery.html`):

| Need | Use |
| :--- | :--- |
| Element appears | class `.a .p .sl .sr .zm .f .bl .wp .si .bi .gx …` + `style="--d:.4s"` |
| Group appears in sequence | `data-stagger=".3 .1"` on the parent |
| Emphasis / loop | `.shake .tada .jello .beat` / `.float .pulse .spin .wiggle .ping` (on a wrapper) |
| Icon | `<svg class="icon draw" style="--d:.5s"><use href="#i-rocket"/></svg>`, `.icon-tile` |
| Arrow | `<svg class="arrow draw" viewBox=…><path data-arrow d="…"/></svg>`: head is automatic |
| Connector A → B | `<svg class="link draw [flow]" data-connect="#a #b" style="--d:1s"></svg>` |
| Character | `<div data-character data-timeline="0 happy, 1 excited wave talk, 3 point">` |
| Mouse cursor | `.cursor[data-path="TIME TARGET [click], …"]` |
| Typing text | `data-type="…" data-type-at data-type-cps` |
| State change | `data-timeline="1.5 on"` → `data-now` (toggle, check, input focus, character) |
| Numbers | `data-count=…` counters; `data-tween="--p 0 72 .5 1.2"` for bars, rings, dials, motion |
| Celebration | `.confetti[data-confetti="1.7"]` + `data-sfx="levelup"` |
| Scene transition | `data-in` / `data-out`: `fade up left right zoom blur wipe` |

### Motion design rules
- **One idea per scene**, 3–6s. Introduce, act, resolve: elements land by ~1s, the key action happens in the middle, and the scene holds ~0.8s before the cut.
- **Lead the eye**: one moving thing at a time. Stagger 0.08–0.15s; the cursor or an arrow points before something changes.
- **Cause → effect**: click (cursor) → press (`.pressed`) → result (toast/check) 0.2–0.4s later, with a sound on each beat.
- **Characters react**: change mood or pose on story beats (`surprised` at the problem, `excited wave` at the solution, `cheer` at the end). `talk` while a speech bubble is up.
- **UI realism**: real-looking copy (no lorem), consistent icon style, the focus ring when typing, a caret.
- **Least text**: headlines ≤ 6 words, labels 1–3 words; show the mechanism with icons, arrows and UI.

---

## 5. Layout & scaling

`.stage` has `aspect-ratio` and `container-type:inline-size`. Size **everything** in `cqw`
(1cqw = 1% of stage width) and clamp key text with `max(10px, 1.6cqw)`. Height budget: 56.25cqw
(16:9), 177.8cqw (9:16), 100cqw (1:1). Scene padding is 4cqw/5cqw; keep ~3cqw spare at the bottom.
Cursors, connectors and confetti must be **direct children of `.scene`** (they position against the stage).

---

## 6. Sound effects

Cue sounds on the element that makes them; `sfx.mjs` renders and mixes them sample-exactly at export.

```html
<h1 class="p" style="--d:.5s" data-sfx="pop">                          <!-- fires at --d -->
<span data-type="hello" data-type-at="1" data-sfx="typing">            <!-- at type-at, length = text/cps -->
<div class="cursor" data-path="…" data-click-sfx="click">              <!-- one click per click step -->
<section class="scene" data-sfx="whoosh, chime@0.4">                   <!-- several, @ = offset -->
<div data-sfx="boom" data-sfx-at="2" data-sfx-vol=".7" data-sfx-pitch="-3" data-sfx-pan=".4">
<div data-sfx="assets/sting.mp3">                                      <!-- your own file -->
```

Timing rule: `data-sfx-at` ?? `data-type-at` ?? element's own inline `--d` ?? 0. Delays from classes or
`data-stagger` are invisible to the exporter, so use `data-sfx-at` there. Absolute cues: `<script type="application/json" id="sfx-cues">[{"t":12.5,"sfx":"boom"}]</script>`.

Sounds: `click tick pop bubble toggle key typing correct wrong ding notify chime levelup coin whoosh swipe riser boom shutter glitch alert beep sparkle` (+ aliases; `node sfx.mjs list`, audition with `node sfx.mjs play NAME`).

**Rules:** about 1 cue per 1–2s; sound only the visible beats (landing, click, success, cut); quiet ticks
(`data-sfx-vol=".4"`) for repeated small items; save `boom` and `levelup` for one or two moments; `riser` ends on the hit.
Browser preview with sound: `node sfx.mjs lib my-video.html` (writes `./sfx/`), then click the page once.

---

## 7. Export & verification

`record_video.py` virtualizes rAF, `performance.now`, `Date.now`, `setTimeout` and `setInterval`, renders
frame *n* at exactly *n*/fps, drives all CSS animations to the same clock, pipes JPEG frames to
FFmpeg (H.264 CRF 18), and muxes the SFX track (AAC 192k).

```bash
python record_video.py v.html                 # 1080p60, aspect auto-detected -> v-1080p.mp4
python record_video.py v.html --width 3840    # 4K -> v-2160p.mp4
python record_video.py v.html --fps 30 --music bed.mp3 --music-vol .2
python record_video.py v.html --no-sfx
```

`verify_video.py` fails on: elements past the stage edge (at end-of-scene state; `data-bleed` opts out),
JS errors, bad scene contract (durations must be whole frames, so use multiples of 0.05s), SMIL,
missing viewBox, `<use>` icons that don't resolve, characters without the rig, invalid sound cues,
and an MP4 whose frame count, fps, audio or decode is wrong. It warns when the kit in the video is stale.

**Visual inspection** (before delivering any MP4): run `--screenshots` (90% into each scene) and
**Read** every PNG: clipped or crowded text, hierarchy, alignment, contrast, the character not
overlapping copy. For motion, pull frames: `ffmpeg -ss 4.5 -i v-1080p.mp4 -frames:v 1 f.png`.
Delete `*_audit/` folders afterwards.

---

## 8. Pitfalls

1. **Two animations on one element**: the later class wins. Nest wrappers (entrance outside, loop inside).
2. **Editing kit blocks**: `sync` overwrites them. Override tokens and classes in the video's own `<style>`.
3. **Overlays inside nested boxes**: `.cursor`, `svg.link` and `.confetti` must be direct children of `.scene`.
4. **`data-type` on a container**: its children get replaced. Put it on a leaf `<span>`.
5. **Vertical overflow**: 16:9 is only 56.25cqw tall; two-row layouts need ~15cqw rows.
6. **SVG rotation wobble**: `transform-box:fill-box; transform-origin:center` (built into `.spin` etc. inside SVG).
7. **No SMIL, no `new Date()` motion, no `<video>` timing**: none of them follow the recorder clock.
8. **Loop periods** must divide the scene duration (kit loops are 1/2/3s).
9. **Fonts**: Google Fonts need network at export; for offline, embed with `@font-face` base64.
10. **Windows consoles**: scripts print ASCII only; FFmpeg runs with `-loglevel error` to avoid pipe deadlocks.
