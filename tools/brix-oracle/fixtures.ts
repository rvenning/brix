// Golden fixture format for recorded original-game traces.
//
// Events are stored as one compact string of tokens separated by spaces:
//
//   f / e / k        a fall step, elevator step or key pass whose resulting state hash
//                    equals the previous token's
//   f:1a2b3c4d       ... with the resulting state hash
//   f*12             twelve in a row, all leaving the hash unchanged
//   l4d              a latch: key 0x4D stored in [0A3h] (no state is observable after it)
//
// Full states are kept at a handful of checkpoints so a failing replay can say what differs.

import type { Snapshot } from './snapshot.ts';
import type { Trace, TraceEvent } from './trace.ts';

export interface StoredSnapshot extends Omit<Snapshot, 'board'> {
  board: string[];
}

export interface Fixture {
  format: 'brix-oracle-trace/1';
  level: number;
  levelId: string;
  description: string;
  recording: { controller: string; seed: number; emulatedMs: number };
  ended: 'cleared' | 'timeUp' | null;
  initial: StoredSnapshot;
  eventCount: number;
  events: string;
  checkpoints: { event: number; state: StoredSnapshot }[];
}

const CH: Record<number, string> = { 0: '.', 10: '=', 11: '#', 12: 'E', 13: ' ' };
const BACK: Record<string, number> = { '.': 0, '=': 10, '#': 11, E: 12, ' ': 13 };

export function storeSnapshot(s: Snapshot): StoredSnapshot {
  return { ...s, board: s.board.map(r => r.map(v => CH[v] ?? (v >= 1 && v <= 9 ? String(v) : `{${v}}`)).join('')) };
}
export function loadSnapshot(s: StoredSnapshot): Snapshot {
  return {
    ...s,
    board: s.board.map(r => {
      const out: number[] = [];
      for (let i = 0; i < r.length; i++) {
        if (r[i] === '{') { const j = r.indexOf('}', i); out.push(Number(r.slice(i + 1, j))); i = j; }
        else out.push(BACK[r[i]] ?? Number(r[i]));
      }
      return out;
    }),
  };
}

const TYPE_CHAR = { fall: 'f', elevator: 'e', key: 'k', latch: 'l' } as const;
const CHAR_TYPE = { f: 'fall', e: 'elevator', k: 'key', l: 'latch' } as const;

export function encodeEvents(events: TraceEvent[]): string {
  const tokens: string[] = [];
  let lastHash: string | undefined;
  let run: { ch: string; n: number } | null = null;
  const flush = () => {
    if (run) tokens.push(run.n > 1 ? `${run.ch}*${run.n}` : run.ch);
    run = null;
  };
  for (const ev of events) {
    if (ev.type === 'latch') {
      flush();
      tokens.push(`l${ev.key!.toString(16)}`);
      continue;
    }
    const ch = TYPE_CHAR[ev.type];
    if (ev.hash === undefined) {
      flush();
      tokens.push(`${ch}:?`);
      continue;
    }
    if (ev.hash === lastHash) {
      if (run && run.ch === ch) run.n++;
      else { flush(); run = { ch, n: 1 }; }
      continue;
    }
    flush();
    tokens.push(`${ch}:${ev.hash}`);
    lastHash = ev.hash;
  }
  flush();
  return tokens.join(' ');
}

export function decodeEvents(encoded: string): TraceEvent[] {
  const events: TraceEvent[] = [];
  let lastHash: string | undefined;
  for (const tok of encoded.split(' ')) {
    if (!tok) continue;
    const ch = tok[0] as keyof typeof CHAR_TYPE;
    const type = CHAR_TYPE[ch];
    if (!type) throw new Error(`bad token ${tok}`);
    if (type === 'latch') { events.push({ type, key: parseInt(tok.slice(1), 16) }); continue; }
    if (tok[1] === '*') {
      const n = Number(tok.slice(2));
      for (let i = 0; i < n; i++) events.push({ type, hash: lastHash });
    } else if (tok[1] === ':') {
      const h = tok.slice(2);
      if (h === '?') events.push({ type });
      else { events.push({ type, hash: h }); lastHash = h; }
    } else {
      events.push({ type, hash: lastHash });
    }
  }
  return events;
}

export function traceToFixture(trace: Trace, levelId: string, recording: Fixture['recording'], description: string, checkpointEvery = 400): Fixture {
  const checkpoints: Fixture['checkpoints'] = [];
  let sinceLast = Infinity;
  trace.events.forEach((ev, i) => {
    sinceLast++;
    const isLast = i === trace.events.length - 1;
    if (ev.state && (isLast || sinceLast >= checkpointEvery)) {
      checkpoints.push({ event: i, state: storeSnapshot(ev.state) });
      sinceLast = 0;
    }
  });
  return {
    format: 'brix-oracle-trace/1',
    level: trace.level,
    levelId,
    description,
    recording,
    ended: trace.ended === 2 ? 'cleared' : trace.ended === 1 ? 'timeUp' : null,
    initial: storeSnapshot(trace.initial),
    eventCount: trace.events.length,
    events: encodeEvents(trace.events),
    checkpoints,
  };
}

export function fixtureToTrace(f: Fixture): Trace {
  const events = decodeEvents(f.events);
  if (events.length !== f.eventCount) throw new Error(`fixture ${f.levelId}: decoded ${events.length} events, expected ${f.eventCount}`);
  for (const c of f.checkpoints) events[c.event].state = loadSnapshot(c.state);
  return {
    level: f.level,
    initial: loadSnapshot(f.initial),
    events,
    ended: f.ended === 'cleared' ? 2 : f.ended === 'timeUp' ? 1 : null,
    emulatedMs: f.recording.emulatedMs,
  };
}
