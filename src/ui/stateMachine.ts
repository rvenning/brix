// The application's explicit state machine. One state at a time; every change goes
// through go(), which rejects transitions that are not listed here.

export type AppState =
  | 'TITLE'
  | 'LEVEL_SELECT' // the level tree of a run
  | 'LEVEL_BROWSER' // practice: any unlocked problem
  | 'PLAYING'
  | 'ANIMATING' // a blast is playing; the rules are frozen
  | 'PAUSED'
  | 'LEVEL_COMPLETE'
  | 'LEVEL_FAILED'
  | 'GAME_OVER'
  | 'VICTORY'
  | 'HIGH_SCORES'
  | 'SETTINGS'
  | 'HELP'
  | 'EDITOR';

const MENUS: AppState[] = ['TITLE', 'LEVEL_BROWSER', 'HIGH_SCORES', 'SETTINGS', 'HELP', 'EDITOR'];

const TRANSITIONS: Record<AppState, AppState[]> = {
  TITLE: ['LEVEL_SELECT', 'LEVEL_BROWSER', 'HIGH_SCORES', 'SETTINGS', 'HELP', 'EDITOR', 'PLAYING'],
  LEVEL_SELECT: ['PLAYING', 'TITLE', 'SETTINGS'],
  LEVEL_BROWSER: ['PLAYING', 'TITLE', 'EDITOR'],
  PLAYING: ['ANIMATING', 'PAUSED', 'LEVEL_COMPLETE', 'LEVEL_FAILED', 'PLAYING', 'TITLE', 'EDITOR', 'LEVEL_BROWSER'],
  ANIMATING: ['PLAYING', 'PAUSED', 'LEVEL_COMPLETE', 'LEVEL_FAILED'],
  PAUSED: ['PLAYING', 'ANIMATING', 'TITLE', 'LEVEL_BROWSER', 'EDITOR', 'LEVEL_FAILED', 'SETTINGS'],
  LEVEL_COMPLETE: ['PLAYING', 'LEVEL_SELECT', 'LEVEL_BROWSER', 'VICTORY', 'TITLE', 'EDITOR'],
  LEVEL_FAILED: ['PLAYING', 'GAME_OVER', 'LEVEL_BROWSER', 'TITLE', 'EDITOR'],
  GAME_OVER: ['HIGH_SCORES', 'TITLE'],
  VICTORY: ['HIGH_SCORES', 'TITLE'],
  HIGH_SCORES: ['TITLE'],
  SETTINGS: [...MENUS, 'PAUSED', 'LEVEL_SELECT'],
  HELP: ['TITLE'],
  EDITOR: ['PLAYING', 'TITLE', 'LEVEL_BROWSER'],
};

export class StateMachine {
  private current: AppState = 'TITLE';
  private listeners: ((to: AppState, from: AppState) => void)[] = [];

  get state(): AppState {
    return this.current;
  }

  can(to: AppState): boolean {
    return TRANSITIONS[this.current].includes(to);
  }

  go(to: AppState): void {
    if (to === this.current && to !== 'PLAYING') return;
    if (!this.can(to)) throw new Error(`invalid state transition ${this.current} -> ${to}`);
    const from = this.current;
    this.current = to;
    for (const l of this.listeners) l(to, from);
  }

  onChange(fn: (to: AppState, from: AppState) => void): void {
    this.listeners.push(fn);
  }
}
