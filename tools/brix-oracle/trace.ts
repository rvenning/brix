// Record what the original does, and replay it through the modern engine.

import { Oracle, KEYS } from './oracle.mjs';
import type { LevelData } from '../../src/levels/format.ts';
import { createGame, keyPass, fallStep, elevatorStep } from '../../src/game/rules.ts';
import type { GameState } from '../../src/game/types.ts';
import { Command } from '../../src/game/types.ts';
import {
  type Snapshot, type OracleState, oracleSnapshot, engineSnapshot, hashSnapshot, diffSnapshots,
  COMMAND_OF_CODE, KEY_CODES,
} from './snapshot.ts';

/**
 * key      the key handler ran with a key in [0A3h]
 * fall     a fall step ran
 * elevator an elevator step ran
 * latch    the keyboard read stored a new key in [0A3h] (possibly in the middle of a step's animation)
 */
export type TraceEventType = 'key' | 'fall' | 'elevator' | 'latch';

export interface TraceEvent {
  type: TraceEventType;
  key?: number;
  /**
   * Hash of the state after this event, or absent when the state after it cannot be observed
   * (a latch followed immediately, so the next checkpoint reflects both).
   */
  hash?: string;
  /** Full state after this event, when kept. */
  state?: Snapshot;
}

export interface Trace {
  level: number;
  initial: Snapshot;
  events: TraceEvent[];
  /** 2 = the original declared the level cleared, 1 = time up, null = recording stopped. */
  ended: number | null;
  emulatedMs: number;
}

export interface Controller {
  /** Called every `interval` emulated ms with the current original state; return keys to press. */
  decide(state: OracleState, elapsedMs: number): Command[];
  interval: number;
}

const SCAN: Record<Command, [number, number]> = {
  [Command.Up]: KEYS.up as [number, number], [Command.Down]: KEYS.down as [number, number],
  [Command.Left]: KEYS.left as [number, number], [Command.Right]: KEYS.right as [number, number],
  [Command.Select]: KEYS.space as [number, number],
};

let sharedOracle: Oracle | null = null;
export function getOracle(gameDir: string): Oracle {
  if (!sharedOracle) sharedOracle = new Oracle(gameDir);
  return sharedOracle;
}

type RawEvent = { type: TraceEventType; key?: number; before?: OracleState };

export interface RecordOptions {
  /** Keep the full state after every event (large; for debugging). Otherwise only after state-changing key events and at the end. */
  fullStates?: boolean;
}

export function recordTrace(oracle: Oracle, levelIndex: number, controller: Controller, maxMs: number, opts: RecordOptions = {}): Trace {
  const initialRaw = oracle.loadProblem(levelIndex) as OracleState;
  oracle.startRecording();
  let elapsed = 0;
  while (elapsed < maxMs && oracle.ended == null) {
    const keys = controller.decide(oracle.state() as OracleState, elapsed);
    for (const k of keys) oracle.press(...SCAN[k]);
    oracle.runMs(controller.interval);
    elapsed += controller.interval;
  }
  return buildTrace(levelIndex, oracleSnapshot(initialRaw), oracle.events as RawEvent[], oracleSnapshot(oracle.settleToCheckpoint() as OracleState), oracle.ended ?? null, elapsed, opts);
}

function buildTrace(levelIndex: number, initial: Snapshot, raw: RawEvent[], finalState: Snapshot, ended: number | null, emulatedMs: number, opts: RecordOptions): Trace {
  // after[i]: the state at the next checkpoint (an event with a `before` snapshot) following i.
  const after: Snapshot[] = new Array(raw.length);
  let next = finalState;
  for (let i = raw.length - 1; i >= 0; i--) {
    after[i] = next;
    if (raw[i].before) next = oracleSnapshot(raw[i].before!);
  }
  const events: TraceEvent[] = [];
  let lastHash = hashSnapshot(initial);
  for (let i = 0; i < raw.length; i++) {
    const ev = raw[i];
    const observable = !(i + 1 < raw.length && raw[i + 1].type === 'latch');
    const out: TraceEvent = { type: ev.type };
    if (ev.key !== undefined) out.key = ev.key;
    if (observable) {
      out.hash = hashSnapshot(after[i]);
      // A latched key is handled on every loop pass; back-to-back repeats that change nothing are dropped.
      const prev = events[events.length - 1];
      if (ev.type === 'key' && prev?.type === 'key' && prev.key === ev.key && prev.hash === out.hash && out.hash === lastHash) continue;
      if (opts.fullStates || (ev.type === 'key' && out.hash !== lastHash)) out.state = after[i];
      lastHash = out.hash;
    }
    events.push(out);
  }
  if (events.length) {
    const last = events[events.length - 1];
    last.hash = hashSnapshot(finalState);
    last.state = finalState;
  }
  return { level: levelIndex + 1, initial, events, ended, emulatedMs };
}

export interface ReplayResult {
  ok: boolean;
  eventsChecked: number;
  divergence?: { index: number; event: TraceEvent; diffs: string[] };
  state: GameState;
}

export function applyTraceEvent(s: GameState, ev: TraceEvent): void {
  switch (ev.type) {
    case 'latch':
      // any key replaces the latched one; keys that are not commands simply clear it
      s.latched = COMMAND_OF_CODE.get(ev.key!) ?? null;
      return;
    case 'key':
      keyPass(s);
      return;
    case 'fall':
      fallStep(s);
      return;
    case 'elevator':
      elevatorStep(s);
      return;
  }
}

/** The rules score the clear bonus the moment the level ends; the oracle stops just before it does. */
function comparable(s: GameState): Snapshot {
  const snap = engineSnapshot(s);
  const cleared = s.events.find(e => e.type === 'cleared');
  if (cleared && cleared.type === 'cleared') snap.score -= cleared.bonus;
  return snap;
}

export function replayTrace(level: LevelData, trace: Trace): ReplayResult {
  const s = createGame(level);
  const initialDiffs = diffSnapshots(trace.initial, engineSnapshot(s));
  if (initialDiffs.length) {
    return { ok: false, eventsChecked: 0, divergence: { index: -1, event: { type: 'key' }, diffs: initialDiffs }, state: s };
  }
  let checked = 0;
  for (let i = 0; i < trace.events.length; i++) {
    const ev = trace.events[i];
    if (s.status !== 'playing' && ev.type !== 'latch') {
      return { ok: false, eventsChecked: checked, divergence: { index: i, event: ev, diffs: [`engine ended (${s.status}) but the original kept going`] }, state: s };
    }
    applyTraceEvent(s, ev);
    if (!ev.hash) continue;
    checked++;
    const snap = comparable(s);
    if (hashSnapshot(snap) !== ev.hash) {
      const diffs = ev.state ? diffSnapshots(ev.state, snap) : ['state hash differs (no full state stored for this event; record with fullStates to see the diff)'];
      return { ok: false, eventsChecked: checked, divergence: { index: i, event: ev, diffs }, state: s };
    }
  }
  const expectedStatus = trace.ended === 2 ? 'cleared' : 'playing';
  if (trace.ended !== 1 && s.status !== expectedStatus) {
    return { ok: false, eventsChecked: checked, divergence: { index: trace.events.length, event: trace.events.at(-1)!, diffs: [`status: expected ${expectedStatus}, actual ${s.status}`] }, state: s };
  }
  return { ok: true, eventsChecked: checked, state: s };
}

export { KEY_CODES };
