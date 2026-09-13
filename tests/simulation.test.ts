import { describe, expect, it } from 'vitest';
import { Simulation } from '../src/game/simulation.ts';
import { Command } from '../src/game/types.ts';
import { game, picture } from './helpers.ts';

describe('simulation', () => {
  it('runs fall and elevator steps at the original rates', () => {
    const s = game([
      '#####',
      '#.=5#',
      '#.==#',
      '#.=5#',
      '#E==#',
      '#####',
    ], { elevator: [1, 4, -1] });
    const sim = new Simulation(s);
    let falls = 0, elevators = 0;
    // count by watching the elevator offset change over one second of pure motion
    const before = { ...s.elevator! };
    sim.advance(1000);
    elevators = Math.abs(s.elevator!.y - before.y) * 16 + Math.abs(s.elevator!.offset) + s.elevator!.pause;
    falls = sim.passes;
    // the original's emulated loop runs ~39.5 elevator steps a second
    expect(elevators).toBeGreaterThan(35);
    expect(elevators).toBeLessThan(45);
    expect(falls).toBeGreaterThan(1900);
  });

  it('is deterministic whatever the frame size', () => {
    const rows = [
      '#######',
      '#1....#',
      '#=..2.#',
      '#=.12=#',
      '#######',
    ];
    const run = (frame: number) => {
      const s = game(rows, { cursor: [1, 1] });
      const sim = new Simulation(s, { blastFreezeMs: 300 });
      const script: [number, Command][] = [[100, Command.Select], [300, Command.Right], [500, Command.Right], [1600, Command.Select]];
      let t = 0;
      for (const [at, cmd] of script) {
        while (t + frame <= at) { sim.advance(frame); t += frame; }
        sim.advance(at - t); t = at;
        sim.press(cmd);
      }
      sim.advance(4000);
      return { board: picture(s), score: s.score, status: s.status, clock: { ...s.clock } };
    };
    const a = run(16.67), b = run(5), c = run(33.3);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    expect(a.score).toBeGreaterThan(0);
  });

  it('freezes the clock while a blast plays', () => {
    const s = game(['######', '#11.3#', '#=3==#', '######'], { time: [1, 0] });
    const sim = new Simulation(s, { blastFreezeMs: 5000 });
    sim.advance(50);
    expect(sim.frozen).toBe(true);
    const clock = { ...s.clock };
    sim.advance(4000);
    expect(s.clock).toEqual(clock);
    sim.advance(2000);
    expect(sim.frozen).toBe(false);
  });
});
