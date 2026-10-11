# Instructions for AI Assistants Working with This Skill

1. Read `SKILL.md`, then `reference/ui-kit.md` (every class and attribute). Look at `template.html` for working patterns.
2. If you're inside the user's project, do the brand discovery first (SKILL.md section 2): logo, icon folder, colours, fonts, real copy and UI, and any mascot. Then ask the pre-flight questions in one batch, including **which character** (built-in Blip, their own, or none) and whether to use the project's branding.
3. `node kit.mjs new <name>.html --palette P --aspect A [--icons <their icons> --character <their mascot.svg>]`, write the scenes, then `node kit.mjs sync <name>.html` after every edit.
4. Never hand-write an engine or icon sprites: use the kit's declarative attributes, plus `--icons` for project icons. Custom characters start from a copy of `kit/character.svg` so the rig keeps working. Never edit inside the `kit-*` blocks.
5. `python verify_video.py <name>.html --screenshots`, then open every PNG with the Read tool and fix what you see.
6. `python record_video.py <name>.html`, then `python verify_video.py <name>.html` (audits the MP4).
7. If sound was requested, deliver `node sfx.mjs cues <name>.html` as the cue sheet.

Non-negotiables: everything in `cqw`; resting markup = end state; motion only through CSS keyframes and
kit attributes (deterministic); durations are multiples of 0.05s; sound cues are sparse and sit on visible beats.
