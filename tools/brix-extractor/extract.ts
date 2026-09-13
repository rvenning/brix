// Extracts the 112 original BRIX levels from the LEVELS data file into canonical JSON.
//
//   node tools/brix-extractor/extract.ts [path/to/brix100]
//
// Writes one file per level to public/levels/original/ plus a pack the game loads
// at runtime (public/levels/original/levels.json). The game never runs this tool.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ORIGINAL_LEVEL_COUNT, ORIGINAL_RECORD_SIZE, decodeOriginalRecord, encodeOriginalRecord,
} from '../../src/levels/format.ts';

const root = path.resolve(import.meta.dirname, '../..');
const gameDir = path.resolve(process.argv[2] ?? path.join(root, 'reference/brix100'));
const outDir = path.join(root, 'public/levels/original');

const levelsFile = fs.readdirSync(gameDir).find(f => f.toLowerCase() === 'levels');
if (!levelsFile) throw new Error(`no LEVELS file in ${gameDir}`);
const data = new Uint8Array(fs.readFileSync(path.join(gameDir, levelsFile)));

// The executable loads exactly 0x70 records of 0xB2 bytes (s309:029B), so the file size is a fact, not a guess.
if (data.length !== ORIGINAL_LEVEL_COUNT * ORIGINAL_RECORD_SIZE) {
  throw new Error(`LEVELS is ${data.length} bytes; expected ${ORIGINAL_LEVEL_COUNT} x ${ORIGINAL_RECORD_SIZE}`);
}

fs.mkdirSync(outDir, { recursive: true });
const levels = [];
for (let i = 0; i < ORIGINAL_LEVEL_COUNT; i++) {
  const record = data.subarray(i * ORIGINAL_RECORD_SIZE, (i + 1) * ORIGINAL_RECORD_SIZE);
  const level = decodeOriginalRecord(record, i);
  const back = encodeOriginalRecord(level);
  if (Buffer.compare(Buffer.from(back), Buffer.from(record)) !== 0) throw new Error(`level ${i + 1} does not round-trip`);
  levels.push(level);
  fs.writeFileSync(path.join(outDir, `level-${String(i + 1).padStart(3, '0')}.json`), stringifyLevel(level) + '\n');
}

const sha256 = crypto.createHash('sha256').update(data).digest('hex');
const pack = { format: 'brix-level-pack/1', name: 'BRIX 1.00 original levels', source: { file: 'LEVELS', bytes: data.length, sha256 }, levels };
fs.writeFileSync(path.join(outDir, 'levels.json'), JSON.stringify(pack) + '\n');
console.log(`extracted ${levels.length} levels from ${path.join(gameDir, levelsFile)} (sha256 ${sha256.slice(0, 16)}...)`);

// Keep tile rows on one line each so a level reads like a picture in a diff.
function stringifyLevel(level: object): string {
  return JSON.stringify(level, null, 2).replace(/"tiles": \[([^\]]*)\]/, (_, body: string) =>
    `"tiles": [\n${body.trim().split(/,\s*/).map(s => '    ' + s.trim()).join(',\n')}\n  ]`);
}
