// Completion fixtures: solutions found by tools/solver, replayed as timed key presses
// through the real scheduler. Each must clear its level with the recorded score.

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LevelData } from '../src/levels/format.ts';
import { COMMAND_ORDER } from '../src/storage/storage.ts';
import { replaySolution } from '../tools/solver/solver.ts';

const root = path.resolve(import.meta.dirname, '..');
const pack = JSON.parse(fs.readFileSync(path.join(root, 'public/levels/original/levels.json'), 'utf8')) as { levels: LevelData[] };
const dir = path.join(root, 'tests/fixtures/solutions');
const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort() : [];

describe('solutions to original levels', () => {
  it('covers every level without an elevator', () => {
    const solved = new Set(files.map(f => Number(/\d+/.exec(f)![0])));
    const staticLevels = pack.levels.filter(l => !l.elevator).map(l => l.number);
    const missing = staticLevels.filter(n => !solved.has(n));
    // levels the solver has not cracked are listed here explicitly, so a regression is visible
    expect(missing).toEqual(KNOWN_UNSOLVED_STATIC.filter(n => !solved.has(n)));
  });

  for (const file of files) {
    const sol = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { level: number; inputs: [number, number][]; blastFreezeMs: number; finalScore: number };
    it(`level ${sol.level} clears with ${sol.finalScore} points`, () => {
      const level = pack.levels[sol.level - 1];
      const result = replaySolution(level, sol.inputs.map(([counts, c]) => ({ counts, command: COMMAND_ORDER[c] })), sol.blastFreezeMs);
      expect(result.status).toBe('cleared');
      expect(result.score).toBe(sol.finalScore);
    });
  }
});

/** Static levels the solver has not found a solution for within its budget. */
const KNOWN_UNSOLVED_STATIC: number[] = [81];
