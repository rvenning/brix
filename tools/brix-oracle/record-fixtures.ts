// Records golden traces of the original game for every level (or the ones given).
//
//   node tools/brix-oracle/record-fixtures.ts [levels...] [--ms=15000]
//
// Each trace is replayed through the modern engine before it is written, so a
// fixture that the engine cannot reproduce is reported instead of committed.

import fs from 'node:fs';
import path from 'node:path';
import type { LevelData } from '../../src/levels/format.ts';
import { getOracle, recordTrace, replayTrace } from './trace.ts';
import { explorer } from './bots.ts';
import { traceToFixture, fixtureToTrace } from './fixtures.ts';

const root = path.resolve(import.meta.dirname, '../..');
const outDir = path.join(root, 'tests/fixtures/original-levels');
const pack = JSON.parse(fs.readFileSync(path.join(root, 'public/levels/original/levels.json'), 'utf8')) as { levels: LevelData[] };

const args = process.argv.slice(2);
const ms = Number(args.find(a => a.startsWith('--ms='))?.slice(5) ?? 15000);
const levels = args.filter(a => /^\d+$/.test(a)).map(Number);
const which = levels.length ? levels : pack.levels.map(l => l.number);

fs.mkdirSync(outDir, { recursive: true });
const oracle = getOracle(path.join(root, 'reference/brix100'));
let failed = 0;
for (const n of which) {
  const level = pack.levels[n - 1];
  const seed = n * 7919;
  const trace = recordTrace(oracle, n - 1, explorer(seed), ms);
  const fixture = traceToFixture(trace, level.id, { controller: 'explorer', seed, emulatedMs: trace.emulatedMs },
    'The original BRIX.EXE driven by a seeded explorer bot. Replaying these events through the modern rules must reproduce every state hash.');
  const result = replayTrace(level, fixtureToTrace(fixture));
  if (!result.ok) {
    failed++;
    console.log(`level ${n}: NOT WRITTEN, engine diverges at event ${result.divergence!.index}:\n  ${result.divergence!.diffs.join('\n  ')}`);
    continue;
  }
  const file = path.join(outDir, `level-${String(n).padStart(3, '0')}.json`);
  fs.writeFileSync(file, JSON.stringify(fixture, null, 1) + '\n');
  console.log(`level ${n}: ${fixture.eventCount} events, ${result.eventsChecked} checked, ended=${fixture.ended}, ${(fs.statSync(file).size / 1024).toFixed(1)} KB`);
}
process.exit(failed ? 1 : 0);
