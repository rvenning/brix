import type { OracleState } from './snapshot.ts';

export const GAME_CS: number;
export function problemCoords(index: number): { col: number; row: number; problem: number };
export const KEYS: Record<'up' | 'down' | 'left' | 'right' | 'space', [number, number]>;

export interface OracleRawEvent {
  type: 'key' | 'fall' | 'elevator' | 'latch';
  key?: number;
  before?: OracleState & { time: [number, number]; retries: number; horizontalFlag: number };
  t?: number;
}

export class Oracle {
  constructor(gameDir: string);
  m: { ms: number; runMs(ms: number): void; screenPng(file: string): void };
  events: OracleRawEvent[] | null;
  ended: number | null;
  bootToTree(): void;
  loadProblem(index: number): OracleState & { time: [number, number]; retries: number };
  startRecording(): void;
  settleToCheckpoint(): OracleState & { time: [number, number]; retries: number };
  state(): OracleState & { time: [number, number]; retries: number };
  press(scan: number, ascii?: number): void;
  runMs(ms: number): void;
}
