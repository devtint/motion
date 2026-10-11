#!/usr/bin/env node
/**
 * kit.mjs — create and maintain single-file motion videos built on the motion kit.
 *
 *   node kit.mjs new <video.html> [--palette studio|fintech|cyber|emerald|mono|neon]
 *                                 [--aspect 16:9|9:16|1:1] [--title "Name"]
 *   node kit.mjs sync <video.html>      inline kit/kit.css + kit/engine.js, the icons the video
 *                                       uses (<use href="#i-NAME"/>) and the character rig
 *                                       (if any [data-character]). Run after every edit.
 *
 *   Project assets (new or sync; remembered in the video's <html> tag, so later syncs reuse them):
 *     --icons <dir[;dir2]>              the project's SVG icons become #i-<file-name> (override built-ins)
 *     --character <mascot.svg>          use the project's own character SVG instead of Blip
 *
 *   node kit.mjs icons [filter] [--icons dir]   list icon names (built-in + project)
 *   node kit.mjs gallery [out.html]     visual sheet of every icon, pose and mood (default kit/gallery.html)
 *
 * The video stays ONE self-contained file; the kit lives between id'd tags:
 *   <style id="kit-css">  <svg id="kit-icons">  <template id="kit-character">  <script id="kit-engine">
 * Put your own CSS in a separate <style> AFTER kit-css; never edit inside the kit blocks.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const KIT = path.join(HERE, 'kit');
const read = f => fs.readFileSync(path.join(KIT, f), 'utf8');
const die = m => { console.error(`[FAIL] ${m}`); process.exit(1); };

const SHAPES = /<(path|circle|rect|ellipse|line|polyline|polygon)\b(?![^>]*pathLength)/g;

function iconLibrary() {
  const lib = new Map();
  for (const m of read('icons.svg').matchAll(/<symbol id="i-([\w-]+)"[^>]*>([\s\S]*?)<\/symbol>/g)) {
    lib.set(m[1], `<symbol id="i-${m[1]}" viewBox="0 0 24 24">${m[2].replace(SHAPES, '<$1 pathLength="1"')}</symbol>`);
  }
  return lib;
}

/** Project icons: every *.svg under the given folders becomes symbol "i-<file-name>" (overrides built-ins). */
function projectIcons(dirs) {
  const lib = new Map();
  const walk = d => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.svg$/i.test(e.name)) {
        const name = e.name.replace(/\.svg$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
        const src = fs.readFileSync(p, 'utf8').replace(/<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<title>[\s\S]*?<\/title>/g, '');
        const m = src.match(/<svg\b([^>]*)>([\s\S]*)<\/svg>/i);
        if (!m || !name) continue;
        const attr = k => (m[1].match(new RegExp(`\\s${k}=["']([^"']*)["']`)) || [])[1];
        const vb = attr('viewBox') || `0 0 ${parseFloat(attr('width')) || 24} ${parseFloat(attr('height')) || 24}`;
        // Keep the root's paint settings (e.g. fill="none" stroke="currentColor") on a wrapper group.
        let paint = ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'fill-rule', 'clip-rule']
          .filter(k => attr(k) != null).map(k => `${k}="${attr(k)}"`).join(' ');
        // Filled (or unstyled = filled black by default) icons must not pick up the kit's line style.
        if (attr('stroke') == null && attr('fill') !== 'none') paint = `${attr('fill') == null ? 'fill="currentColor" ' : ''}${paint} stroke="none"`.trim();
        const inner = m[2].replace(SHAPES, '<$1 pathLength="1"').trim();
        lib.set(name, `<symbol id="i-${name}" viewBox="${vb}">${paint ? `<g ${paint}>${inner}</g>` : inner}</symbol>`);
      }
    }
  };
  for (const d of dirs) if (fs.existsSync(d)) walk(d); else console.warn(`  [WARN] icon folder not found: ${d}`);
  return lib;
}

