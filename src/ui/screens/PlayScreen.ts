import { Play } from '../../game/Play.ts';
import { Command, type ClockState, type GameEvent } from '../../game/types.ts';
import { peek } from '../../game/rules.ts';
import { secondsLeft } from '../../game/clock.ts';
import { ORIGINAL_BLAST_FREEZE_MS } from '../../game/simulation.ts';
import { isBlock, type LevelData } from '../../levels/format.ts';
import { BoardRenderer } from '../../rendering/BoardRenderer.ts';
import { Effects } from '../../rendering/effects.ts';
import { blockIcon } from '../../rendering/thumbnails.ts';
import { audio } from '../../audio/audio.ts';
import { h, svgIcon, formatScore, formatClock, focusFirst } from '../dom.ts';
import type { App, Screen } from '../App.ts';
import { COMMAND_ORDER, type ReplayData } from '../../storage/storage.ts';

export const MODERN_BLAST_FREEZE_MS = 760;

export type PlayMode = 'run' | 'practice' | 'test' | 'replay';

export interface PlayScreenOptions {
  mode: PlayMode;
  score?: number;
  clock?: ClockState;
  retriesLeft?: number;
  /** Recorded inputs to play back (mode 'replay'). */
  replay?: ReplayData;
  /** Shown above the board, e.g. "Level 3 · Choice 2 · Problem 1 of 4". */
  where: string;
  onCleared(result: ClearedResult): void;
  onTimeUp(): void;
  onRetry(clock: ClockState, score: number): void;
  onQuit(): void;
}

export interface ClearedResult {
  levelId: string;
  pointsBeforeBonus: number;
  clearBonus: number;
  timeBonus: number;
  finalScore: number;
  secondsUsed: number;
  secondsLeft: number;
  stars: number;
  retried: boolean;
  inputs: Play['inputs'];
  blastFreezeMs: number;
}

const KEYMAP: Record<string, Command> = {
  ArrowUp: Command.Up, ArrowDown: Command.Down, ArrowLeft: Command.Left, ArrowRight: Command.Right,
  KeyW: Command.Up, KeyS: Command.Down, KeyA: Command.Left, KeyD: Command.Right,
  Space: Command.Select, Enter: Command.Select, NumpadEnter: Command.Select,
};

export class PlayScreen implements Screen {
  readonly el: HTMLElement;
  private readonly app: App;
  private readonly opts: PlayScreenOptions;
  readonly play: Play;
  private readonly renderer: BoardRenderer;
  private readonly fx = new Effects();
  private readonly startScore: number;
  private readonly blastFreezeMs: number;
  private introUntil = 0;
  private overlay: HTMLElement | null = null;
  private ended = false;
  private endAt = 0;
  private hud: {
    score: HTMLElement; time: HTMLElement; timeStat: HTMLElement; scoreStat: HTMLElement;
    legend: Map<number, { item: HTMLElement; count: HTMLElement }>; pips: HTMLElement; announce: HTMLElement;
  };
  private shownScore = -1;
  private shownTime = '';
  private shownCounts = '';
  private lastSecond = -1;
  private drag: { pointerId: number; column: number; wasHeld: boolean; moved: boolean } | null = null;
  private pendingBlockedCheck: Command | null = null;
  private landSoundAt = 0;
  private readonly limitSeconds: number;
  private readonly boardWrap: HTMLElement;
  private readonly bounds: ReturnType<typeof BoardRenderer.playfieldBounds>;

