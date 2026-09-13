# BRIX, reimagined

A modern, touch-friendly web game built on **BRIX 1.00** — Michael Riedel's 1991
public-domain DOS puzzle game — with **all 112 original puzzles reproduced exactly**.

Push blocks sideways, let them fall, and make touching blocks of the same kind blast
away before the clock runs out. Same puzzles, completely modern game.

## What "exactly" means here

- **Levels.** The 112 levels were extracted from the original `LEVELS` file, not retyped.
  Each encodes back to its original 178 bytes, and each loads identically in the
  original executable's *own* level loader. `npm run validate-levels` → `112 / 112 levels match`.
- **Rules.** The original `BRIX.EXE` runs in a small 8086/DOS emulator in
  `tools/brix-oracle/`. Bots played every level in it while every key pass, fall step and
  elevator step was recorded. The modern engine replays those 112 traces — about 300,000
  steps — and must reproduce the original's state after every single one, including the
  original's quirks (latched keys, stale elevator stack counts, duplicate stack matches).
- **Completion.** A solver finds solutions with the modern engine; they replay as timed
  key presses through the real scheduler, and levels without elevators have also been
  cleared in the emulated original using those solutions.

How the original works — with evidence and open questions — is in
[docs/brix-mechanics.md](docs/brix-mechanics.md).

## Features

- The original campaign: the 7-level tree of choices, time limits, retries, five continues,
  cumulative score, hall of fame, and a saved run you can continue later
- Practice mode with every reached problem, stars, best points and best time
- Original artwork drawn in code: every block type has its own glyph as well as its colour
- Particles, screen shake, eased cursor, smooth elevators, bonus tally — with a reduced-motion setting
- Synthesised sound effects and adaptive music, each switchable
- Keyboard (arrows/WASD, Space, R, Esc), mouse and touch (tap to pick up, drag to push)
- Responsive: desktop, tablet and phone; each level's playfield is cropped to fill the screen
- Level editor: originals open read-only; duplicate to edit, undo/redo, test play, JSON import/export
- Installable PWA that works offline

## Getting started

```bash
npm install
npm run dev        # http://localhost:8129
npm test
npm run build
```

See [docs/development.md](docs/development.md) for the oracle, the solver and debug tools.

## Documentation

| Document | Contents |
|---|---|
| [docs/brix-mechanics.md](docs/brix-mechanics.md) | The original rules, marked confirmed / read from code / unknown |
| [docs/architecture.md](docs/architecture.md) | Engine, scheduler, rendering and verification layers |
| [docs/level-format.md](docs/level-format.md) | The `brix-level/1` JSON format and its mapping to the original bytes |
| [docs/development.md](docs/development.md) | Commands, deep links, debug overlay, tooling |
| [docs/brix-history.md](docs/brix-history.md) | Where BRIX comes from |
| [docs/legal-notes.md](docs/legal-notes.md) | Public-domain evidence and what is (not) used |

## Deliberate differences from 1991

These change presentation only; see the architecture doc for why none affects a puzzle.

- Blasts freeze the game for 0.76 s instead of 1.47 s (everything freezes either way;
  "Classic blast timing" restores the original).
- The level tree's 10-second choice timer is off by default (a setting turns it on).
- Block colours are not randomly rotated per problem.
- Two-player alternating mode is not implemented.
- A cross-problem state leak in the original (a stale elevator stack count) is not
  reproduced; each problem starts clean.

## Credits

BRIX 1.00 © 1991 Michael Riedel, released into the public domain. This project is not
affiliated with him or with Epic MegaGames, and uses nothing from later BRIX releases.
Fonts: Fredoka and Nunito (SIL Open Font License).
