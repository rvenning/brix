// Records fresh traces from the emulated original and replays them through the modern rules.
//
//   node tools/brix-oracle/replay-check.ts [levels...] [--ms=20000] [--seed=N]
//
// Prints OK or the first divergence with a readable state diff for each level.

import fs from 'node:fs';
import path from 'node:path';
import type { LevelData } from '../../src/levels/format.ts';
import { getOracle, recordTrace, replayTrace } from './trace.ts';
import { explorer } from './bots.ts';

const root = path.resolve(import.meta.dirname, '../..');
const pack = JSON.parse(fs.readFileSync(path.join(root, 'public/levels/original/levels.json'), 'utf8')) as { levels: LevelData[] };
const args = process.argv.slice(2);
const ms = Number(args.find(a => a.startsWith('--ms='))?.slice(5) ?? 20000);
const seedArg = args.find(a => a.startsWith('--seed='));
const levels = args.filter(a => /^\d+$/.test(a)).map(Number);
const oracle = getOracle(path.join(root, 'reference/brix100'));

let failures = 0;
for (const n of levels.length ? levels : pack.levels.map(l => l.number)) {
  const seed = seedArg ? Number(seedArg.slice(7)) * n : n * 7919;
  const trace = recordTrace(oracle, n - 1, explorer(seed), ms, { fullStates: true });
  const res = replayTrace(pack.levels[n - 1], trace);
  const counts: Record<string, number> = {};
  for (const e of trace.events) counts[e.type] = (counts[e.type] ?? 0) + 1;
  console.log(`level ${n}: ${res.ok ? 'OK' : 'DIVERGED'} events=${trace.events.length} ${JSON.stringify(counts)} ended=${trace.ended} score=${res.state.score}`);
  if (!res.ok) {
    failures++;
    const d = res.divergence!;
    console.log(`  at event ${d.index} (${d.event.type})\n  ${d.diffs.slice(0, 20).join('\n  ')}`);
  }
}
process.exit(failures ? 1 : 0);
