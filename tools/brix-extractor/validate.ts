// Validates the modern game's original levels against the original, three ways:
//
//   1. bytes    every canonical JSON level encodes back to its exact LEVELS record
//   2. loader   the original executable's own loader (run in the oracle emulator)
//               produces the same board, cursor, elevator and block counts as the
//               modern engine's createGame()
//   3. shipped  the pack the game loads at runtime equals the per-level canonical files
//
//   node tools/brix-extractor/validate.ts [--skip-oracle]
//
// Output ends with "112 / 112 levels match" or lists every difference.

import fs from 'node:fs';
import path from 'node:path';
import {
  ORIGINAL_LEVEL_COUNT, ORIGINAL_RECORD_SIZE, encodeOriginalRecord, lintLevel, type LevelData,
} from '../../src/levels/format.ts';
import { createGame } from '../../src/game/rules.ts';
import { engineSnapshot, oracleSnapshot, diffSnapshots, type OracleState } from '../brix-oracle/snapshot.ts';
import { Oracle } from '../brix-oracle/oracle.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const gameDir = path.join(root, 'reference/brix100');
const skipOracle = process.argv.includes('--skip-oracle');

const records = new Uint8Array(fs.readFileSync(path.join(gameDir, 'LEVELS')));
const pack = JSON.parse(fs.readFileSync(path.join(root, 'public/levels/original/levels.json'), 'utf8')) as { levels: LevelData[] };
const oracle = skipOracle ? null : new Oracle(gameDir);

let matched = 0;
const failures: string[] = [];

for (let i = 0; i < ORIGINAL_LEVEL_COUNT; i++) {
  const n = i + 1;
  const file = path.join(root, `public/levels/original/level-${String(n).padStart(3, '0')}.json`);
  const problems: string[] = [];
  const level = JSON.parse(fs.readFileSync(file, 'utf8')) as LevelData;

  problems.push(...lintLevel(level));
  if (level.number !== n) problems.push(`number: expected ${n}, actual ${level.number}`);

  // 1. bytes
  const expected = records.subarray(i * ORIGINAL_RECORD_SIZE, n * ORIGINAL_RECORD_SIZE);
  const actual = encodeOriginalRecord(level);
  for (let b = 0; b < ORIGINAL_RECORD_SIZE; b++) {
    if (expected[b] !== actual[b]) {
      const where = b < 168 ? `cell (${b % 14},${Math.floor(b / 14)})` : `metadata byte ${b - 168}`;
      problems.push(`${where}: expected 0x${expected[b].toString(16)}, actual 0x${actual[b].toString(16)}`);
    }
  }

  // 2. the original loader
  if (oracle) {
    const original = oracleSnapshot(oracle.loadProblem(i) as OracleState);
    const modern = engineSnapshot(createGame(level));
    problems.push(...diffSnapshots(original, modern));
    const time = (oracle.state() as { time: [number, number] }).time;
    if (time[0] !== level.timeLimit.minutes || time[1] !== level.timeLimit.seconds) {
      problems.push(`time limit: expected ${time[0]}:${String(time[1]).padStart(2, '0')}, actual ${level.timeLimit.minutes}:${String(level.timeLimit.seconds).padStart(2, '0')}`);
    }
  }

  // 3. shipped pack
  if (JSON.stringify(pack.levels[i]) !== JSON.stringify(level)) problems.push('shipped pack differs from canonical file');

  if (problems.length === 0) matched++;
  else failures.push(`Level ${n} mismatch\n\n${problems.map(p => '  ' + p).join('\n')}\n`);
}

if (pack.levels.length !== ORIGINAL_LEVEL_COUNT) failures.push(`pack holds ${pack.levels.length} levels, expected ${ORIGINAL_LEVEL_COUNT}`);
for (const f of failures) console.log(f);
console.log(`${matched} / ${ORIGINAL_LEVEL_COUNT} levels match${skipOracle ? ' (bytes and pack only; oracle skipped)' : ' (bytes, original loader, shipped pack)'}`);
process.exit(matched === ORIGINAL_LEVEL_COUNT && failures.length === 0 ? 0 : 1);