  constructor(app: App, level: LevelData, opts: PlayScreenOptions) {
    this.app = app;
    this.opts = opts;
    // a replay must run with the blast freeze it was recorded with, or its inputs land at other moments
    this.blastFreezeMs = opts.replay?.blastFreezeMs ?? (app.settings.classicBlastTiming ? ORIGINAL_BLAST_FREEZE_MS : MODERN_BLAST_FREEZE_MS);
    this.play = new Play(level, { blastFreezeMs: this.blastFreezeMs, score: opts.score, clock: opts.clock, retriesLeft: opts.retriesLeft });
    if (opts.replay) this.play.startReplay(opts.replay.inputs.map(([counts, c]) => ({ counts, command: COMMAND_ORDER[c] })));
    this.startScore = this.play.state.score;
    this.bounds = BoardRenderer.playfieldBounds(level.tiles);
    this.limitSeconds = Math.max(1, level.timeLimit.minutes * 60 + level.timeLimit.seconds);
    this.fx.reducedMotion = app.reducedMotion;

    const canvas = h('canvas', { class: 'board', role: 'img', 'aria-label': 'Puzzle board' });
    this.renderer = new BoardRenderer(canvas);
    this.boardWrap = h('div', { class: 'board-wrap' }, canvas);

    const legend = h('div', { class: 'legend', 'aria-label': 'Blocks left' });
    const legendMap = new Map<number, { item: HTMLElement; count: HTMLElement }>();
    for (let t = 1; t <= 8; t++) {
      const count = h('span', {}, '0');
      const item = h('div', { class: 'legend-item', title: '' }, h('img', { src: blockIcon(t), alt: '' }), count);
      legendMap.set(t, { item, count });
      legend.append(item);
    }
    const score = h('span', { class: 'stat-value' }, '0');
    const time = h('span', { class: 'stat-value' }, '0:00');
    const scoreStat = h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Score'), score);
    const timeStat = h('div', { class: 'stat time' }, h('span', { class: 'stat-label' }, 'Time'), time);
    const pips = h('div', { class: 'pips', title: 'Retries left (R)' });
    const announce = h('div', { class: 'sr-only', 'aria-live': 'polite' });

    const pauseBtn = h('button', { class: 'btn icon', 'aria-label': 'Pause', html: svgIcon('pause'), onclick: () => this.pause() });
    const retryBtn = h('button', { class: 'btn icon', 'aria-label': 'Retry problem', html: svgIcon('retry'), onclick: () => this.retry() });

    this.el = h('div', { class: 'play' },
      h('header', { class: 'hud hud-top' },
        h('div', { class: 'hud' }, pauseBtn, h('span', { class: 'hud-brand', 'aria-hidden': 'true' }, 'BRIX')),
        h('div', { class: 'hud-where', html: opts.where }),
        h('div', { class: 'hud' }, retryBtn),
      ),
      this.boardWrap,
      h('footer', { class: 'hud hud-bottom' },
        h('div', { class: 'play-stats' }, scoreStat, timeStat),
        legend,
        pips,
      ),
      announce,
    );
    this.hud = { score, time, timeStat, scoreStat, legend: legendMap, pips, announce };

    canvas.addEventListener('pointerdown', e => this.onPointerDown(e));
    canvas.addEventListener('pointermove', e => this.onPointerMove(e));
    canvas.addEventListener('pointerup', e => this.onPointerUp(e));
    canvas.addEventListener('pointercancel', e => this.onPointerUp(e));
    canvas.addEventListener('contextmenu', e => e.preventDefault());

    this.showIntro(level);
    this.updateHud(true);
  }

  private showIntro(level: LevelData): void {
    this.introUntil = performance.now() + (this.app.reducedMotion ? 350 : 1000);
    const card = h('div', { class: 'overlay', style: 'background: transparent' },
      h('div', { class: 'intro-card' },
        h('div', { class: 'kicker' }, this.opts.mode === 'test' ? 'Test play' : this.opts.mode === 'replay' ? 'Replay' : 'Get ready'),
        h('div', { class: 'big' }, level.tree ? `${level.tree.level}-${level.tree.choice}-${level.tree.problem}` : (level.name ?? 'Custom')),
      ));
    this.boardWrap.append(card);
    window.setTimeout(() => card.remove(), this.app.reducedMotion ? 350 : 1100);
    this.hud.announce.textContent = `Problem ${level.tree ? `${level.tree.level}-${level.tree.choice}-${level.tree.problem}` : ''} starts.`;
  }

