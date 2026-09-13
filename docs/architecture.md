# Architecture

```
src/
  levels/format.ts        canonical level format, encode/decode of original records
  game/                   everything that decides what happens — no DOM, no canvas
    types.ts              GameState, commands, events
    rules.ts              the BRIX 1.00 rules (keys, falling, elevator, matching, scoring hooks)
    scoring.ts            point values, kept apart so a modern scheme could replace them
    clock.ts              the 21-tick BRIX clock
    simulation.ts         real-time scheduler: the original's two PIT timers and the blast freeze
    session.ts            a run through the level tree: choices, retries, continues
    Play.ts               one problem in play: simulation + input queue + pointer path planning
  rendering/              reads state, draws it; never writes state
    BoardRenderer.ts      board, blocks, elevator, cursor, blast visuals
    sprites.ts, palette   vector artwork baked per cell size
    effects.ts            particles, floating scores, shake
    backdrop, wordmark, thumbnails
  audio/audio.ts          synthesised effects and music (Web Audio)
  storage/storage.ts      settings, records, high scores, saved run, custom levels
  ui/                     DOM screens and the application state machine
    App.ts                screen flow; owns the requestAnimationFrame loop
    stateMachine.ts       TITLE, LEVEL_SELECT, PLAYING, ANIMATING, PAUSED, LEVEL_COMPLETE, ...
    screens/              PlayScreen, TreeScreen, BrowserScreen, EditorScreen
tools/
  brix-extractor/         LEVELS -> canonical JSON; three-way validation
  brix-oracle/            8086 + DOS emulator running the original; trace recording
  solver/                 best-first solver used for completion fixtures
tests/                    Vitest: rules, session, simulation, levels, golden traces, solutions
```

## The three layers of time

1. **Rules** (`rules.ts`) have no notion of time. They expose `keyPass`, `fallStep` and
   `elevatorStep`, each a transcription of one routine of the original. Given the same
   sequence of those calls, they produce the same states as the original — which is
   exactly what the golden traces check.
2. **Simulation** (`simulation.ts`) decides *when* those calls happen, in PIT counts,
   reproducing the original main loop (key pass every loop pass; fall step each
   12.6 ms and again with the elevator step each 25.1 ms; clock tick every 65,536
   counts; everything frozen during a blast). It is deterministic and independent of
   frame rate: `advance(16.7)` sixty times and `advance(1000)` once reach the same state.
3. **Presentation** (`PlayScreen`, `BoardRenderer`) runs on `requestAnimationFrame`,
   calls `Play.update(dt)`, drains events for sound and effects, and interpolates
   visuals (cursor glide, elevator sub-step smoothing). Nothing it does feeds back.

Because rules never look at the clock and rendering never writes state, a slow frame can
never cost the player: time is only ever consumed by the simulation.

## Input

Devices produce `Command`s (`up`, `down`, `left`, `right`, `select`). A key press calls
`Play.press()`, which — like the original keyboard read — replaces whatever key is
latched. Pointer gestures compute a command sequence (a cursor path through non-frame
cells, then pick-up/pushes/put-down) and `Play.enqueue()` feeds it one command per loop
pass, waiting while a command is latched. Every command handed to the rules is recorded
with its simulated time so a problem can be replayed exactly.

## State machine

`ui/stateMachine.ts` lists every allowed transition; `go()` throws on anything else.
`PLAYING` ⇄ `ANIMATING` is driven each frame by `Simulation.frozen`, so the UI state
always matches what the rules are doing. There are no parallel `isPaused`/`isAnimating`
flags.

## Presentation choices that do not touch rules

- The blast freeze defaults to 760 ms instead of the original's 1.47 s. Everything —
  steps, clock, elevator — freezes for its whole length, so the length changes no
  outcome. "Classic blast timing" restores 1.47 s.
- The board is cropped to each level's playfield so odd shapes use small screens well.
- Blocks keep their original type numbers; the original's random colour rotation per
  problem is not reproduced.

## Verification strategy

| What | How | Where |
|---|---|---|
| Level data is the original's | encode every canonical level back to bytes; load every level in the original's own loader | `tools/brix-extractor/validate.ts`, `tests/levels.test.ts` |
| Rules match the original | 112 recorded traces of the emulated original, thousands of steps each, replayed event by event with a state hash after each | `tests/oracle-replay.test.ts` |
| Rules are what the docs say | small hand-built boards | `tests/rules.test.ts` |
| Timing is deterministic | same script at different frame sizes | `tests/simulation.test.ts` |
| Levels are completable | solver solutions replayed through the scheduler; non-elevator solutions also played in the emulated original | `tests/solutions.test.ts`, `tools/brix-oracle/verify-solutions.ts` |
