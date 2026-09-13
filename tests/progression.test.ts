import { beforeEach, describe, expect, it } from 'vitest';
import {
  addHighScore, loadHighScores, loadRecords, loadRun, loadSettings, qualifiesForHighScore, saveRecord, saveRun,
  saveSettings, DEFAULT_SETTINGS,
} from '../src/storage/storage.ts';
import { createSession, chooseNode } from '../src/game/session.ts';
import { Play } from '../src/game/Play.ts';
import { Command } from '../src/game/types.ts';
import { level } from './helpers.ts';

class MemoryStorage {
  private data = new Map<string, string>();
  getItem(k: string) { return this.data.get(k) ?? null; }
  setItem(k: string, v: string) { this.data.set(k, String(v)); }
  removeItem(k: string) { this.data.delete(k); }
  clear() { this.data.clear(); }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

describe('saved progression', () => {
  it('round-trips settings, falling back to defaults', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    saveSettings({ ...DEFAULT_SETTINGS, music: false });
    expect(loadSettings().music).toBe(false);
  });

  it('keeps per-level records and merges updates', () => {
    saveRecord('original-001', r => ({ ...r, cleared: true, bestPoints: 700, stars: 2 }));
    saveRecord('original-001', r => ({ ...r, bestPoints: Math.max(r.bestPoints, 500), plays: r.plays + 1 }));
    expect(loadRecords()['original-001']).toMatchObject({ cleared: true, bestPoints: 700, stars: 2, plays: 1 });
  });

  it('keeps the ten best high scores in order', () => {
    for (let i = 1; i <= 12; i++) addHighScore({ name: `P${i}`, score: i * 1000, reached: '', date: '' });
    const list = loadHighScores();
    expect(list).toHaveLength(10);
    expect(list[0].score).toBe(12000);
    expect(qualifiesForHighScore(2500)).toBe(false);
    expect(qualifiesForHighScore(3500)).toBe(true);
  });

  it('saves and restores a run in progress', () => {
    const s = createSession();
    chooseNode(s);
    s.score = 4200;
    saveRun(s);
    expect(loadRun()).toEqual(s);
    saveRun(null);
    expect(loadRun()).toBeNull();
  });

  it('survives unavailable storage', () => {
    (globalThis as { localStorage?: unknown }).localStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    expect(() => saveSettings(DEFAULT_SETTINGS)).not.toThrow();
  });
});

describe('failing and replaying a problem', () => {
  const rows = ['#######', '#1...1#', '#=====#', '#######'];

  it('runs out of time one displayed second after 0:00', () => {
    const play = new Play(level(rows, { time: [0, 2] }), { blastFreezeMs: 700 });
    play.update(2 * 1153 + 500);
    expect(play.status).toBe('playing');
    expect(play.state.clock).toMatchObject({ minutes: 0, seconds: 0 });
    play.update(1200);
    expect(play.status).toBe('timeUp');
    expect(play.drainEvents().some(e => e.type === 'timeUp')).toBe(true);
  });

  it('replays recorded inputs to exactly the same result', () => {
    const lv = level(rows, { cursor: [1, 1], time: [1, 0] });
    const live = new Play(lv, { blastFreezeMs: 700 });
    live.update(50);
    live.enqueue([Command.Select, Command.Right, Command.Right, Command.Right]);
    for (let i = 0; i < 400 && live.status === 'playing'; i++) live.update(16.7);
    expect(live.status).toBe('cleared');

    const replay = new Play(lv, { blastFreezeMs: 700 });
    replay.startReplay(live.inputs);
    for (let i = 0; i < 400 && replay.status === 'playing'; i++) replay.update(33);
    expect(replay.status).toBe('cleared');
    expect(replay.state.score).toBe(live.state.score);
    expect(replay.state.clock).toEqual(live.state.clock);
  });
});