  // ---------------------------------------------------------------- loop

  frame(now: number, dt: number): void {
    const state = this.play.state;
    this.renderer.layout(state.width, state.height, this.bounds);
    const running = !this.overlay && now >= this.introUntil && !this.ended;
    if (running && !this.play.paused) {
      this.play.update(Math.min(dt, 100));
      if (this.pendingBlockedCheck) {
        if (state.latched === this.pendingBlockedCheck && state.falling.length === 0 && !this.play.sim.frozen) audio.blocked();
        this.pendingBlockedCheck = null;
      }
    }
    this.handleEvents(this.play.drainEvents(), now);
    this.fx.update(now);

    const machine = this.app.machine;
    if (!this.ended) {
      if (machine.state === 'PLAYING' && this.play.sim.frozen) machine.go('ANIMATING');
      else if (machine.state === 'ANIMATING' && !this.play.sim.frozen) machine.go('PLAYING');
    }

    if (this.ended && now >= this.endAt && !this.overlay) {
      if (state.status === 'cleared') this.opts.onCleared(this.clearedResult());
      else if (state.status === 'timeUp') this.opts.onTimeUp();
      this.endAt = Infinity;
    }

    this.renderer.render(this.play, this.fx, now, { reducedMotion: this.app.reducedMotion, debug: this.app.debug });
    this.updateHud(false);
    if (this.app.debug) this.app.setDebug(this.debugText(now));
  }

  private handleEvents(events: GameEvent[], now: number): void {
    for (const ev of events) {
      switch (ev.type) {
        case 'cursorMoved': audio.move(); break;
        case 'blockMoved': audio.push(); break;
        case 'pickedUp': audio.pick(); break;
        case 'putDown': audio.drop(); break;
        case 'landed':
          if (now - this.landSoundAt > 60) { audio.land(); this.landSoundAt = now; }
          break;
        case 'blast': {
          const freeze = this.play.state.status === 'playing' ? this.blastFreezeMs : Math.min(this.blastFreezeMs, 900);
          this.fx.blast(ev.cells, now, freeze, ev.points, ev.bonus, ev.chain);
          audio.charge(ev.chain);
          audio.blast(ev.chain, freeze / 2000);
          if (ev.bonus) audio.bonus(freeze / 2000 + 0.12);
          this.hud.announce.textContent = `${ev.cells.length} blocks cleared. ${ev.bonus ? `Chain bonus ${ev.bonus}.` : ''}`;
          window.setTimeout(() => this.bump(this.hud.scoreStat), freeze / 2);
          break;
        }
        case 'cleared':
          this.lastCleared = ev;
          this.ended = true;
          this.endAt = now + (this.fx.blasts.length ? this.blastFreezeMs : 300);
          window.setTimeout(() => audio.clear(), Math.max(0, this.endAt - now - 150));
          break;
        case 'timeUp':
          this.ended = true;
          this.endAt = now + 500;
          audio.timeUp();
          this.hud.announce.textContent = 'Time is up.';
          break;
      }
    }
  }

