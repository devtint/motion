#!/usr/bin/env python3
"""
verify_video.py - Layout, runtime, sound-cue and MP4 integrity auditor.

Usage:
    python verify_video.py video.html
    python verify_video.py video.html --screenshots            # PNG per scene -> video_audit/
    python verify_video.py video.html --mp4 video-1080p.mp4

Checks:
  1. BOUNDARY GUARD   every element of every scene stays inside the stage
                      (all four edges), measured at the export resolution.
  2. RUNTIME          uncaught exceptions and console errors.
  3. SCENE CONTRACT   data-key / data-name / data-dur present, keys unique,
                      durations a whole number of frames.
  4. SVG / MOTION     no SMIL (<animate*>), every bare <svg> has a viewBox.
  5. SOUND CUES       every data-sfx / #sfx-cues name exists and lands inside
                      the video (via sfx.mjs; needs Node).
  6. MP4 (if found)   duration == sum(data-dur), frame rate, frame count,
                      audio stream present when cues exist, clean full decode.
"""

import argparse
import asyncio
import json
import os
import re
import shutil
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from record_video import (HERE, default_output, even, find_tool, has_sfx_cues, stage_aspect_hint,  # noqa: E402
                          open_stage, parse_aspect)

AUDIT_JS = """() => {
    const stage = document.getElementById('stage') || document.querySelector('.stage');
    const sRect = stage.getBoundingClientRect();
    const scenes = [...document.querySelectorAll('.scene')];
    const label = el => el.id ? '#' + el.id : (el.classList[0] ? '.' + el.classList[0] : el.tagName.toLowerCase());
    const out = [];

    scenes.forEach((sc, idx) => {
        const M = window.__motion;
        if (M && M.seek) { M.pause(); M.seek(M.starts[idx] + M.durs[idx] * 0.9); }   // engine-driven state (typing, tweens, timelines)
        else scenes.forEach(s => s.classList.toggle('active', s === sc));
        sc.getAnimations().forEach(a => a.cancel());   // scene in/out transitions are not layout
        // Measure the resting (end) state: finish every finite animation.
        for (const a of sc.getAnimations({subtree: true})) {
            try { a.finish(); } catch (e) { a.pause(); a.currentTime = 0; }   // infinite loops
        }
        const violations = [];
        for (const el of sc.querySelectorAll('*')) {
            if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
            if (el.closest('[data-bleed], .cursor, .confetti, svg[data-connect]')) continue;  // intentional / engine overlays
            const cs = getComputedStyle(el);
            if (cs.display === 'none' || cs.visibility === 'hidden' || cs.position === 'fixed') continue;
            const r = el.getBoundingClientRect();
            if (!r.width && !r.height) continue;
            const over = {
                top: sRect.top - r.top, left: sRect.left - r.left,
                bottom: r.bottom - sRect.bottom, right: r.right - sRect.right,
            };
            for (const [dir, px] of Object.entries(over)) {
                if (px > 1.5) violations.push({ element: label(el), direction: dir, pixels: px });
            }
        }
        // Report only outermost offenders: a child of an overflowing parent is noise.
        const seen = new Set();
        const trimmed = violations.filter(v => { const k = v.direction + v.element; if (seen.has(k)) return false; seen.add(k); return true; });

        const svgIssues = [];
        const smil = sc.querySelectorAll('animate, animateTransform, animateMotion, set');
        if (smil.length) svgIssues.push(`${smil.length} SMIL animation element(s): SMIL ignores the recorder's virtual clock. Use CSS @keyframes.`);
        sc.querySelectorAll('svg').forEach((svg, i) => {
            if (svg.parentElement.closest('svg')) return;
            if (!svg.getAttribute('viewBox') && !svg.querySelector(':scope > use') && !svg.hasAttribute('data-connect'))
                svgIssues.push(`<svg> #${i} has no viewBox (will not scale with the stage).`);
        });
        sc.querySelectorAll('use').forEach(u => {
            const ref = u.getAttribute('href') || u.getAttribute('xlink:href') || '';
            if (ref.startsWith('#') && !document.getElementById(ref.slice(1)))
                svgIssues.push(`<use href="${ref}"> points at nothing (unknown icon, or run: node kit.mjs sync <file>).`);
        });
        sc.querySelectorAll('[data-character]').forEach(c => {
            if (!c.querySelector('svg.ch')) svgIssues.push('[data-character] has no rig (run: node kit.mjs sync <file>).');
        });

        out.push({
            index: idx,
            key: sc.getAttribute('data-key'),
            name: sc.getAttribute('data-name'),
            dur: parseFloat(sc.getAttribute('data-dur')),
            violations: trimmed,
            svg_issues: svgIssues,
        });
    });
    return { stage: { width: sRect.width, height: sRect.height }, scenes: out };
}"""

