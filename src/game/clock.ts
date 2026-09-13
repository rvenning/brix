import type { ClockState } from './types.ts';

// The original clock runs off the BIOS timer interrupt (INT 1Ch, 18.2 Hz). A displayed
// second passes every 21 ticks, so a BRIX "second" is 21 x 54.925 ms = 1.153 s.
export const BIOS_TICK_MS = 65536 / 1193182 * 1000;
export const TICKS_PER_SECOND = 21;

export function createClock(minutes: number, seconds: number): ClockState {
  return { minutes, seconds, subTicks: TICKS_PER_SECOND, running: true };
}

/** One BIOS tick (s309:049F). Returns true when time has run out on this tick. */
export function clockTick(c: ClockState): boolean {
  if (!c.running) return false;
  if (--c.subTicks !== 0) return false;
  c.subTicks = TICKS_PER_SECOND;
  if (c.seconds === 0) {
    if (c.minutes === 0) {
      c.running = false;
      return true;
    }
    c.seconds = 59;
    c.minutes--;
  } else {
    c.seconds--;
  }
  return false;
}

export const secondsLeft = (c: ClockState): number => c.minutes * 60 + c.seconds;