  private bump(el: HTMLElement): void {
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  private updateHud(force: boolean): void {
    const s = this.play.state;
    const hideBonus = s.status === 'cleared';
    const score = hideBonus ? this.clearedResult().pointsBeforeBonus + this.startScore : s.score;
    if (force || score !== this.shownScore) {
      this.hud.score.textContent = formatScore(score);
      this.shownScore = score;
    }
    const time = formatClock(s.clock.minutes, s.clock.seconds);
    if (force || time !== this.shownTime) {
      this.hud.time.textContent = time;
      this.shownTime = time;
      const left = secondsLeft(s.clock);
      this.hud.timeStat.classList.toggle('warn', left <= 15 && s.status === 'playing');
      if (left !== this.lastSecond && left <= 10 && s.status === 'playing' && this.lastSecond !== -1) audio.warning();
      this.lastSecond = left;
      audio.setIntensity(1 - left / this.limitSeconds);
    }
    const counts = s.counts.slice(1).join(',');
    if (force || counts !== this.shownCounts) {
      this.shownCounts = counts;
      for (let t = 1; t <= 8; t++) {
        const entry = this.hud.legend.get(t)!;
        const n = s.counts[t];
        entry.count.textContent = String(n);
        const presentAtStart = this.play.level.tiles.some(r => r.includes(String(t)));
        entry.item.hidden = !presentAtStart;
        entry.item.classList.toggle('gone', n === 0);
      }
    }
    if (force) {
      this.hud.pips.replaceChildren(h('span', {}, 'Retries'), ...[0, 1].map(i => h('span', { class: `pip${i < s.retriesLeft ? '' : ' off'}` })));
    }
  }

  private clearedResult(): ClearedResult {
    const s = this.play.state;
    const c = this.lastCleared ?? { clearBonus: 0, timeBonus: 0, bonus: 0 };
    const left = secondsLeft(s.clock);
    const fraction = left / this.limitSeconds;
    const retried = s.retriesLeft < 2;
    const stars = !retried && fraction >= 0.4 ? 3 : fraction >= 0.15 ? 2 : 1;
    return {
      levelId: this.play.level.id,
      pointsBeforeBonus: s.score - this.startScore - c.bonus,
      clearBonus: c.clearBonus,
      timeBonus: c.timeBonus,
      finalScore: s.score,
      secondsUsed: this.limitSeconds - left,
      secondsLeft: left,
      stars,
      retried,
      inputs: this.play.inputs,
      blastFreezeMs: this.blastFreezeMs,
    };
  }
  private lastCleared: { clearBonus: number; timeBonus: number; bonus: number } | null = null;

  // ---------------------------------------------------------------- input

  onKey(e: KeyboardEvent): boolean {
    if (this.overlay) return false;
    if (e.code === 'Escape' || e.code === 'KeyP') { this.pause(); return true; }
    if (e.code === 'KeyR' || e.code === 'F4') { this.retry(); return true; }
    const cmd = KEYMAP[e.code];
    if (!cmd || this.ended) return false;
    audio.unlock();
    this.play.press(cmd);
    this.pendingBlockedCheck = cmd;
    return true;
  }

  private onPointerDown(e: PointerEvent): void {
    if (this.overlay || this.ended) return;
    audio.unlock();
    const cell = this.renderer.cellAt(e.clientX, e.clientY);
    if (!cell) return;
    const s = this.play.state;
    (e.target as Element).setPointerCapture(e.pointerId);
    const onCursor = cell.x === s.cursor.x && cell.y === s.cursor.y;
    if (s.carrying && onCursor) {
      this.drag = { pointerId: e.pointerId, column: cell.x, wasHeld: true, moved: false };
      return;
    }
    if (isBlock(peek(s, cell.x, cell.y))) {
      if (this.play.goTo(cell, true)) this.drag = { pointerId: e.pointerId, column: cell.x, wasHeld: false, moved: false };
      return;
    }
    // holding a block and tapping along its row pushes it that way
    if (s.carrying && cell.y === s.cursor.y) {
      const dir = cell.x > s.cursor.x ? Command.Right : Command.Left;
      this.play.enqueue(new Array(Math.abs(cell.x - s.cursor.x)).fill(dir));
      return;
    }
    this.play.goTo(cell);
  }

  private onPointerMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    const col = Math.floor(this.renderer.columnAt(e.clientX));
    const pushes: Command[] = [];
    while (d.column !== col) {
      const dir = col > d.column ? 1 : -1;
      pushes.push(dir > 0 ? Command.Right : Command.Left);
      d.column += dir;
    }
    if (pushes.length) {
      d.moved = true;
      this.play.enqueue(pushes, false);
    }
  }

