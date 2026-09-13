import { describe, expect, it } from 'vitest';
import {
  Node, chooseNode, continueAfterTimeUp, createSession, currentLevelIndex, moveTreeCursor, problemCleared,
  requestRetry,
} from '../src/game/session.ts';
import { clockTick, createClock, TICKS_PER_SECOND } from '../src/game/clock.ts';
import { blastPoints, chainBonus, clearBonus, timeBonus } from '../src/game/scoring.ts';

describe('level tree', () => {
  it('starts with every choice of levels 1 to 5 on offer', () => {
    const s = createSession();
    for (let c = 0; c < 7; c++) {
      for (let r = 0; r < 7; r++) {
        expect(s.tree[c][r]).toBe(c < 5 && r <= c ? Node.Offered : Node.Locked);
      }
    }
  });

  it('moves the cursor only between offered choices', () => {
    const s = createSession();
    expect(moveTreeCursor(s, 'up')).toBe(false);
    expect(moveTreeCursor(s, 'right')).toBe(true);
    expect([s.col, s.row]).toEqual([1, 0]);
    expect(moveTreeCursor(s, 'down')).toBe(true);
    expect([s.col, s.row]).toEqual([1, 1]);
    expect(moveTreeCursor(s, 'left')).toBe(true);
    expect([s.col, s.row]).toEqual([0, 0]);
  });

  it('withdraws the other offers on choosing, then offers two neighbours after four problems', () => {
    const s = createSession();
    moveTreeCursor(s, 'right');
    chooseNode(s);
    expect(currentLevelIndex(s)).toBe(4); // level 2, choice 1, problem 1
    expect(s.tree[0][0]).toBe(Node.Locked);
    for (let p = 0; p < 3; p++) expect(problemCleared(s, 0).next).toBe('next');
    expect(currentLevelIndex(s)).toBe(7);
    expect(problemCleared(s, 0).next).toBe('choose');
    expect(s.tree[1][0]).toBe(Node.Done);
    expect(s.tree[2][0]).toBe(Node.Offered);
    expect(s.tree[2][1]).toBe(Node.Offered);
  });

  it('walks level 7 downwards to the bottom-right choice, then wins', () => {
    const s = createSession();
    s.tree = s.tree.map(col => col.map(() => Node.Locked));
    s.col = 6; s.row = 5;
    s.tree[6][5] = Node.Offered;
    chooseNode(s);
    for (let p = 0; p < 4; p++) problemCleared(s, 0);
    expect([s.col, s.row, s.phase]).toEqual([6, 6, 'choosing']);
    chooseNode(s);
    expect(currentLevelIndex(s)).toBe(108);
    for (let p = 0; p < 3; p++) problemCleared(s, 0);
    expect(problemCleared(s, 0).next).toBe('won');
  });

  it('allows two retries per problem, then F4 counts as time up', () => {
    const s = createSession();
    chooseNode(s);
    expect(requestRetry(s)).toBe('retry');
    expect(requestRetry(s)).toBe('retry');
    expect(requestRetry(s)).toBe('timeUp');
  });

  it('continues five times, then the game is over', () => {
    const s = createSession();
    for (let i = 0; i < 5; i++) expect(continueAfterTimeUp(s)).toBe(true);
    expect(continueAfterTimeUp(s)).toBe(false);
    expect(s.phase).toBe('gameOver');
  });
});

describe('clock', () => {
  it('drops a displayed second every 21 BIOS ticks and runs out one second after 0:00', () => {
    const c = createClock(0, 2);
    let ticks = 0;
    while (!clockTick(c)) ticks++;
    expect(ticks + 1).toBe(3 * TICKS_PER_SECOND);
  });
});

describe('scoring', () => {
  it('matches the original tables', () => {
    expect(blastPoints(2)).toBe(100);
    expect(blastPoints(5)).toBe(400);
    expect([3, 4, 5, 6, 9].map(chainBonus)).toEqual([0, 400, 600, 1000, 1000]);
    expect(clearBonus(4, 2)).toBe(4000);
    expect(clearBonus(4, 1)).toBe(0);
    expect(timeBonus(2, 45)).toBe(9000);
  });
});
