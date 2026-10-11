# HTML Motion Video Engine

Animated product demos, UI walkthroughs, explainers and social reels as one self-contained
HTML file, exported to a frame-perfect MP4 with synced sound effects.

**Motion kit:** 85 draw-on icons · a rigged pebble mascot "Blip" (wave, point, cheer, clap, think, walk, talk, 9 moods) ·
auto-headed arrows and element-to-element connectors · a scripted mouse cursor that clicks ·
typing text · UI widgets (browser, phone, terminal, toasts, chat, inputs, toggles, progress
rings) · counters and tweens · confetti · scene transitions · 23 synthesized sound effects.

## Install

```bash
git clone https://github.com/devtint/motion ~/.claude/skills/motion
```

Then ask Claude Code for a video (e.g. "make a 20s product demo video for my app"); the `motion` skill triggers automatically.

FFmpeg must be on your PATH (macOS: `brew install ffmpeg`, Linux: `sudo apt install ffmpeg`), or on Windows
extract a build from https://github.com/BtbN/FFmpeg-Builds/releases into the skill's `tools/` folder.

## Usage

```bash
pip install playwright && playwright install chromium        # once (plus Node 18+)

node kit.mjs new my-video.html --palette studio --aspect 16:9
node kit.mjs sync my-video.html                              # after each edit
python verify_video.py my-video.html --screenshots
python record_video.py my-video.html                         # -> my-video-1080p.mp4 with sound
```

Inside your own project, it picks up your branding:

```bash
node kit.mjs new video/promo.html --icons src/assets/icons --character src/assets/mascot.svg
```

- `SKILL.md`: workflow, design rules, sound and export
- `reference/ui-kit.md`: every class and attribute
- `kit/gallery.html`: visual catalog of icons, poses and moods
- `template.html`: showcase video using every feature

Example:

```html
<div data-character data-timeline="0 happy, 1 excited wave talk, 3 point"></div>
<span data-type="you@studio.dev" data-type-at="1.5" data-sfx="typing"></span>
<div class="cursor" data-path="0 @90/110, 1.2 #email click, 3.9 #join click" data-click-sfx="click"></div>
<svg class="link draw flow" data-connect="#api #db" style="--d:1s"></svg>
```

MIT License. See `LICENSE`.
