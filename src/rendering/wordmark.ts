// The BRIX wordmark: each letter is built from rounded blocks on a 3x5 grid,
// one block type per letter, drawn with the same sprites as the game.

import { SpriteSet } from './sprites.ts';

const LETTERS: Record<string, string[]> = {
  B: ['##.', '#.#', '##.', '#.#', '##.'],
  R: ['##.', '#.#', '##.', '#.#', '#.#'],
  I: ['###', '.#.', '.#.', '.#.', '###'],
  X: ['#.#', '#.#', '.#.', '#.#', '#.#'],
};

export function drawWordmark(word = 'BRIX', types = [1, 3, 4, 5], cell = 44): HTMLCanvasElement {
  const gap = 1;
  const cols = word.length * 3 + (word.length - 1) * gap;
  const c = document.createElement('canvas');
  c.width = cols * cell;
  c.height = 5 * cell;
  const ctx = c.getContext('2d')!;
  const sprites = new SpriteSet(cell);
  [...word].forEach((ch, i) => {
    const rows = LETTERS[ch];
    if (!rows) return;
    const ox = i * (3 + gap) * cell;
    rows.forEach((row, y) => [...row].forEach((v, x) => {
      if (v === '#') ctx.drawImage(sprites.block(types[i % types.length]), ox + x * cell, y * cell);
    }));
  });
  return c;
}
