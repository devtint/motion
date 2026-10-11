#!/usr/bin/env python3
"""
record_video.py - Deterministic frame-by-frame video capture

Records a scene-based HTML motion video (see SKILL.md) to a frame-perfect MP4.
Time is fully virtual, so the output length equals the sum of data-dur exactly,
regardless of machine speed or CPU load.

How it works:
  1. add_init_script() installs a virtual clock BEFORE page scripts run:
     requestAnimationFrame, cancelAnimationFrame, performance.now, Date.now,
     setTimeout and setInterval all run on virtual time.
  2. Each frame we set virtual time to exactly frame/fps, fire due timers and
     rAF callbacks, then drive every CSS / Web Animation to the same clock.
     Animations seen for the first time start at 0 - including the ones that
     began in real time during page load - so frame 0 is truly t = 0.
  3. The viewport is the stage; each frame is screenshotted (JPEG q95 by
     default) and piped straight into ffmpeg stdin. No temp files.
  4. If the HTML declares sound cues (data-sfx / #sfx-cues), sfx.mjs renders
     a sample-exact audio track and muxes it into the MP4.

Requirements:
    pip install playwright && playwright install chromium
    ffmpeg on PATH or in ./tools/   (Node >= 18 for --sfx)

Usage:
    python record_video.py video.html                      # 1080p60, auto aspect
    python record_video.py video.html --width 3840         # 4K
    python record_video.py video.html --fps 30 -o out.mp4
    python record_video.py video.html --aspect 9:16 --width 1080
    python record_video.py video.html --no-sfx             # silent even if cues exist
    python record_video.py video.html --music bed.mp3      # SFX + background music
"""

import argparse
import asyncio
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------------------
# Virtual clock - injected BEFORE page scripts via add_init_script().
# ---------------------------------------------------------------------------
VIRTUAL_CLOCK_SCRIPT = r"""
(() => {
    let now = 0;                        // virtual ms since recording start
    const epoch = Date.now();
    let rafQueue = new Map(), rafId = 1;
    const timers = new Map(); let timerId = 1;
    const driven = new WeakSet();       // animations already under our control

    window.requestAnimationFrame = (cb) => { const id = rafId++; rafQueue.set(id, cb); return id; };
    window.cancelAnimationFrame = (id) => { rafQueue.delete(id); };
    performance.now = () => now;
    Date.now = () => epoch + now;

    const addTimer = (cb, ms, every, args) => {
        const id = timerId++;
        if (typeof cb === 'function') timers.set(id, { at: now + Math.max(0, +ms || 0), cb, every, args });
        return id;
    };
    window.setTimeout = (cb, ms, ...args) => addTimer(cb, ms, 0, args);
    window.setInterval = (cb, ms, ...args) => addTimer(cb, ms, Math.max(1, +ms || 0), args);
    window.clearTimeout = window.clearInterval = (id) => { timers.delete(id); };

    function runTimers() {
        for (let guard = 0; guard < 10000; guard++) {
            let next = null;
            for (const [id, tm] of timers) if (tm.at <= now && (!next || tm.at < next[1].at)) next = [id, tm];
            if (!next) return;
            const [id, tm] = next;
            if (tm.every) tm.at += tm.every; else timers.delete(id);
            try { tm.cb(...tm.args); } catch (e) { console.error('timer error:', e); }
        }
    }

    // Advance to an absolute virtual time (ms). Absolute, not delta, so there is
    // no floating-point accumulation over thousands of frames.
    window.__advanceTo = (targetMs) => {
        const delta = Math.max(0, targetMs - now);
        now = targetMs;
        runTimers();
        const due = rafQueue; rafQueue = new Map();   // callbacks queued now fire next frame
        for (const cb of due.values()) {
            try { cb(now); } catch (e) { console.error('rAF error:', e); }
        }
        // getAnimations() flushes styles, so animations created by the callbacks above are included.
        for (const a of document.getAnimations()) {
            if (a.playState === 'idle') continue;
            if (!driven.has(a)) {
                driven.add(a);
                a.pause();
                a.currentTime = 0;      // starts now, whatever real time elapsed during load
            } else {
                if (a.playState === 'running') a.pause();
                a.currentTime = (a.currentTime || 0) + delta;
            }
        }
    };

    window.__getTotalDuration = () => {
        if (window.__motion && window.__motion.total) return window.__motion.total;
        let total = 0;
        document.querySelectorAll('.scene[data-dur]').forEach(s => total += parseFloat(s.dataset.dur) || 0);
        return total;
    };
})();
"""

# Strip page chrome so the viewport IS the stage.
INJECT_CSS = """
html,body{margin:0!important;padding:0!important;background:#000!important;overflow:hidden!important}
.player{max-width:none!important;margin:0!important;padding:0!important}
#stage,.stage{width:100vw!important;height:100vh!important;max-width:none!important;border:0!important;border-radius:0!important;box-shadow:none!important;margin:0!important}
.ctl,#ctl{display:none!important}
"""

