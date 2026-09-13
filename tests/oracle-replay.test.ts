// Replays golden traces recorded from the original BRIX.EXE through the modern rules.
// Every recorded state hash must be reproduced, event by event.
//
// Fixtures come from `npm run record-fixtures`. Set BRIX_ORACLE=1 to also record
// fresh traces from the emulated original during the test run (slower).

import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LevelData } from '../src/levels/format.ts';
import { fixtureToTrace, type Fixture } from '../tools/brix-oracle/fixtures.ts';
import { replayTrace } from '../tools/brix-oracle/trace.ts';

const root = path.resolve(import.meta.dirname, '..');
const pack = JSON.parse(fs.readFileSync(path.join(root, 'public/levels/original/levels.json'), 'utf8')) as { levels: LevelData[] };
const fixtureDir = path.join(root, 'tests/fixtures/original-levels');
const fixtures = fs.existsSync(fixtureDir) ? fs.readdirSync(fixtureDir).filter(f => /^level-\d{3}\.json$/.test(f)).sort() : [];

describe('golden traces of the original game', () => {
  it('has a trace for every original level', () => {
    expect(fixtures.length).toBe(pack.levels.length);
  });

  for (const file of fixtures) {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8')) as Fixture;
    it(`level ${fixture.level} reproduces ${fixture.eventCount} recorded events`, () => {
      const level = pack.levels[fixture.level - 1];
      const result = replayTrace(level, fixtureToTrace(fixture));
      if (!result.ok) {
        const d = result.divergence!;
        expect.fail(`diverged at event ${d.index} (${d.event.type}):\n  ${d.diffs.join('\n  ')}`);
      }
      expect(result.eventsChecked).toBeGreaterThan(0);
    });
  }
});

describe.runIf(process.env.BRIX_ORACLE === '1')('live original (emulated)', async () => {
  const { getOracle, recordTrace } = await import('../tools/brix-oracle/trace.ts');
  const { explorer } = await import('../tools/brix-oracle/bots.ts');
  const oracle = getOracle(path.join(root, 'reference/brix100'));
  for (const n of [3, 10, 45, 88, 98, 109]) {
    it(`level ${n} matches a freshly recorded trace`, () => {
      const trace = recordTrace(oracle, n - 1, explorer(n * 104729), 12000, { fullStates: true });
      const result = replayTrace(pack.levels[n - 1], trace);
      if (!result.ok) expect.fail(`diverged at ${result.divergence!.index}: ${result.divergence!.diffs.join('; ')}`);
    }, 60000);
  }
});