  private onPointerUp(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.pointerId !== e.pointerId) return;
    this.drag = null;
    // a drag puts the block down once its pushes have happened; tapping a held block puts it down;
    // tapping a loose block picks it up and leaves it held
    if (d.moved || d.wasHeld) this.play.enqueue([Command.Select], false);
  }

  // ---------------------------------------------------------------- flow

  pause(): void {
    if (this.overlay || this.ended) return;
    audio.ui();
    this.play.paused = true;
    if (this.app.machine.state === 'ANIMATING') this.app.machine.go('PLAYING');
    this.app.machine.go('PAUSED');
    const s = this.play.state;
    const canRetry = this.opts.mode !== 'run' || s.retriesLeft > 0;
    this.showDialog(h('div', { class: 'dialog panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Paused' },
      h('h2', {}, 'Paused'),
      h('p', {}, this.opts.mode === 'run' ? `${s.retriesLeft} ${s.retriesLeft === 1 ? 'retry' : 'retries'} left for this problem. Retrying keeps the clock running and forfeits the clear bonus.` : 'Take a breather.'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn primary big', autofocus: true, onclick: () => this.resume() }, 'Resume'),
        h('button', { class: 'btn', disabled: !canRetry, onclick: () => { this.closeOverlay(); this.retry(true); } }, this.opts.mode === 'run' ? 'Retry problem' : 'Restart'),
        h('button', { class: 'btn ghost', onclick: () => { this.closeOverlay(); this.opts.onQuit(); } }, this.opts.mode === 'test' ? 'Back to editor' : 'Quit'),
      )));
  }

  resume(): void {
    audio.ui();
    this.closeOverlay();
    this.play.paused = false;
    this.app.machine.go('PLAYING');
  }

  private retry(fromPause = false): void {
    if (this.ended || this.opts.mode === 'replay') return;
    const s = this.play.state;
    if (this.opts.mode === 'run' && s.retriesLeft === 0 && !fromPause) return;
    audio.ui();
    this.opts.onRetry({ ...s.clock }, s.score);
  }

  showDialog(content: HTMLElement): void {
    this.closeOverlay();
    this.overlay = h('div', { class: 'overlay' }, content);
    this.boardWrap.parentElement!.append(this.overlay);
    focusFirst(this.overlay);
  }

  closeOverlay(): void {
    this.overlay?.remove();
    this.overlay = null;
  }

  onHidden(): void {
    if (!this.overlay && !this.ended && this.app.machine.state !== 'PAUSED') this.pause();
  }

  private debugText(now: number): string {
    const s = this.play.state, sim = this.play.sim;
    return [
      `state   ${this.app.machine.state}`,
      `level   ${this.play.level.id}`,
      `fps     ${this.app.fps.toFixed(0)}`,
      `t       ${sim.elapsedMs.toFixed(0)} ms  passes ${sim.passes}`,
      `cursor  ${s.cursor.x},${s.cursor.y}  carry ${+s.carrying} ride ${+s.riding} fallw ${+s.cursorFalling}`,
      `latched ${s.latched ?? '-'}  queue ${this.play.queued.join(' ') || '-'}`,
      `falling ${s.falling.map(f => `${f.x},${f.y}`).join(' ') || '-'}  off ${s.fallOffset}`,
      `elev    ${s.elevator ? `${s.elevator.x},${s.elevator.y} st ${s.elevator.stack} off ${s.elevator.offset} dir ${s.elevator.dir} p ${s.elevator.pause}` : '-'}`,
      `chain   ${s.chain}  remaining ${s.remaining}  score ${s.score}`,
      `clock   ${formatClock(s.clock.minutes, s.clock.seconds)} sub ${s.clock.subTicks}  frozen ${+sim.frozen}`,
      `fx      ${this.fx.busy ? 'busy' : 'idle'} ${now.toFixed(0)}`,
    ].join('\n');
  }

  destroy(): void {
    this.closeOverlay();
    this.app.setDebug(null);
  }
}
