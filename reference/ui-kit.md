# Motion Kit Reference

Everything here comes from `kit/kit.css` + `kit/engine.js`, inlined into each video by
`node kit.mjs sync video.html`. Visual catalog: open `kit/gallery.html`.

**Timing model.** `--d` = start time in seconds from scene start (inline style). Engine features
take `data-*-at` times on the same clock. Everything is a pure function of scene time, so preview,
seek, screenshots and the frame-by-frame export always match.

---

## Scenes

```html
<section class="scene" data-key="signup" data-dur="6" data-name="Sign up"
         data-in="left" data-out="fade" style="--tr:.5s"> ... </section>
```

| Attribute | Values |
| :--- | :--- |
| `data-in` / `data-out` | `fade` `up` `left` `right` `zoom` `blur` `wipe`. Out ends exactly at the cut. |
| `--tr` | transition length (default .45s) |

Scenes are `display:flex; flex-direction:column; center`. Layout helpers: `.row`, `.col`, `.abs`, `.layer` (absolute full-stage overlay).

---

## Animation classes

**Entrances** (resting markup = end state):

| Class | Motion | Class | Motion |
| :--- | :--- | :--- | :--- |
| `.a` | rise | `.dn` | drop in |
| `.sl` / `.sr` | slide from left / right | `.p` | pop (overshoot) |
| `.zm` | zoom down from big | `.sp` | stamp |
| `.f` | fade | `.bl` | blur in |
| `.wp` / `.wu` | wipe reveal → / ↑ | `.fl` | flip up |
| `.si` | spin in | `.bi` | bounce in |
| `.gx` / `.gy` | grow width / height (bars) | `.mark` | highlighter swipe on text |

**Attention one-shots** at `--d`: `.shake` `.tada` `.jello` `.beat` `.flash`.
**Loops**: `.float` (3s) `.bob` (1s) `.pulse` (2s) `.spin` (2s) `.wiggle` (1s) `.glow` (2s) `.blink` (1s) `.ping` (ring, 1s).

> One `animation` per element. To combine an entrance and a loop or attention effect, **nest**:
> `<div class="p" style="--d:.4s"><div class="float">…</div></div>`.

**Stagger** children automatically: `<div data-stagger=".3 .1">` gives child *i* `--d = .3 + i·.1`.
(Sound cues on staggered children need an explicit `data-sfx-at`.)

---

## Icons (85)

```html
<svg class="icon"><use href="#i-rocket"/></svg>                          <!-- inherits color -->
<svg class="icon draw" style="--d:.5s;--dd:.6s;--s:6cqw"><use href="#i-check"/></svg>   <!-- draws on -->
<span class="icon-tile"><svg class="icon"><use href="#i-bolt"/></svg></span>     <!-- tinted tile -->
<span class="icon-tile solid round" style="--t:6cqw">…</span>            <!-- variants: solid, round, good, bad -->
```

`--s` icon size, `--t` tile size, `--dd` draw duration. List: `node kit.mjs icons`.
**Project icons:** `node kit.mjs sync video.html --icons path/to/icons` turns every `*.svg` there into `#i-<file-name>` (overriding a built-in of the same name; remembered in `<html data-icon-dirs>`). Filled icons keep their fills.
Unknown names are reported by `sync` and `verify_video.py`.

Names: check x plus minus search refresh download upload send share link filter play pause
thumbs-up arrow-right/left/up/down arrow-up-right chevron-right chevron-down trending-up cursor
user users smile heart star chat mail bell phone mic video music lock unlock shield shield-check
key eye alert info chart-bar chart-line pie target clock calendar grid layers cart card wallet
dollar coin gift tag trophy flag bookmark code terminal database server cloud cpu robot settings
sliders wifi battery bolt file folder image home globe pin rocket bulb sparkle sun moon.

---

## Arrows & connectors

```html
<!-- Free arrow: any path; the engine adds the head at the end, oriented to the curve -->
<svg class="arrow draw" viewBox="0 0 300 120" style="--d:.6s;--dd:.7s;width:24cqw">
  <path data-arrow="14" d="M10 100 C 80 10, 220 10, 290 70"/>
</svg>
<!-- variants: add class "dashed"; data-arrow = head size in viewBox units -->

<!-- Connector between two elements: DIRECT CHILD of the .scene, no viewBox needed -->
<svg class="link draw" data-connect="#from #to" style="--d:1s;--dd:.5s"></svg>
<svg class="link draw flow" data-connect="#a #b" data-bend=".3" data-head="none"></svg>
```

Connectors anchor to the nearest sides (horizontal or vertical), curve by `data-bend` (0–1), and re-layout on resize.
`flow` = marching dashes (data moving). Line color = `stroke` (default `--accent`).

---

## Cursor (UI demos)

```html
<div class="cursor" data-path="0 @88/112, 1.2 #email click, 3.9 #join click, 5 @50/50"
     data-move=".7" data-click-sfx="click"></div>
```

- Steps: `TIME TARGET [click]`. TARGET is a CSS selector (center of the element) or `@x/y` (% of stage; >100 = off-stage).
- The cursor arrives **at** TIME, travelling for `data-move` seconds on a slight arc with ease-in-out.
- `click`: press-squash, ripple, and `.pressed` on the target for 0.2s (buttons dip). `data-click-sfx` adds a sound per click to the export.
- Place it as a **direct child of the scene** (absolute to the stage). Size: `style="--s:3cqw"`.

---

## Typing

```html
<span data-type="you@studio.dev" data-type-at="1.5" data-type-cps="12" data-sfx="typing">you@studio.dev</span>
```