/** <html data-icon-dirs="a;b" data-character-src="x.svg">: project assets, relative to the video file. */
function projectSettings(html, file) {
  const tag = (html.match(/<html\b[^>]*>/i) || [''])[0];
  const attr = k => (tag.match(new RegExp(`\\s${k}=["']([^"']*)["']`)) || [])[1];
  const base = path.dirname(path.resolve(file));
  return {
    iconDirs: (attr('data-icon-dirs') || '').split(';').map(s => s.trim()).filter(Boolean).map(d => path.resolve(base, d)),
    character: attr('data-character-src') ? path.resolve(base, attr('data-character-src')) : null,
  };
}

function setHtmlAttr(html, name, value) {
  return html.replace(/<html\b[^>]*>/i, tag => {
    const re = new RegExp(`\\s${name}=["'][^"']*["']`);
    const a = ` ${name}="${value}"`;
    return re.test(tag) ? tag.replace(re, a) : tag.replace(/>$/, a + '>');
  });
}

function characterTemplate(customFile) {
  if (customFile && !fs.existsSync(customFile)) die(`character file not found: ${customFile}`);
  let svg = (customFile ? fs.readFileSync(customFile, 'utf8') : read('character.svg'))
    .replace(/<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->/g, '').replace(/\s+xmlns(:\w+)?="[^"]*"/g, '').trim();
  // The engine and verifier look for svg.ch; make sure a custom rig has it.
  svg = svg.replace(/<svg\b([^>]*)>/i, (m, a) => /class=["'][^"']*\bch\b/.test(a) ? m
    : /class=["']/.test(a) ? m.replace(/class=(["'])/, 'class=$1ch ') : `<svg class="ch"${a}>`);
  return `<template id="kit-character">${svg}</template>`;
}

/** Replace the element with this id (whole tag) or insert it with `insert(html, block)`. */
function upsert(html, tag, id, block, insert) {
  const re = new RegExp(`<${tag}\\b[^>]*\\bid=["']${id}["'][^>]*>[\\s\\S]*?<\\/${tag}>\\s*`, 'i');
  if (re.test(html)) return block ? html.replace(re, () => block + '\n') : html.replace(re, () => '');
  return block ? insert(html, block) : html;
}
const beforeClose = tag => (html, block) => {
  const i = html.toLowerCase().lastIndexOf(`</${tag}>`);
  if (i < 0) die(`no </${tag}> found`);
  return html.slice(0, i) + block + '\n' + html.slice(i);
};
const afterOpen = tag => (html, block) => {
  const m = html.match(new RegExp(`<${tag}\\b[^>]*>`, 'i'));
  if (!m) die(`no <${tag}> found`);
  const i = m.index + m[0].length;
  return html.slice(0, i) + '\n' + block + html.slice(i);
};
const beforeFirstStyle = (html, block) => {
  const i = html.search(/<style\b/i);
  return i < 0 ? beforeClose('head')(html, block) : html.slice(0, i) + block + '\n' + html.slice(i);
};

export function sync(file, { quiet = false, icons: iconOpt, character: charOpt } = {}) {
  if (!fs.existsSync(file)) die(`not found: ${file}`);
  let html = fs.readFileSync(file, 'utf8');
  const rel = p => path.relative(path.dirname(path.resolve(file)), path.resolve(p)).replace(/\\/g, '/');
  if (iconOpt) html = setHtmlAttr(html, 'data-icon-dirs', [].concat(iconOpt).map(rel).join(';'));
  if (charOpt) html = setHtmlAttr(html, 'data-character-src', rel(charOpt));
  const proj = projectSettings(html, file);
  const own = projectIcons(proj.iconDirs);
  const lib = new Map([...iconLibrary(), ...own]);

  html = upsert(html, 'style', 'kit-css', `<style id="kit-css">\n${read('kit.css')}</style>`, beforeFirstStyle);

  // Scan the page with the kit blocks removed, so old sprites don't count as "used".
  const body = html.replace(/<(svg|template|script|style)\b[^>]*\bid=["']kit-[\w-]+["'][^>]*>[\s\S]*?<\/\1>/gi, '');
  const used = [...new Set([...body.matchAll(/href=["']#i-([\w-]+)["']/g)].map(m => m[1]))];
  const missing = used.filter(n => !lib.has(n));
  const icons = used.filter(n => lib.has(n));
  const sprite = icons.length
    ? `<svg id="kit-icons" aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden">${icons.map(n => lib.get(n)).join('')}</svg>`
    : '';
  html = upsert(html, 'svg', 'kit-icons', sprite, afterOpen('body'));

  const needsChar = /\bdata-character\b/.test(body);
  html = upsert(html, 'template', 'kit-character', needsChar ? characterTemplate(proj.character) : '', (h, b) =>
    /<svg\b[^>]*id=["']kit-icons["']/.test(h)
      ? h.replace(/(<svg\b[^>]*id=["']kit-icons["'][^>]*>[\s\S]*?<\/svg>)/i, (m) => m + '\n' + b)
      : afterOpen('body')(h, b));

  // Engine must be the last script: it reads the whole stage (and #sfx-cues) when it runs.
  html = upsert(html, 'script', 'kit-engine', '', h => h);
  html = beforeClose('body')(html, `<script id="kit-engine">\n${read('engine.js')}</script>`);

  fs.writeFileSync(file, html);
  if (!quiet) {
    const ownUsed = icons.filter(n => own.has(n)).length;
    console.log(`  [OK] synced ${path.basename(file)}: kit css + engine, ${icons.length} icon(s)` +
      `${ownUsed ? ` (${ownUsed} from project)` : ''}` +
      `${needsChar ? (proj.character ? `, custom character (${path.basename(proj.character)})` : ', character rig') : ''}`);
    if (own.size) console.log(`  [OK] project icons available: ${own.size} from ${proj.iconDirs.map(rel).join(', ')}`);
    if (missing.length) console.warn(`  [WARN] unknown icon(s): ${missing.join(', ')}. Run "node kit.mjs icons".`);
  }
  return { icons, missing, needsChar };
}

function cmdNew(file, opt) {
  if (!file) die('usage: node kit.mjs new <video.html> [--palette p] [--aspect 16:9] [--title "Name"]');
  if (fs.existsSync(file) && !opt.force) die(`${file} exists (use --force to overwrite)`);
  const [w, h] = (opt.aspect || '16:9').split(/[:/x]/).map(Number);
  if (!w || !h) die(`bad --aspect ${opt.aspect}`);
  let html = read('skeleton.html')
    .replace(/data-palette="[^"]*"/, `data-palette="${opt.palette || 'studio'}"`)
    .replace(/<title>[^<]*<\/title>/, `<title>${opt.title || path.basename(file, '.html')}</title>`)
    .replace(/\/\*ASPECT\*\/[^;]*;/, `aspect-ratio:${w}/${h};`);
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, html);
  sync(file, { quiet: true, ...assetOpts(opt) });
  console.log(`  [OK] created ${file} (${opt.palette || 'studio'}, ${w}:${h}). Edit the scenes, then: node kit.mjs sync ${file}`);
}

const splitDirs = v => (typeof v === 'string' ? v.split(/[;,]/).map(s => s.trim()).filter(Boolean) : null);
const assetOpts = opt => ({ icons: splitDirs(opt.icons), character: typeof opt.character === 'string' ? opt.character : null });

function cmdIcons(filter, opt = {}) {
  const own = projectIcons(splitDirs(opt.icons) || []);
  if (own.size) console.log(`${own.size} project icons: ${[...own.keys()].join(', ')}
`);
  const names = [...iconLibrary().keys()].filter(n => !filter || n.includes(filter));
  console.log(`${names.length} icons (use <svg class="icon"><use href="#i-NAME"/></svg>):\n`);
  for (let i = 0; i < names.length; i += 6) console.log('  ' + names.slice(i, i + 6).map(n => n.padEnd(14)).join(''));
}

function cmdGallery(out) {
  out = out || path.join(KIT, 'gallery.html');
  const names = [...iconLibrary().keys()];
  const poses = ['idle', 'wave', 'point', 'point-up', 'point-left', 'present', 'cheer', 'shrug', 'think', 'type', 'clap', 'jump'];
  const moods = ['happy', 'excited', 'laugh', 'neutral', 'sad', 'surprised', 'angry', 'wink', 'talk'];
  const cell = (inner, label) => `<div class="g"><div>${inner}</div><span class="mono">${label}</span></div>`;
  const html = `<!doctype html>
<html lang="en" data-palette="studio"><head><meta charset="utf-8"><title>Kit Gallery</title>
<style>
.stage{aspect-ratio:auto!important;height:auto;padding:3cqw}
.scene{position:static!important;display:flex!important;padding:2cqw 0}
.grid{display:grid;grid-template-columns:repeat(10,1fr);gap:1.4cqw;width:100%}
.chars{display:grid;grid-template-columns:repeat(6,1fr);gap:1.4cqw;width:100%}
.g{display:flex;flex-direction:column;align-items:center;gap:.6cqw;font-size:1.1cqw;color:var(--muted)}
.g .icon{--s:4cqw;color:var(--ink)}
.chars .char{--size:11cqw}
</style></head><body>
<div class="player" style="max-width:1400px"><div class="stage" id="stage">
<section class="scene active" data-key="gallery" data-dur="60" data-name="Gallery">
  <h2 class="h2">Icons (${names.length})</h2>
  <div class="grid">${names.map(n => cell(`<svg class="icon"><use href="#i-${n}"/></svg>`, n)).join('')}</div>
  <h2 class="h2" style="margin-top:3cqw">Poses</h2>
  <div class="chars">${poses.map(p => cell(`<div data-character data-now="${p}"></div>`, p)).join('')}</div>
  <h2 class="h2" style="margin-top:3cqw">Moods &amp; looks</h2>
  <div class="chars">${moods.map(m => cell(`<div data-character data-now="${m}" style="--shirt:var(--accent-2)"></div>`, m)).join('')}
    ${cell('<div data-character data-top="sprout" data-now="happy" style="--shirt:#3D7A5A"></div>', 'top=sprout')}
    ${cell('<div data-character data-top="none" data-acc="glasses" data-now="neutral look-left" style="--shirt:#E9B949"></div>', 'top=none glasses')}
    ${cell('<div data-character data-now="excited" style="--shirt:#8C6BD8;--bulb:#FF8F8F"></div>', '--shirt --bulb')}
    ${cell('<div data-character class="flip" data-now="point" style="--shirt:#33415C"></div>', 'flip + point')}</div>
</section></div></div>
</body></html>`;
  fs.writeFileSync(out, html);
  sync(out, { quiet: true });
  console.log(`  [OK] wrote ${out}`);
}

function parseArgs(argv) {
  const pos = [], opt = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) { const v = argv[i + 1]; if (v === undefined || v.startsWith('--')) opt[a.slice(2)] = true; else { opt[a.slice(2)] = v; i++; } }
    else pos.push(a);
  }
  return { pos, opt };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parseArgs(rest);
  switch (cmd) {
    case 'new': cmdNew(pos[0], opt); break;
    case 'sync': if (!pos.length) die('usage: node kit.mjs sync <video.html>'); for (const f of pos) sync(f, assetOpts(opt)); break;
    case 'icons': cmdIcons(pos[0], opt); break;
    case 'gallery': cmdGallery(pos[0]); break;
    default: {
      const doc = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)[1];
      console.log(doc.replace(/^ \* ?/gm, ''));
      process.exit(cmd ? 1 : 0);
    }
  }
}
