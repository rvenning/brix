// Local persistence: settings, per-problem records, high scores, a run in progress and
// custom levels. Everything is best-effort: storage may be unavailable (private
// windows, blocked site data) and the game must still work.

import type { Command } from '../game/types.ts';
import type { Session } from '../game/session.ts';
import type { LevelData } from '../levels/format.ts';

const PREFIX = 'brix:';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}
function readArray<T>(key: string): T[] {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    // storage full or unavailable: the game carries on without saving
  }
}

export interface Settings {
  sound: boolean;
  music: boolean;
  /** 'system' follows prefers-reduced-motion. */
  motion: 'system' | 'reduced' | 'full';
  /** Blast freeze as long as the original's 1.47 s instead of the brisker modern default. */
  classicBlastTiming: boolean;
  /** The original's 10-second limit on the level tree. */
  treeTimer: boolean;
}

export const DEFAULT_SETTINGS: Settings = { sound: true, music: true, motion: 'system', classicBlastTiming: false, treeTimer: false };

export const loadSettings = (): Settings => read('settings', DEFAULT_SETTINGS);
export const saveSettings = (s: Settings): void => write('settings', s);

export function prefersReducedMotion(s: Settings): boolean {
  if (s.motion !== 'system') return s.motion === 'reduced';
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export interface ReplayData {
  levelId: string;
  blastFreezeMs: number;
  inputs: [number, number][]; // [PIT counts, command index]
}

export interface LevelRecord {
  cleared: boolean;
  /** Points earned in the problem itself, bonuses included. */
  bestPoints: number;
  /** Fewest displayed seconds used. */
  bestSeconds: number | null;
  stars: number;
  plays: number;
  clears: number;
  replay?: ReplayData;
}

export const COMMAND_ORDER: Command[] = ['up', 'down', 'left', 'right', 'select'];

export function loadRecords(): Record<string, LevelRecord> {
  return read<Record<string, LevelRecord>>('records', {});
}
export function saveRecord(id: string, update: (r: LevelRecord) => LevelRecord): LevelRecord {
  const all = loadRecords();
  const cur = all[id] ?? { cleared: false, bestPoints: 0, bestSeconds: null, stars: 0, plays: 0, clears: 0 };
  all[id] = update(cur);
  write('records', all);
  return all[id];
}

export interface HighScore { name: string; score: number; reached: string; date: string }

export function loadHighScores(): HighScore[] {
  return readArray<HighScore>('highscores').sort((a, b) => b.score - a.score).slice(0, 10);
}
export function qualifiesForHighScore(score: number): boolean {
  const list = loadHighScores();
  return score > 0 && (list.length < 10 || score > list[list.length - 1].score);
}
export function addHighScore(entry: HighScore): number {
  const list = [...loadHighScores(), entry].sort((a, b) => b.score - a.score).slice(0, 10);
  write('highscores', list);
  return list.indexOf(entry);
}

export const loadRun = (): Session | null => {
  try {
    const raw = localStorage.getItem(PREFIX + 'run');
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
};
export const saveRun = (s: Session | null): void => {
  if (s === null) {
    try { localStorage.removeItem(PREFIX + 'run'); } catch { /* ignore */ }
  } else write('run', s);
};

export const loadCustomLevels = (): LevelData[] => readArray<LevelData>('custom-levels');
export const saveCustomLevels = (levels: LevelData[]): void => write('custom-levels', levels);