# Put scene i at a moment where entrances have landed: prefer the engine's seek API.
SHOW_SCENE_JS = """([i, t]) => {
    if (window.__motion && window.__motion.seek) {
        window.__motion.pause(); window.__motion.seek(t);
        document.querySelectorAll('.scene').forEach(s => s.getAnimations().forEach(a => a.cancel()));  // no mid-transition shots
        return;
    }
    const scenes = [...document.querySelectorAll('.scene')];
    scenes.forEach((s, k) => s.classList.toggle('active', k === i));
    for (const a of scenes[i].getAnimations({subtree: true})) { try { a.finish(); } catch (e) { a.pause(); } }
}"""


async def audit_html(html_path: str, width: int, aspect, shots_dir: str = None) -> dict:
    from playwright.async_api import async_playwright

    errors, warnings = [], []
    async with async_playwright() as p:
        # Pause autoplay so measurements are not racing the scene clock.
        browser, page, w, h = await open_stage(p, html_path, width, aspect, virtual_clock=False)
        page.on("pageerror", lambda e: errors.append(f"PageError: {e}"))
        page.on("console", lambda m: errors.append(f"console.error: {m.text}") if m.type == "error"
                else warnings.append(f"console.warn: {m.text}") if m.type == "warning" else None)
        # Let the engine run a few real frames so runtime errors in tick() surface.
        await page.wait_for_timeout(600)
        await page.evaluate("window.__motion && window.__motion.pause && window.__motion.pause()")
        res = await page.evaluate(AUDIT_JS)

        if shots_dir:
            os.makedirs(shots_dir, exist_ok=True)
            t0 = 0.0
            for s in res["scenes"]:
                dur = s["dur"] or 0
                # 90% into the scene: entrances landed, before the cut.
                await page.evaluate(SHOW_SCENE_JS, [s["index"], t0 + dur * 0.9])
                await page.wait_for_timeout(120)
                path = os.path.join(shots_dir, f"{s['index']:02d}_{s['key'] or 'scene'}.png")
                await page.screenshot(path=path)
                print(f"  [SAVED] {path}")
                t0 += dur
        await browser.close()

    res.update(errors=errors, warnings=warnings, viewport=[w, h])
    return res


def check_contract(scenes, fps):
    issues, keys = [], set()
    for s in scenes:
        tag = f"Scene {s['index']}"
        if not s["key"]:
            issues.append(f"{tag}: missing data-key")
        elif s["key"] in keys:
            issues.append(f"{tag}: duplicate data-key '{s['key']}'")
        keys.add(s["key"])
        if not s["name"]:
            issues.append(f"{tag} ({s['key']}): missing data-name")
        if not s["dur"] or s["dur"] <= 0:
            issues.append(f"{tag} ({s['key']}): data-dur missing or not > 0")
        elif abs(s["dur"] * fps - round(s["dur"] * fps)) > 1e-6:
            issues.append(f"{tag} ({s['key']}): data-dur={s['dur']} is not a whole number of frames at {fps}fps")
    return issues


def audit_sfx(html_path: str):
    """Returns (cue_count, issues) using sfx.mjs as the single source of truth."""
    node = shutil.which("node")
    if not node:
        return None, ["Node.js not found; cannot validate sound cues"]
    res = subprocess.run([node, os.path.join(HERE, "sfx.mjs"), "cues", html_path, "--json"],
                         capture_output=True, text=True, encoding="utf-8")
    try:
        data = json.loads(res.stdout)
    except ValueError:
        return None, [f"sfx.mjs failed: {res.stderr.strip() or res.stdout.strip()}"]
    return len(data["cues"]), data["warnings"]


def probe(ffprobe, mp4, *entries):
    res = subprocess.run([ffprobe, "-v", "error", *entries, "-of", "json", mp4], capture_output=True, text=True)
    return json.loads(res.stdout or "{}")


def audit_mp4(mp4_path: str, expected: float, fps: int, expect_audio: bool) -> list:
    issues = []
    ffprobe, ffmpeg = find_tool("ffprobe"), find_tool("ffmpeg")
    if not ffprobe or not ffmpeg:
        return ["ffprobe/ffmpeg not found on PATH or in ./tools/"]

    info = probe(ffprobe, mp4_path, "-show_entries", "format=duration:stream=codec_type,r_frame_rate,nb_frames")
    streams = info.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not video:
        return ["No video stream"]

    num, den = (video.get("r_frame_rate") or "0/1").split("/")
    rate = float(num) / float(den or 1)
    if abs(rate - fps) > 0.01:
        issues.append(f"Frame rate {rate:g}fps, expected {fps}fps")
    frames = int(video.get("nb_frames") or 0)
    if frames and frames != round(expected * fps):
        issues.append(f"Frame count {frames}, expected {round(expected * fps)} ({expected:g}s x {fps}fps)")
    vdur = frames / rate if frames and rate else float(info.get("format", {}).get("duration", 0))
    if abs(vdur - expected) > 1.0 / fps + 1e-3:
        issues.append(f"Duration {vdur:.3f}s, expected {expected:.3f}s (drift {vdur - expected:+.3f}s)")
    if expect_audio and not audio:
        issues.append("HTML has sound cues but the MP4 has no audio stream (re-run record_video.py without --no-sfx)")

    res = subprocess.run([ffmpeg, "-v", "error", "-i", mp4_path, "-f", "null", "-"], capture_output=True, text=True)
    if res.returncode != 0 or res.stderr.strip():
        issues.append(f"Decode errors: {res.stderr.strip()[:500]}")
    return issues


