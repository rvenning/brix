# Development

Requires Node.js 24+ (tools are TypeScript run directly by Node's type stripping).

```bash
npm install
npm run dev          # http://localhost:8129
npm test             # unit tests, 112 golden traces, solution replays (~10 s)
npm run build        # type-check and production build to dist/
```

## Deep links and debug

- `#level=17` opens original problem 17 in practice mode.
- In dev builds, <kbd>`</kbd> toggles the debug overlay: grid coordinates, falling blocks,
  cursor/latch/queue, elevator internals, clock, simulation time and FPS. It is compiled
  out of production builds.
- In dev builds `window.brix` is the app; `brix.stepFrames(n)` runs frames without
  `requestAnimationFrame`, for automated checks in hidden tabs.

## Level data

```bash
npm run extract-levels     # reference/brix100/LEVELS -> public/levels/original/*.json
npm run validate-levels    # 112 / 112: bytes, the original's own loader, shipped pack
```

Never edit `public/levels/original/` by hand — validation fails on any difference.

## The oracle (original game in an emulator)

`tools/brix-oracle/` boots `BRIX.EXE` in a small 8086 + DOS emulator (no DOSBox needed)
and hooks the routines that carry the rules. Useful commands:

```bash
npm run replay-check -- 17 88 --ms=20000   # fresh traces of the original vs the engine, with diffs
npm run record-fixtures                    # re-record tests/fixtures/original-levels
BRIX_ORACLE=1 npx vitest run tests/oracle-replay.test.ts   # include live traces in tests
node tools/brix-oracle/verify-solutions.ts # play solver solutions in the original
```

A trace is refused (not written) if the engine cannot reproduce it, so recording fixtures
is also a full check.

If you change `rules.ts`, run `npm test`: the golden traces will name the first event
where behaviour departs from the original and print the differing cells and fields.

## Solver

```bash
node tools/solver/solve-all.ts [levels...] --ms=120000
```

Writes `tests/fixtures/solutions/level-NNN.json` (moves and timed inputs). Static levels
are searched on the rules alone; elevator levels through the real scheduler, pressing at
most one key per ~14 ms as the original accepts.

## Conventions

- Rules code cites the original routine it reproduces (`s309:xxxx`).
- Rendering and UI never write `GameState`; they read it and drain `events`.
- New mechanics must first be documented in `docs/brix-mechanics.md` with their evidence.