# Natural width / height of the stage before INJECT_CSS stretches it.
STAGE_RATIO_JS = """() => {
    const s = document.getElementById('stage') || document.querySelector('.stage');
    if (!s) return null;
    const r = s.getBoundingClientRect();
    return r.height ? r.width / r.height : null;
}"""


def find_tool(name: str) -> str:
    """Find an executable on PATH, in ./tools/, or in the installed skill's tools/."""
    path = shutil.which(name)
    if path:
        return path
    for d in (os.path.join(HERE, "tools"),
              os.path.expanduser("~/.claude/skills/motion/tools")):
        for root, _dirs, files in os.walk(d):
            for f in files:
                if f.lower() in (name, f"{name}.exe"):
                    return os.path.join(root, f)
    return ""


def parse_aspect(value: str):
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*[:/x]\s*(\d+(?:\.\d+)?)\s*", value or "")
    return float(m.group(1)) / float(m.group(2)) if m else None


def even(n: float) -> int:
    return max(2, int(round(n / 2)) * 2)


def default_output(html_path: str, width: int, height: int) -> str:
    """video.html -> video-1080p.mp4 (named by the short side, like YouTube)."""
    base = os.path.splitext(os.path.abspath(html_path))[0]
    return f"{base}-{min(width, height)}p.mp4"


def stage_aspect_hint(html: str) -> float:
    """Aspect from the LAST `.stage{aspect-ratio:W/H}` rule (the video's override beats kit.css)."""
    found = re.findall(r"\.stage\s*\{[^}]*aspect-ratio\s*:\s*([\d.]+)\s*/\s*([\d.]+)", html)
    return float(found[-1][0]) / float(found[-1][1]) if found else 16 / 9


def has_sfx_cues(html: str) -> bool:
    return bool(re.search(r'\bdata-(?:click-)?sfx\s*=|id\s*=\s*["\']sfx-cues["\']', html))


async def open_stage(p, html_path: str, width: int, aspect, virtual_clock: bool):
    """Launch Chromium, load the page, size the viewport to the stage aspect. Returns (browser, page, w, h)."""
    browser = await p.chromium.launch(headless=True, args=[
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding",
        "--autoplay-policy=no-user-gesture-required",
    ])
    context = await browser.new_context(viewport={"width": width, "height": even(width * 9 / 16)},
                                        color_scheme="light", reduced_motion="no-preference")
    if virtual_clock:
        await context.add_init_script(VIRTUAL_CLOCK_SCRIPT)
    page = await context.new_page()
    page.on("pageerror", lambda e: print(f"  [WARN] page error: {e}"))
    await page.goto("file:///" + os.path.abspath(html_path).replace("\\", "/").lstrip("/"))
    await page.evaluate("document.fonts.ready.then(() => true)")

    ratio = aspect or await page.evaluate(STAGE_RATIO_JS) or 16 / 9
    height = even(width / ratio)
    await page.set_viewport_size({"width": width, "height": height})
    await page.add_style_tag(content=INJECT_CSS)
    await page.evaluate("document.fonts.ready.then(() => true)")
    return browser, page, width, height