def main():
    ap = argparse.ArgumentParser(description="Audit HTML motion videos and their exported MP4s.",
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog="Examples:\n"
                                        "  python verify_video.py pitch.html --screenshots\n"
                                        "  python verify_video.py pitch.html --mp4 pitch-1080p.mp4")
    ap.add_argument("html")
    ap.add_argument("--mp4", help="Exported MP4 (default: auto-detect <input>-<N>p.mp4)")
    ap.add_argument("--screenshots", action="store_true", help="Save one PNG per scene")
    ap.add_argument("--shots-dir", help="Screenshot folder (default: <input>_audit/)")
    ap.add_argument("--width", type=int, help="Audit width (default: 1920 landscape, 1080 portrait/square)")
    ap.add_argument("--aspect", help="Force aspect ratio, e.g. 9:16 (default: read from the stage)")
    ap.add_argument("--fps", type=int, default=60, help="Export fps to validate against (default 60)")
    args = ap.parse_args()

    if not os.path.isfile(args.html):
        raise SystemExit(f"File not found: {args.html}")
    html = open(args.html, encoding="utf-8").read()
    aspect = parse_aspect(args.aspect) if args.aspect else None
    hint = aspect or stage_aspect_hint(html)
    width = args.width or (1920 if hint > 1 else 1080)

    base = os.path.splitext(os.path.abspath(args.html))[0]
    shots = (args.shots_dir or base + "_audit") if args.screenshots else None

    print("=" * 64)
    print(f"MOTION VIDEO AUDIT: {os.path.basename(args.html)}")
    print("=" * 64)
    print("\n[1/3] HTML layout, runtime, contract, SVG")
    res = asyncio.run(audit_html(args.html, width, aspect, shots))
    scenes = res["scenes"]
    total = sum(s["dur"] or 0 for s in scenes)
    print(f"  Stage {res['viewport'][0]}x{res['viewport'][1]}, {len(scenes)} scenes, {total:g}s total")
    for s in scenes:
        print(f"    - [{s['key']}] {s['name']}: {s['dur']:g}s")

    failed = False

    def report(title, items, ok_msg, fail=True):
        nonlocal failed
        if items:
            failed = failed or fail
            print(f"  [{'FAIL' if fail else 'WARN'}] {title}")
            for it in items:
                print(f"    [X] {it}")
        else:
            print(f"  [PASS] {ok_msg}")

    report("Boundary guard", [f"{s['key']}: {v['element']} overflows {v['direction']} by {v['pixels']:.1f}px"
                              for s in scenes for v in s["violations"]],
           "Boundary guard: every element inside the stage")
    report("JavaScript runtime", res["errors"], "JavaScript runtime: no errors")
    report("Scene contract", check_contract(scenes, args.fps), "Scene contract: keys, names, durations valid")
    report("SVG / motion", [f"{s['key']}: {i}" for s in scenes for i in s["svg_issues"]],
           "SVG / motion: no SMIL, viewBoxes present")

    if re.search(r'id=["\']kit-engine["\']', html):
        stale = []
        for tag, kid, fname in (("style", "kit-css", "kit.css"), ("script", "kit-engine", "engine.js")):
            block = re.search(r'<%s id="%s">([\s\S]*?)</%s>' % (tag, kid, tag), html)
            want = open(os.path.join(HERE, "kit", fname), encoding="utf-8").read()
            if not block or block.group(1).strip() != want.strip():
                stale.append(fname)
        report("Kit sync", [f"{f} differs from kit/{f}: run node kit.mjs sync {os.path.basename(args.html)}" for f in stale],
               "Kit sync: kit.css and engine.js are current", fail=False)

    print("\n[2/3] Sound cues")
    cues_expected = has_sfx_cues(html)
    if cues_expected:
        n, issues = audit_sfx(args.html)
        report("Sound cues", issues, f"Sound cues: {n} cues valid")
    else:
        print("  [SKIP] No data-sfx / #sfx-cues in this video")

    mp4 = args.mp4
    if not mp4:
        guess = default_output(args.html, width, even(width / hint))
        mp4 = guess if os.path.isfile(guess) else None
    if mp4 and os.path.isfile(mp4):
        print(f"\n[3/3] MP4: {os.path.basename(mp4)}")
        report("MP4 integrity", audit_mp4(mp4, total, args.fps, cues_expected),
               f"MP4: {total:g}s exact, {args.fps}fps, clean decode{', audio present' if cues_expected else ''}")
    else:
        print("\n[3/3] MP4: [SKIP] no exported video found")

    print("\n" + "=" * 64)
    print("RESULT: [FAILED] fix the issues above" if failed else "RESULT: [ALL PASSED]")
    print("=" * 64)
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