Reveals characters at `cps`. Shows a caret while typing (`.typing`); add class `caret` for a permanent blinking caret.
With `data-sfx="typing"`, the sound starts at `data-type-at` and lasts exactly `length / cps`.
Must be a leaf element (its text is replaced).

---

## State over time: `data-timeline`

Sets `data-now` on the element at given times. CSS reacts to it (character poses and moods, `.toggle`, `.check`, `.input focus`, or your own `[data-now~="x"]` rules).

```html
<div data-character data-now="happy" data-timeline="0 happy, .7 excited wave talk, 2.2 happy point"></div>
<span class="toggle" data-timeline="1.5 on"></span>
<span class="check" data-timeline="2 on"><svg class="icon"><use href="#i-check"/></svg></span>
<div class="input" data-timeline="1.3 focus, 3.6">…</div>          <!-- empty = back to base -->
```

---

## Numbers: counters & tweens

```html
<b data-count="1200" data-count-from="0" data-count-at=".6" data-count-dur="1.2"
   data-count-dec="0" data-count-prefix="$" data-count-suffix="+" data-count-ease="out">$1200+</b>

<!-- tween any CSS variable: name from to at dur [ease]; several separated by ; -->
<div class="bar" data-tween="--p 0 72 .5 1.2 out"><i></i></div>
<div style="transform:translateX(calc(var(--x) * 1cqw))" data-tween="--x -30 0 0 1 back"></div>
<svg class="ring" viewBox="0 0 120 120" data-tween="--p 0 100 .3 1.4 inout">
  <circle class="track" cx="60" cy="60" r="50"/><circle class="val" cx="60" cy="60" r="50" pathLength="1"/></svg>
```

Eases: `linear in out inout back spring`. Segments on the same variable chain: `--x 0 50 0 1; --x 50 20 2 .5`.
Dial needle: `transform:rotate(calc(var(--a) * 1deg))` with `data-tween="--a -90 60 .5 1 spring"`.

---

## Character: "Blip" (pebble mascot)

Own character instead: `node kit.mjs sync video.html --character path/to/mascot.svg` (see SKILL.md 2b for the class contract).

A soft pebble-shaped creature with dot eyes, an antenna, noodle arms and stubby legs.

```html
<div data-character data-now="happy wave" style="--size:16cqw; --shirt:#3D6A8C; --bulb:#FF8F8F"
     data-top="sprout" data-acc="glasses"></div>
```

| Kind | Tokens for `data-now` |
| :--- | :--- |
| Moods | `happy` (default) `excited` `laugh` (^ ^ eyes) `neutral` `sad` `surprised` `angry` `wink` `talk` |
| Arm poses (one at a time; arms bend at the elbow) | `wave` `point` `point-left` `point-up` `present` `cheer` `shrug` `think` `type` `clap` |
| Body | `nod` `no` `jump` `bounce` `walk` |
| Eyes | `look-left` `look-right` `look-up` `look-down` |

Options: `data-top="antenna|sprout|none"` (default antenna), `data-acc="glasses"`, class `flip` (face left).
Colors: `--shirt` (body, default `--accent`) `--belly --limb --foot --bulb --leaf --cheek --ch-line --ch-ink`. Always on: a squishy breath, blinking, face sway and antenna wobble; the shadow shrinks on `jump`/`cheer`/`bounce`.
Custom poses: set `--rot` (upper arm) and `--fr` (forearm) on `.ch-arm-r/.ch-fore-r` with `animation:ch-pose var(--pose)` / `ch-fpose`. On dark palettes, consider `--ch-line:#000`.
Speech bubble: `<div class="say">Hi!</div>` (`.say.right` puts the tail on the right).
Walk across the stage: wrap it in `<div style="transform:translateX(calc(var(--x)*1cqw))" data-tween="--x -40 0 0 2 inout">` and set `data-now="walk"` (then switch to `happy` with the timeline when it stops).

---

## UI widgets

| Class | Notes |
| :--- | :--- |
| `.card` `.pill(.good/.bad)` `.stamp` `.kbd` `.divider` `.skeleton` | basics |
| `.btn` `.btn.ghost` | gets `.pressed` from cursor clicks |
| `.input` (+ `.ph` placeholder span) | `data-now~=focus` or `.focus` → focus ring |
| `.toggle` `.check` | `data-now~=on` animates the switch |
| `.avatar` (`--a` size) `.badge-dot` | badge-dot inside a `position:relative` parent |
| `.toast` | icon-tile + `<b>` title + `<small>` |
| `.chat` > `.bubble.them` / `.bubble.me`, `.dots` (typing indicator) | message threads |
| `.bar > i` (`--p` 0–100), `.ring` (`--p`) | progress |
| `.phone > .screen` (`--w`) | mobile frame with notch |
| `.browser > .bar-top(i,i,i,.url) + .body` (`--w`) | desktop window |
| `.terminal` (`.ok .dim .hl` spans) | console |

---

## Confetti

```html
<div class="confetti" data-confetti="1.7" data-pieces="70" data-origin="50/65"
     data-colors="var(--accent) #FFD166 #06D6A0" data-sfx="levelup" data-sfx-at="1.7"></div>
```

Seeded and deterministic. Bursts upward from `origin` (% of stage), with drag and gravity, and fades at about 2s. Direct child of the scene.

---

## Palettes

`<html data-palette="studio|fintech|cyber|emerald|mono|neon">`. Tokens: `--bg --surface --stage --ink --muted --line --accent --accent-2 --on-accent --tint --good --good-bg --bad --bad-bg --warn`, fonts `--sans --serif --mono --display`. Override any token in the video's own `<style>` (brand colors).
