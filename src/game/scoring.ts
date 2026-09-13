// Scoring, kept apart from the rules so a modern scoring scheme can replace it.
// Every number here is taken from BRIX 1.00 (see docs/brix-mechanics.md, "Scoring").

/** s309:4B0E: a blast of n listed cells scores (n - 1) x 100. */
export function blastPoints(listed: number): number {
  return (listed - 1) * 100;
}

/**
 * s309:4B29: once more than three blocks have gone since the player last moved a block,
 * every further blast adds a bonus keyed to that running total.
 */
export function chainBonus(chain: number): number {
  if (chain <= 3) return 0;
  if (chain === 4) return 400;
  if (chain === 5) return 600;
  return 1000;
}

/** s309:54BE: clearing without using a retry (F4) is worth 1000 per tree level. */
export function clearBonus(levelNumber: number, retriesLeft: number): number {
  return retriesLeft === 2 ? levelNumber * 1000 : 0;
}

/** s309:559F: every whole second left on the clock is worth 100 per tree level. */
export function timeBonus(levelNumber: number, secondsLeft: number): number {
  return secondsLeft * levelNumber * 100;
}