async def record(html_path: str, width: int, fps: int, output_path: str, aspect=None,
                 use_jpeg: bool = True) -> bool:
    from playwright.async_api import async_playwright

    ffmpeg_path = find_tool("ffmpeg")
    if not ffmpeg_path:
        raise SystemExit("ffmpeg not found on PATH or in ./tools/. "
                         "Windows: https://github.com/BtbN/FFmpeg-Builds/releases | "
                         "macOS: brew install ffmpeg | Linux: sudo apt install ffmpeg")

    t_start = time.time()
    async with async_playwright() as p:
        browser, page, width, height = await open_stage(p, html_path, width, aspect, virtual_clock=True)

        total_seconds = await page.evaluate("window.__getTotalDuration()")
        if not total_seconds:
            raise SystemExit("Could not detect duration: no .scene[data-dur] elements found.")
        total_frames = round(total_seconds * fps)
        if abs(total_frames - total_seconds * fps) > 1e-6:
            print(f"  [WARN] {total_seconds}s is not a whole number of frames at {fps}fps; rounding to {total_frames}.")

        print(f"Recording : {html_path}")
        print(f"  Duration  : {total_seconds:g}s ({total_frames} frames @ {fps}fps)")
        print(f"  Resolution: {width}x{height}")
        print(f"  Format    : {'JPEG q95' if use_jpeg else 'PNG'} -> H.264 MP4")
        print(f"  Output    : {output_path}\n")

        ffmpeg = subprocess.Popen(
            [ffmpeg_path, "-y", "-loglevel", "error",
             "-f", "image2pipe", "-vcodec", "mjpeg" if use_jpeg else "png", "-framerate", str(fps), "-i", "-",
             "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-pix_fmt", "yuv420p",
             "-r", str(fps), "-movflags", "+faststart", output_path],
            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)

        shot = {"type": "jpeg", "quality": 95} if use_jpeg else {"type": "png"}
        await page.evaluate("window.__advanceTo(0)")      # first rAF at t = 0; resets load-time animations
        last_pct = -1
        for frame in range(total_frames):
            data = await page.screenshot(**shot)
            try:
                ffmpeg.stdin.write(data)
            except OSError:                               # BrokenPipe / EINVAL on Windows
                err = ffmpeg.stderr.read().decode(errors="replace") if ffmpeg.stderr else ""
                raise SystemExit(f"ffmpeg pipe broke. stderr:\n{err}")
            await page.evaluate("ms => window.__advanceTo(ms)", (frame + 1) * 1000.0 / fps)

            pct = (frame + 1) * 100 // total_frames
            if pct != last_pct:
                last_pct = pct
                bar = "#" * (pct // 2) + "-" * (50 - pct // 2)
                sys.stdout.write(f"\r  [{bar}] {pct:3d}%  frame {frame + 1}/{total_frames}  "
                                 f"elapsed {time.time() - t_start:.0f}s")
                sys.stdout.flush()
        print()
        await browser.close()

    ffmpeg.stdin.close()
    _, err = ffmpeg.communicate()
    if ffmpeg.returncode != 0:
        print(f"  [FAIL] ffmpeg exited with {ffmpeg.returncode}\n{err.decode('utf-8', errors='replace')}")
        return False

    elapsed = time.time() - t_start
    print(f"  [OK] Done in {elapsed:.1f}s ({total_frames / elapsed:.1f} frames/sec)")
    print(f"  [OK] Output: {output_path} ({os.path.getsize(output_path) / 1048576:.1f} MB)")
    return True


def mux_sfx(html_path: str, mp4_path: str, music: str = None, music_vol: str = None) -> bool:
    node = shutil.which("node")
    if not node:
        print("  [WARN] Node.js not found; skipping sound effects. Install Node >= 18 or pass --no-sfx.")
        return False
    cmd = [node, os.path.join(HERE, "sfx.mjs"), "mux", html_path, mp4_path, "-o", mp4_path]
    if music:
        cmd += ["--music", music]
    if music_vol:
        cmd += ["--music-vol", str(music_vol)]
    return subprocess.run(cmd).returncode == 0


def main():
    ap = argparse.ArgumentParser(
        description="Deterministic frame-by-frame capture of scene-based HTML motion videos.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Examples:\n"
               "  python record_video.py pitch.html\n"
               "  python record_video.py pitch.html --width 3840\n"
               "  python record_video.py reel.html --aspect 9:16 --width 1080 --fps 30")
    ap.add_argument("html", help="Path to the HTML video file")
    ap.add_argument("--width", type=int, default=None,
                    help="Output width in px (default: 1920 landscape, 1080 portrait/square)")
    ap.add_argument("--fps", type=int, default=60, help="Frames per second (default: 60)")
    ap.add_argument("--aspect", help="Force aspect ratio, e.g. 16:9, 9:16, 1:1 (default: read from the stage)")
    ap.add_argument("--output", "-o", help="Output MP4 (default: <input>-<short side>p.mp4)")
    ap.add_argument("--png", action="store_true", help="Lossless PNG frames (slower)")
    ap.add_argument("--no-sfx", action="store_true", help="Do not add the SFX audio track")
    ap.add_argument("--music", help="Background music file mixed under the SFX")
    ap.add_argument("--music-vol", help="Background music volume (default 0.25)")
    args = ap.parse_args()

    if not os.path.isfile(args.html):
        raise SystemExit(f"File not found: {args.html}")
    aspect = parse_aspect(args.aspect) if args.aspect else None
    if args.aspect and not aspect:
        raise SystemExit(f"Bad --aspect '{args.aspect}'. Use W:H, e.g. 9:16")

    html = open(args.html, encoding="utf-8").read()
    aspect_hint = aspect or stage_aspect_hint(html)
    width = args.width or (1920 if aspect_hint > 1 else 1080)
    height = even(width / aspect_hint)
    output = args.output or default_output(args.html, width, height)

    ok = asyncio.run(record(args.html, width, args.fps, output, aspect, use_jpeg=not args.png))
    if not ok:
        sys.exit(1)

    if not args.no_sfx and (has_sfx_cues(html) or args.music):
        print("\nAdding sound effects...", flush=True)
        if not mux_sfx(args.html, output, args.music, args.music_vol):
            sys.exit(1)


if __name__ == "__main__":
    main()
