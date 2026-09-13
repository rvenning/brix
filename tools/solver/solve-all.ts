// Solves original levels with the modern engine and writes replayable solution fixtures.
//
//   node tools/solver/solve-all.ts [levels...] [--nodes=N] [--ms=N]

import fs from 'node:fs';
import path from 'node:path';
import type { LevelData } from '../../src/levels/format.ts';
import { COMMAND_ORDER } from '../../src/storage/storage.ts';
import { solve, replaySolution } from './solver.ts';

const root = path.resolve(import.meta.dirname, '../..');
const outDir = path.join(root, 'tests/fixtures/solutions');
const pack = JSON.parse(fs.readFileSync(path.join(root, 'public/levels/original/levels.json'), 'utf8')) as { levels: LevelData[] };
const args = process.argv.slice(2);
const nodes = Number(args.find(a => a.startsWith('--nodes='))?.slice(8) ?? 150000);
const ms = Number(args.find(a => a.startsWith('--ms='))?.slice(5) ?? 180000);
const only = args.filter(a => /^\d+$/.test(a)).map(Number);
const BLAST = 1470;

fs.mkdirSync(outDir, { recursive: true });
for (const level of pack.levels) {
  if (only.length && !only.includes(level.number)) continue;
  const file = path.join(outDir, `level-${String(level.number).padStart(3, '0')}.json`);
  if (args.includes('--skip-existing') && fs.existsSync(file)) continue;
  const t0 = Date.now();
  const sol = solve(level, { maxNodes: nodes, maxMs: ms, blastFreezeMs: BLAST, fineFallback: args.includes('--fine') });
  if (!sol) {
    console.log(`level ${level.number}: unsolved (${((Date.now() - t0) / 1000).toFixed(1)} s)${level.elevator ? ' [elevator]' : ''}`);
    continue;
  }
  const replay = replaySolution(level, sol.inputs, BLAST);
  if (replay.status !== 'cleared') {
    console.log(`level ${level.number}: solution did not replay (${replay.status})`);
    continue;
  }
  const fixture = {
    format: 'brix-solution/1',
    level: level.number,
    levelId: level.id,
    description: 'Found by tools/solver against the modern engine; replays to a clear through the real scheduler.',
    blastFreezeMs: BLAST,
    moves: sol.actions.map(a => (a.kind === 'wait' ? 'wait' : `${a.x},${a.y}${a.dir < 0 ? 'L' : 'R'}${a.cells > 1 ? a.cells : ''}${a.at ? `@${a.at.y},${a.at.offset},${a.at.dir},${a.at.pause}` : ''}`)).join(' '),
    inputs: sol.inputs.map(i => [i.counts, COMMAND_ORDER.indexOf(i.command)]),
    clearedAtCounts: replay.counts,
    finalScore: replay.score,
  };
  fs.writeFileSync(file, JSON.stringify(fixture) + '\n');
  console.log(`level ${level.number}: ${sol.actions.length} moves, ${sol.nodesExpanded} nodes, ${((Date.now() - t0) / 1000).toFixed(1)} s, score ${replay.score}${level.elevator ? ' [elevator]' : ''}`);
}
