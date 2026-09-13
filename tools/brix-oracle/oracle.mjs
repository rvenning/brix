// The original BRIX 1.00 as a test oracle.
//
// Boots BRIX.EXE in the emulator, loads any of the 112 problems by rewriting
// the arguments of the game's own level loader, and records every call to the
// three routines that carry the rules:
//
//   s309:3592  key handler      (one call per main-loop pass, key in [0A3h])
//   s309:1F95  fall step        (falling blocks advance one pixel of 16)
//   s309:2346  elevator step    (elevator advances one pixel of 16)
//
// A modern engine that replays the same event sequence must reach the same
// state after every event. See docs/brix-mechanics.md for the variable map.

import { Machine } from './dos.mjs';

export const GAME_CS = 0x1010 + 0x309;
const HOOK_LOAD = 0x1453, HOOK_KEY = 0x3592, HOOK_FALL = 0x1f95, HOOK_ELEV = 0x2346;
const HOOK_MATCH = 0x4301, HOOK_END = 0x5223, HOOK_LATCH = 0x08c4;

export function problemCoords(index) {
  const choice = Math.floor(index / 4), problem = index % 4;
  let col = 0;
  while ((col + 1) * (col + 2) / 2 <= choice) col++;
  const row = choice - col * (col + 1) / 2;
  return { col, row, problem };
}

const s16 = v => (v << 16) >> 16;

export class Oracle {
  constructor(gameDir) {
    this.m = new Machine(gameDir, { log: () => {} });
    this.events = null;
    this.override = null;
    this.inGame = false;
    const m = this.m;
    m.addHook(GAME_CS, HOOK_LOAD, () => {
      if (!this.override) return;
      const c = m.cpu;
      c.ww(c.s[2], c.r[4] + 4, this.override.col);
      c.ww(c.s[2], c.r[4] + 6, this.override.row);
      c.ww(c.s[2], c.r[4] + 8, this.override.problem);
      m.poke8(0x920, 7); // identity colour rotation: board values equal file values
    });
    m.addHook(GAME_CS, HOOK_KEY, () => {
      const c = m.cpu;
      const mode = c.rb(c.s[2], c.r[4] + 4);
      if (mode === 1) {
        if (!this.inGame) m.stopRequested = true; // stop exactly at the first pass of the game loop
        this.inGame = true;
      }
      else { this.inTree = true; return; }
      if (!this.events) return;
      const key = m.peek8(0xa3);
      if (key === 0) return; // idle pass: the handler does nothing
      this.record({ type: 'key', key });
    });
    // s309:08C4 stores a freshly read key into [0A3h]. This happens at the top of each loop
    // pass and also inside animation delays, i.e. in the middle of a fall or elevator step.
    m.addHook(GAME_CS, HOOK_LATCH, () => {
      if (this.events && this.inGame) this.events.push({ type: 'latch', key: m.cpu.r[0] & 0xff });
    });
    m.addHook(GAME_CS, HOOK_FALL, () => { if (this.events && this.inGame) this.record({ type: 'fall' }); });
    m.addHook(GAME_CS, HOOK_ELEV, () => { if (this.events && this.inGame) this.record({ type: 'elevator' }); });
    m.addHook(GAME_CS, HOOK_MATCH, () => {
      if (!this.events || !this.inGame) return;
      const c = m.cpu;
      this.matchCalls.push(c.rw(c.s[2], c.r[4] + 4));
    });
    m.addHook(GAME_CS, HOOK_END, () => {
      if (!this.events) return;
      const c = m.cpu;
      this.ended = c.rb(c.s[2], c.r[4] + 4); // 1 = time up, 2 = cleared
      m.stopRequested = true;
    });
  }

  record(ev) {
    // state *before* this event == state after the previous one
    if (this.stopAtCheckpoint) {
      this.checkpointState = this.state();
      this.stopAtCheckpoint = false;
      this.m.stopRequested = true;
      return;
    }
    ev.before = this.state();
    ev.t = Math.round(this.m.ms);
    this.events.push(ev);
  }

  bootToTree() {
    const m = this.m;
    m.runMs(2000);
    m.pressScan(0x3b, 0); // F1
    this.inTree = false;
    for (let i = 0; i < 200 && !this.inTree; i++) m.runMs(100);
    if (!this.inTree) throw new Error('level tree never appeared');
    this.treeSnapshot = m.snapshot();
  }

  // Load problem `index` (0..111, file order) and run until the in-game loop starts.
  loadProblem(index) {
    const m = this.m;
    if (!this.treeSnapshot) this.bootToTree();
    m.restore(this.treeSnapshot);
    this.override = problemCoords(index);
    this.inGame = false;
    this.events = null;
    this.ended = null;
    m.pressScan(0x39, 0x20);
    for (let i = 0; i < 400 && !this.inGame; i++) m.runMs(50);
    if (!this.inGame) throw new Error(`problem ${index} never started`);
    return this.state();
  }

  /** Run on to the next event boundary (never mid-animation) and return the state there. */
  settleToCheckpoint() {
    if (this.ended != null) return this.state();
    this.stopAtCheckpoint = true;
    this.checkpointState = null;
    for (let i = 0; i < 100 && this.checkpointState == null && this.ended == null; i++) this.m.runMs(100);
    const events = this.events;
    this.events = null;
    this.stopAtCheckpoint = false;
    const s = this.checkpointState ?? this.state();
    this.events = events;
    return s;
  }

  startRecording() { this.events = []; this.matchCalls = []; }

  state() {
    const m = this.m;
    const board = [];
    for (let y = 0; y < 12; y++) {
      const row = [];
      for (let x = 0; x < 14; x++) row.push(m.peek8(0xc21 + x * 12 + y));
      board.push(row);
    }
    const fallCount = m.peek16(0x94);
    const falling = [];
    for (let i = 0; i < fallCount; i++) falling.push([m.peek16(0xdd0 + i * 2), m.peek16(0xe0c + i * 2)]);
    return {
      board,
      cursor: [m.peek16(0xcca), m.peek16(0xccc)],
      carrying: m.peek8(0x93),
      riding: m.peek8(0x99),
      fallingWithBlock: m.peek8(0x98),
      falling,
      fallOffset: m.peek16(0x96),
      elevator: m.peek16(0x918) ? {
        x: m.peek16(0x1204), y: m.peek16(0x1206), stack: m.peek16(0x9a),
        offset: s16(m.peek16(0x9e)), dir: s16(m.peek16(0x91c)), pause: m.peek8(0xaf),
      } : null,
      horizontalFlag: m.peek16(0x91a),
      chain: m.peek8(0xa6),
      remaining: m.peek8(0x8da),
      counts: [...Array(9).keys()].map(v => m.peek8(0x1208 + v)),
      score: m.peek16(0xffc) + m.peek16(0xffe) * 65536,
      time: [m.peek8(0xcce), m.peek8(0xccf)],
      retries: m.peek16(0xff8),
      key: m.peek8(0xa3),
    };
  }

  press(scan, ascii = 0) { this.m.pressScan(scan, ascii); }
  runMs(ms) { this.m.runMs(ms); }
}

export const KEYS = {
  up: [0x48, 0], down: [0x50, 0], left: [0x4b, 0], right: [0x4d, 0], space: [0x39, 0x20],
};
