import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ORIGINAL_LEVEL_COUNT, ORIGINAL_RECORD_SIZE, decodeOriginalRecord, encodeOriginalRecord, lintLevel,
  treeIndex, treePosition, type LevelData,
} from '../src/levels/format.ts';

const root = path.resolve(import.meta.dirname, '..');
const records = new Uint8Array(fs.readFileSync(path.join(root, 'reference/brix100/LEVELS')));
const pack = JSON.parse(fs.readFileSync(path.join(root, 'public/levels/original/levels.json'), 'utf8')) as { levels: LevelData[] };

describe('original level data', () => {
  it('is 112 records of 178 bytes, as BRIX.DOC and the loader say', () => {
    expect(records.length).toBe(ORIGINAL_LEVEL_COUNT * ORIGINAL_RECORD_SIZE);
    expect(pack.levels).toHaveLength(112);
  });

  it('round-trips every record byte for byte', () => {
    for (let i = 0; i < ORIGINAL_LEVEL_COUNT; i++) {
      const rec = records.subarray(i * ORIGINAL_RECORD_SIZE, (i + 1) * ORIGINAL_RECORD_SIZE);
      expect(Array.from(encodeOriginalRecord(decodeOriginalRecord(rec, i)))).toEqual(Array.from(rec));
    }
  });

  it('ships exactly the decoded levels, in file order', () => {
    pack.levels.forEach((level, i) => {
      const rec = records.subarray(i * ORIGINAL_RECORD_SIZE, (i + 1) * ORIGINAL_RECORD_SIZE);
      expect(level).toEqual(decodeOriginalRecord(rec, i));
      expect(lintLevel(level)).toEqual([]);
    });
  });

  it('maps file order onto the tree: level n has n choices of 4 problems', () => {
    expect(treePosition(0)).toEqual({ level: 1, choice: 1, problem: 1 });
    expect(treePosition(4)).toEqual({ level: 2, choice: 1, problem: 1 });
    expect(treePosition(111)).toEqual({ level: 7, choice: 7, problem: 4 });
    for (let i = 0; i < 112; i++) {
      const p = treePosition(i);
      expect(p.choice).toBeLessThanOrEqual(p.level);
      expect(treeIndex(p.level, p.choice, p.problem)).toBe(i);
    }
  });

  it('keeps the facts the data states about itself', () => {
    const withElevator = pack.levels.filter(l => l.elevator);
    expect(withElevator).toHaveLength(75);
    // level 88's elevator sits on an empty cell; the loader places it
    expect(pack.levels[87].elevator).toEqual({ x: 1, y: 10, direction: -1 });
    expect(pack.levels[87].tiles[10][1]).toBe('.');
    // the time limit of the very last problem is 20 seconds
    expect(pack.levels[111].timeLimit).toEqual({ minutes: 0, seconds: 20 });
  });
});
