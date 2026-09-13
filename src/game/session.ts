// A run through the BRIX level tree (the "campaign" around the problems).
//
// The tree has 7 levels; level n offers n choices, each a set of 4 problems, 112 in all.
// At the start any choice in levels 1-5 may be picked. Picking one withdraws every other
// offer; clearing its fourth problem offers the two neighbouring choices in the next
// level. Level 7 is walked downwards, one choice at a time, to the bottom-right choice.
// See docs/brix-mechanics.md, "The level tree".

import { treeIndex } from '../levels/format.ts';

export const TREE_LEVELS = 7;
export const PROBLEMS_PER_CHOICE = 4;
export const START_CREDITS = 5;
export const RETRIES_PER_PROBLEM = 2;
/** Seconds the tree screen waits before choosing for the player (s309:3291). */
export const TREE_SELECT_SECONDS = 10;

export const Node = { Locked: 0, Offered: 1, Done: 2 } as const;
export type NodeState = (typeof Node)[keyof typeof Node];

export interface Session {
  /** tree[level - 1][choice - 1] */
  tree: NodeState[][];
  /** Tree cursor, 0-based column (level - 1) and row (choice - 1). */
  col: number;
  row: number;
  /** 0..3 within the current choice. */
  problem: number;
  score: number;
  credits: number;
  retriesLeft: number;
  /** True while replaying a problem after F4: the clock carries over and the clear bonus is forfeit. */
  retrying: boolean;
  phase: 'choosing' | 'playing' | 'won' | 'gameOver';
}

export function createSession(): Session {
  const tree: NodeState[][] = [];
  for (let c = 0; c < TREE_LEVELS; c++) tree.push(new Array(TREE_LEVELS).fill(Node.Locked));
  // s309:0390: every choice of levels 1-5 starts on offer
  for (let c = 0; c < 5; c++) for (let r = 0; r <= c; r++) tree[c][r] = Node.Offered;
  return { tree, col: 0, row: 0, problem: 0, score: 0, credits: START_CREDITS, retriesLeft: RETRIES_PER_PROBLEM, retrying: false, phase: 'choosing' };
}

const nodeAt = (s: Session, col: number, row: number): NodeState =>
  col >= 0 && col < TREE_LEVELS && row >= 0 && row < TREE_LEVELS ? s.tree[col][row] : Node.Locked;

export function currentLevelIndex(s: Session): number {
  return treeIndex(s.col + 1, s.row + 1, s.problem + 1);
}

/** Tree cursor movement, exactly as s309:379F-421D allows it. Returns true if the cursor moved. */
export function moveTreeCursor(s: Session, dir: 'up' | 'down' | 'left' | 'right'): boolean {
  if (s.phase !== 'choosing') return false;
  const { col, row } = s;
  switch (dir) {
    case 'up':
      if (row > 0 && nodeAt(s, col, row - 1) === Node.Offered) { s.row--; return true; }
      return false;
    case 'down':
      if (nodeAt(s, col, row + 1) === Node.Offered) { s.row++; return true; }
      return false;
    case 'left':
      if (col === 0) return false;
      if (nodeAt(s, col - 1, row) === Node.Offered || (row > 0 && nodeAt(s, col - 1, row - 1) === Node.Offered)) {
        if (nodeAt(s, col - 1, row) === Node.Locked) s.row--;
        s.col--;
        return true;
      }
      return false;
    case 'right':
      if (col >= TREE_LEVELS - 1) return false;
      if (nodeAt(s, col + 1, row) === Node.Offered || nodeAt(s, col + 1, row + 1) === Node.Offered) {
        if (nodeAt(s, col + 1, row) === Node.Locked) s.row++;
        s.col++;
        return true;
      }
      return false;
  }
}

/** Jump the cursor straight to an offered node (touch / mouse). */
export function pointTreeCursor(s: Session, col: number, row: number): boolean {
  if (s.phase !== 'choosing' || nodeAt(s, col, row) !== Node.Offered) return false;
  s.col = col;
  s.row = row;
  return true;
}

/** Commit to the choice under the cursor. Every other offer is withdrawn. */
export function chooseNode(s: Session): void {
  if (s.phase !== 'choosing' || nodeAt(s, s.col, s.row) !== Node.Offered) return;
  for (let c = 0; c < TREE_LEVELS; c++) for (let r = 0; r < TREE_LEVELS; r++) if (s.tree[c][r] === Node.Offered) s.tree[c][r] = Node.Locked;
  s.tree[s.col][s.row] = Node.Offered;
  s.problem = 0;
  s.retriesLeft = RETRIES_PER_PROBLEM;
  s.retrying = false;
  s.phase = 'playing';
}

export interface ClearResult {
  /** 'next' = play the next problem of the same choice; 'choose' = back to the tree; 'won' = the bottom-right choice is done. */
  next: 'next' | 'choose' | 'won';
}

/** s309:56EF: after a problem is cleared (the score already includes its bonus). */
export function problemCleared(s: Session, finalScore: number): ClearResult {
  s.score = finalScore;
  s.retrying = false;
  s.retriesLeft = RETRIES_PER_PROBLEM;
  if (s.problem < PROBLEMS_PER_CHOICE - 1) {
    s.problem++;
    return { next: 'next' };
  }
  s.tree[s.col][s.row] = Node.Done;
  s.problem = 0;
  s.col++;
  if (s.col === TREE_LEVELS) {
    s.col = TREE_LEVELS - 1;
    s.row++;
    if (s.row > TREE_LEVELS - 1) {
      s.phase = 'won';
      return { next: 'won' };
    }
    s.tree[s.col][s.row] = Node.Offered;
  } else {
    s.tree[s.col][s.row] = Node.Offered;
    if (s.row + 1 < TREE_LEVELS) s.tree[s.col][s.row + 1] = Node.Offered;
  }
  s.phase = 'choosing';
  return { next: 'choose' };
}

/** F4 (s309:3602). With retries left the problem restarts with the clock carried over; otherwise it counts as time up. */
export function requestRetry(s: Session): 'retry' | 'timeUp' {
  if (s.retriesLeft > 0) {
    s.retriesLeft--;
    s.retrying = true;
    return 'retry';
  }
  return 'timeUp';
}

/** Time ran out: spend a credit to replay the problem from scratch, if any are left (s309:531D). */
export function continueAfterTimeUp(s: Session): boolean {
  if (s.credits === 0) {
    s.phase = 'gameOver';
    return false;
  }
  s.credits--;
  s.retriesLeft = RETRIES_PER_PROBLEM;
  s.retrying = false;
  return true;
}

export function giveUp(s: Session): void {
  s.phase = 'gameOver';
}
