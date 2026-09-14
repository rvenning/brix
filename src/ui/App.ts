import type { LevelData } from '../levels/format.ts';
import {
  continueAfterTimeUp, createSession, currentLevelIndex, problemCleared, requestRetry, type Session,
} from '../game/session.ts';
import type { ClockState } from '../game/types.ts';
import { audio } from '../audio/audio.ts';
import { Backdrop } from '../rendering/backdrop.ts';
import { drawWordmark } from '../rendering/wordmark.ts';
import { blockIcon } from '../rendering/thumbnails.ts';
import {
  COMMAND_ORDER, addHighScore, type ReplayData, loadCustomLevels, loadHighScores, loadRecords, loadRun, loadSettings,
  prefersReducedMotion, qualifiesForHighScore, saveCustomLevels, saveRecord, saveRun, saveSettings,
  type LevelRecord, type Settings,
} from '../storage/storage.ts';
import { StateMachine } from './stateMachine.ts';
import { BUILD, fetchLatestBuild, updateToLatest, versionLabel } from '../version.ts';
import { h, svgIcon, formatScore, focusFirst } from './dom.ts';
import { PlayScreen, type ClearedResult, type PlayMode } from './screens/PlayScreen.ts';
import { TreeScreen } from './screens/TreeScreen.ts';
import { BrowserScreen, isUnlocked } from './screens/BrowserScreen.ts';
import { EditorScreen } from './screens/EditorScreen.ts';

export interface Screen {
  el: HTMLElement;
  frame?(now: number, dt: number): void;
  onKey?(e: KeyboardEvent): boolean;
  onHidden?(): void;
  destroy?(): void;
}

export class App {
  readonly machine = new StateMachine();
  settings: Settings = loadSettings();
  readonly levels: LevelData[];
  customLevels: LevelData[] = loadCustomLevels();
  records: Record<string, LevelRecord> = loadRecords();
  readonly debugAvailable = import.meta.env.DEV;
  debug = false;
  fps = 60;
  private session: Session | null = null;
  private screen: Screen | null = null;
  private readonly host: HTMLElement;
  private readonly backdrop: Backdrop;
  private debugEl: HTMLElement | null = null;
  private lastFrame = 0;

  constructor(root: HTMLElement, levels: LevelData[]) {
    this.levels = levels;
    const backdropHost = h('div', { class: 'backdrop', 'aria-hidden': 'true' });
    this.host = h('main', { id: 'screen' });
    root.append(backdropHost, this.host);
    this.backdrop = new Backdrop(backdropHost);
    this.applySettings();

    window.addEventListener('keydown', e => this.onKey(e));
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.screen?.onHidden?.(); });
    window.addEventListener('pointerdown', () => audio.unlock(), { capture: true });
    requestAnimationFrame(t => this.loop(t));
    this.showTitle();
    // deep link for testing and sharing: #level=17 opens that original problem in practice
    const deep = /#level=(\d+)/.exec(location.hash);
    const n = deep ? Number(deep[1]) : 0;
    if (n >= 1 && n <= this.levels.length) this.startPractice(this.levels[n - 1]);
  }

  get reducedMotion(): boolean {
    return prefersReducedMotion(this.settings);
  }

  private applySettings(): void {
    audio.setSound(this.settings.sound);
    audio.setMusic(this.settings.music);
    this.backdrop.reducedMotion = this.reducedMotion;
    document.documentElement.classList.toggle('reduce-on', this.settings.motion === 'reduced');
    document.documentElement.classList.toggle('reduce-auto', this.settings.motion === 'system');
  }

  private loop(now: number): void {
    this.frame(now);
    requestAnimationFrame(t => this.loop(t));
  }

  private frame(now: number): void {
    const dt = this.lastFrame ? now - this.lastFrame : 16;
    this.lastFrame = now;
    this.fps = this.fps * 0.95 + (1000 / Math.max(1, dt)) * 0.05;
    this.backdrop.render(now, dt / 1000);
    this.screen?.frame?.(now, dt);
  }

  /** Development only: run frames without requestAnimationFrame (e.g. in a hidden tab). */
  stepFrames(count: number, dtMs = 1000 / 60): void {
    if (!import.meta.env.DEV) return;
    let now = Math.max(this.lastFrame, performance.now());
    for (let i = 0; i < count; i++) {
      now += dtMs;
      this.frame(now);
    }
  }

  /** Development only: the active screen, for automated checks. */
  get activeScreen(): Screen | null {
    return import.meta.env.DEV ? this.screen : null;
  }

  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
    if (this.debugAvailable && e.code === 'Backquote') {
      this.debug = !this.debug;
      if (!this.debug) this.setDebug(null);
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyM' && !e.ctrlKey && !e.metaKey) {
      this.updateSettings({ music: !this.settings.music });
      if (this.settings.music) audio.startMusic();
      return;
    }
    if (this.screen?.onKey?.(e)) e.preventDefault();
  }

  setDebug(text: string | null): void {
    if (text === null || !this.debugAvailable) {
      this.debugEl?.remove();
      this.debugEl = null;
      return;
    }
    if (!this.debugEl) {
      this.debugEl = h('div', { class: 'debug-panel' });
      document.body.append(this.debugEl);
    }
    this.debugEl.textContent = text;
  }

  updateSettings(patch: Partial<Settings>): void {
    this.settings = { ...this.settings, ...patch };
    saveSettings(this.settings);
    this.applySettings();
  }

  private show(screen: Screen): void {
    this.screen?.destroy?.();
    this.screen = screen;
    screen.el.classList.add('screen-enter');
    this.host.replaceChildren(screen.el);
    if (!(screen instanceof PlayScreen)) requestAnimationFrame(() => focusFirst(screen.el));
  }

  private go(state: Parameters<StateMachine['go']>[0]): void {
    if (this.machine.state === 'ANIMATING' && state !== 'PLAYING') this.machine.go('PLAYING');
    if (this.machine.state === 'PLAYING' && state === 'TITLE' && !this.machine.can('TITLE')) this.machine.go('PAUSED');
    this.machine.go(state);
  }

  // ------------------------------------------------------------------ title

  showTitle(): void {
    this.go('TITLE');
    audio.stopMusic();
    const saved = loadRun();
    const wordmark = drawWordmark();
    wordmark.classList.add('wordmark');
    wordmark.setAttribute('role', 'img');
    wordmark.setAttribute('aria-label', 'BRIX');
    const start = () => { audio.unlock(); audio.ui(); };
    const el = h('div', { class: 'title' },
      h('div', { class: 'title-inner' },
        wordmark,
        h('p', { class: 'tagline' }, 'Push blocks together. Watch them blast.'),
        h('nav', { class: 'menu', 'aria-label': 'Main menu' },
          saved ? h('button', { class: 'btn primary big', autofocus: true, onclick: () => { start(); this.resumeRun(saved); } }, `Continue run · ${formatScore(saved.score)}`) : null,
          h('button', { class: `btn ${saved ? '' : 'primary big'}`, autofocus: !saved, onclick: () => { start(); this.newRun(); } }, saved ? 'New run' : 'Play'),
          h('button', { class: 'btn', onclick: () => { start(); this.showBrowser(); } }, 'Levels'),
          h('div', { class: 'row' },
            h('button', { class: 'btn', onclick: () => { start(); this.showHelp(); } }, 'How to play'),
            h('button', { class: 'btn', onclick: () => { start(); this.showHighScores(); } }, 'High scores')),
          h('div', { class: 'row' },
            h('button', { class: 'btn', onclick: () => { start(); this.openEditor(); } }, 'Editor'),
            h('button', { class: 'btn', onclick: () => { start(); this.showSettings(); } }, 'Settings')),
        ),
        h('p', { class: 'title-foot' }, 'All 112 puzzles of BRIX 1.00 by Michael Riedel (1991), reproduced exactly and reimagined for today.'),
        this.versionLine(),
      ));
    this.show({ el, onKey: e => { if (e.code === 'Escape') return true; return false; } });
  }

  private versionLine(): HTMLElement {
    const status = h('span', { class: 'version-status', 'aria-live': 'polite' });
    const line = h('p', { class: 'version' }, h('span', {}, `Version ${versionLabel()}`), status);
    if (import.meta.env.PROD) {
      status.textContent = 'Checking…';
      void fetchLatestBuild().then(latest => {
        if (!latest) { status.textContent = ''; return; }
        if (latest.sha === BUILD.sha) { status.textContent = 'Latest'; status.classList.add('ok'); return; }
        status.replaceChildren(h('button', {
          class: 'btn update-btn', onclick: (e: Event) => {
            const b = e.currentTarget as HTMLButtonElement;
            b.disabled = true;
            b.textContent = 'Updating…';
            void updateToLatest();
          },
        }, `Update to ${versionLabel(latest)}`));
      });
    }
    return line;
  }

  // ------------------------------------------------------------------ run

  private newRun(): void {
    this.session = createSession();
    saveRun(this.session);
    this.showTree();
  }

  private resumeRun(s: Session): void {
    this.session = s;
    if (s.phase === 'playing') this.playRunProblem();
    else this.showTree();
  }

  private showTree(): void {
    const s = this.session!;
    this.go('LEVEL_SELECT');
    audio.stopMusic();
    this.show(new TreeScreen(this, s, this.levels, () => { saveRun(s); this.playRunProblem(); }, () => this.showTitle()));
  }

  private playRunProblem(carry?: { clock: ClockState; score: number }): void {
    const s = this.session!;
    const index = currentLevelIndex(s);
    const level = this.levels[index];
    const t = level.tree!;
    this.startPlay(level, 'run', {
      where: `<b>Level ${t.level}</b> · Choice ${t.choice} · Problem ${t.problem} of 4`,
      score: carry?.score ?? s.score,
      clock: carry?.clock,
      retriesLeft: s.retriesLeft,
    });
  }

  private startPlay(level: LevelData, mode: PlayMode, extra: { where: string; score?: number; clock?: ClockState; retriesLeft?: number; replay?: ReplayData }): void {
    this.go('PLAYING');
    if (this.settings.music) audio.startMusic();
    const screen: PlayScreen = new PlayScreen(this, level, {
      mode,
      ...extra,
      onCleared: r => this.onCleared(screen, level, mode, r),
      onTimeUp: () => this.onTimeUp(screen, level, mode),
      onRetry: (clock, score) => this.onRetry(level, mode, clock, score, extra.where),
      onQuit: () => this.onQuit(mode, level),
    });
    this.show(screen);
    if (mode !== 'replay') this.bumpRecord(level.id, r => ({ ...r, plays: r.plays + 1 }));
  }

  private onRetry(level: LevelData, mode: PlayMode, clock: ClockState, score: number, where: string): void {
    if (this.machine.state === 'PAUSED') this.machine.go('PLAYING');
    if (mode === 'run') {
      const s = this.session!;
      if (requestRetry(s) === 'retry') {
        s.score = score;
        saveRun(s);
        this.playRunProblem({ clock, score });
      } else {
        const screen = this.screen as PlayScreen;
        this.onTimeUp(screen, level, mode);
      }
      return;
    }
    this.startPlay(level, mode, { where });
  }

  private onQuit(mode: PlayMode, level: LevelData): void {
    audio.stopMusic();
    if (mode === 'test') { this.go('EDITOR'); this.openEditor(level, true); return; }
    if (mode === 'practice' || mode === 'replay') { this.showBrowser(); return; }
    this.showTitle();
  }

  private bumpRecord(id: string, fn: (r: LevelRecord) => LevelRecord): void {
    saveRecord(id, fn);
    this.records = loadRecords();
  }

  private onCleared(screen: PlayScreen, level: LevelData, mode: PlayMode, r: ClearedResult): void {
    this.go('LEVEL_COMPLETE');
    if (mode === 'replay') {
      screen.showDialog(h('div', { class: 'dialog panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Replay finished' },
        h('h2', {}, 'Replay finished'),
        h('p', {}, `${formatScore(r.pointsBeforeBonus + r.clearBonus + r.timeBonus)} points with ${r.secondsLeft}s to spare.`),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary big', onclick: () => this.startPractice(level) }, 'Play it yourself'),
          h('button', { class: 'btn ghost', onclick: () => this.showBrowser() }, 'Levels'))));
      return;
    }
    let improved = false;
    if (level.origin === 'original' || mode !== 'test') {
      this.bumpRecord(level.id, rec => {
        const points = r.pointsBeforeBonus + r.clearBonus + r.timeBonus;
        improved = points > rec.bestPoints || !rec.cleared;
        return {
          ...rec,
          cleared: true,
          clears: rec.clears + 1,
          stars: Math.max(rec.stars, r.stars),
          bestPoints: Math.max(rec.bestPoints, points),
          bestSeconds: rec.bestSeconds === null ? r.secondsUsed : Math.min(rec.bestSeconds, r.secondsUsed),
          // only a practice clear without retries starts from the level's own initial state
          replay: improved && mode === 'practice' && !r.retried ? { levelId: level.id, blastFreezeMs: r.blastFreezeMs, inputs: r.inputs.map(i => [i.counts, COMMAND_ORDER.indexOf(i.command)]) } : rec.replay,
        };
      });
    }

    let nextLabel = 'Next problem';
    let next: () => void;
    if (mode === 'run') {
      const s = this.session!;
      const res = problemCleared(s, r.finalScore);
      saveRun(s);
      if (res.next === 'won') { nextLabel = 'Finish'; next = () => this.showEnd('VICTORY'); }
      else if (res.next === 'choose') { nextLabel = 'Choose next path'; next = () => this.showTree(); }
      else next = () => this.playRunProblem();
    } else if (mode === 'test') {
      nextLabel = 'Back to editor';
      next = () => { this.go('EDITOR'); this.openEditor(level, true); };
    } else {
      const i = this.levels.indexOf(level);
      const following = i >= 0 ? this.levels.slice(i + 1).find((_, k) => isUnlocked(i + 1 + k, this.levels, this.records)) : undefined;
      if (following) next = () => this.startPractice(following);
      else { nextLabel = 'Levels'; next = () => this.showBrowser(); }
    }

    const rows = [
      ['Blocks', r.pointsBeforeBonus],
      ['Clear bonus', r.clearBonus],
      [`Time bonus · ${r.secondsLeft}s`, r.timeBonus],
    ] as const;
    const rowEls = rows.map(([label, value]) => h('div', { class: 'tally-row' }, h('span', {}, label), h('b', { 'data-value': value }, '0')));
    const totalEl = h('div', { class: 'tally-row total on' }, h('span', {}, mode === 'run' ? 'Score' : 'Total'), h('b', {}, formatScore(mode === 'run' ? r.finalScore - r.clearBonus - r.timeBonus : r.pointsBeforeBonus)));
    const starEls = [0, 1, 2].map(() => h('span', { class: 'star', 'aria-hidden': 'true' }, '★'));
    const nextBtn = h('button', { class: 'btn primary big', onclick: () => { audio.ui(); next(); } }, nextLabel);
    screen.showDialog(h('div', { class: 'dialog panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Problem cleared' },
      h('h2', {}, 'Cleared!'),
      h('div', { class: 'stars', role: 'img', 'aria-label': `${r.stars} of 3 stars` }, ...starEls),
      h('div', { class: 'tally' }, ...rowEls, totalEl),
      improved && mode === 'practice' ? h('p', {}, 'New personal best.') : null,
      h('div', { class: 'actions' },
        nextBtn,
        mode === 'practice' ? h('button', { class: 'btn', onclick: () => this.startPractice(level) }, 'Play again') : null,
        mode !== 'test' ? h('button', { class: 'btn ghost', onclick: () => (mode === 'run' ? this.showTitle() : this.showBrowser()) }, mode === 'run' ? 'Save and quit' : 'Levels') : null,
      )));
    nextBtn.focus();

    // tally animation
    const total = totalEl.querySelector('b')!;
    let running = mode === 'run' ? r.finalScore - r.clearBonus - r.timeBonus : r.pointsBeforeBonus;
    const reduce = this.reducedMotion;
    rows.forEach(([, value], i) => {
      window.setTimeout(() => {
        const row = rowEls[i];
        row.classList.add('on');
        const b = row.querySelector('b')!;
        const from = running, to = running + (i === 0 && mode === 'run' ? 0 : value);
        const steps = reduce ? 1 : Math.min(24, Math.max(1, Math.round(value / 100)));
        for (let k = 1; k <= steps; k++) {
          window.setTimeout(() => {
            b.textContent = formatScore(Math.round((value * k) / steps));
            total.textContent = formatScore(Math.round(from + ((to - from) * k) / steps));
            if (k % 3 === 0) audio.countUp();
          }, k * 28);
        }
        running = to;
      }, 350 + i * 700);
    });
    starEls.forEach((s, i) => window.setTimeout(() => { if (i < r.stars) { s.classList.add('on'); audio.ui(); } }, 350 + rows.length * 700 + i * 220));
  }

  private onTimeUp(screen: PlayScreen, level: LevelData, mode: PlayMode): void {
    if (this.machine.state === 'PAUSED') this.machine.go('PLAYING');
    this.go('LEVEL_FAILED');
    audio.stopMusic();
    if (mode !== 'run') {
      screen.showDialog(h('div', { class: 'dialog panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Time up' },
        h('h2', {}, "Time's up"),
        h('p', {}, 'The clock beat you this time.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn primary big', onclick: () => (mode === 'test' ? this.startTest(level) : this.startPractice(level)) }, 'Try again'),
          h('button', { class: 'btn ghost', onclick: () => this.onQuit(mode, level) }, mode === 'test' ? 'Back to editor' : 'Levels'),
        )));
      return;
    }
    const s = this.session!;
    let left = 10;
    const count = h('div', { class: 'countdown', 'aria-live': 'polite' }, String(left));
    let timer = 0;
    const giveUp = () => { window.clearInterval(timer); this.showEnd('GAME_OVER'); };
    const cont = () => {
      window.clearInterval(timer);
      if (continueAfterTimeUp(s)) { saveRun(s); this.playRunProblem(); }
      else giveUp();
    };
    screen.showDialog(h('div', { class: 'dialog panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Time up' },
      h('h2', {}, "Time's up"),
      s.credits > 0 ? h('p', {}, `Continue with a fresh clock? ${s.credits} ${s.credits === 1 ? 'credit' : 'credits'} left.`) : h('p', {}, 'No credits left.'),
      s.credits > 0 ? count : null,
      h('div', { class: 'actions' },
        s.credits > 0 ? h('button', { class: 'btn primary big', onclick: cont }, 'Continue') : null,
        h('button', { class: 'btn ghost', onclick: giveUp }, 'Give up'),
      )));
    if (s.credits > 0) {
      timer = window.setInterval(() => {
        left--;
        count.textContent = String(left);
        audio.warning();
        if (left <= 0) giveUp();
      }, 1000);
    }
  }

  private showEnd(kind: 'GAME_OVER' | 'VICTORY'): void {
    this.go(kind);
    const s = this.session!;
    saveRun(null);
    audio.stopMusic();
    if (kind === 'VICTORY') audio.clear();
    const t = this.levels[currentLevelIndex(s)]?.tree;
    const reached = kind === 'VICTORY' ? 'Completed' : t ? `Level ${t.level}-${t.choice}` : '';
    const qualifies = qualifiesForHighScore(s.score);
    const input = h('input', { class: 'name-input', maxlength: '12', placeholder: 'YOUR NAME', 'aria-label': 'Your name', autocomplete: 'nickname' });
    const save = () => {
      const name = (input.value.trim() || 'MR. NOBODY').toUpperCase().slice(0, 12);
      addHighScore({ name, score: s.score, reached, date: new Date().toISOString().slice(0, 10) });
      this.showHighScores();
    };
    input.addEventListener('keydown', e => { if (e.key === 'Enter') save(); });
    const el = h('div', { class: 'title' },
      h('div', { class: 'dialog panel', role: 'dialog', 'aria-label': kind === 'VICTORY' ? 'You made it' : 'Game over' },
        h('h2', {}, kind === 'VICTORY' ? 'You made it!' : 'Game over'),
        h('p', {}, kind === 'VICTORY' ? 'Every step of the tree, down to the bottom-right problem.' : `You reached ${reached}.`),
        h('div', { class: 'stat', style: 'margin: 0 auto' }, h('span', { class: 'stat-label' }, 'Final score'), h('span', { class: 'stat-value' }, formatScore(s.score))),
        qualifies ? h('p', {}, 'A new high score!') : null,
        qualifies ? input : null,
        h('div', { class: 'actions' },
          qualifies ? h('button', { class: 'btn primary big', onclick: save }, 'Save score') : h('button', { class: 'btn primary big', onclick: () => this.showHighScores() }, 'High scores'),
          h('button', { class: 'btn ghost', onclick: () => this.showTitle() }, 'Title'),
        )));
    this.session = null;
    this.show({ el });
    if (qualifies) requestAnimationFrame(() => input.focus());
  }

  // ------------------------------------------------------------------ practice & editor

  showBrowser(): void {
    this.records = loadRecords();
    this.go('LEVEL_BROWSER');
    audio.stopMusic();
    this.show(new BrowserScreen(this, level => this.startPractice(level), () => this.showTitle()));
  }

  private startPractice(level: LevelData): void {
    const t = level.tree;
    this.startPlay(level, 'practice', { where: t ? `<b>Level ${t.level}</b> · Choice ${t.choice} · Problem ${t.problem}` : `<b>${level.name ?? 'Custom level'}</b>` });
  }

  startReplay(level: LevelData): void {
    const replay = this.records[level.id]?.replay;
    if (!replay) return;
    const t = level.tree;
    this.startPlay(level, 'replay', { where: `<b>Replay</b> · ${t ? `Level ${t.level} · Choice ${t.choice} · Problem ${t.problem}` : level.name ?? ''}`, replay });
  }

  startTest(level: LevelData): void {
    this.startPlay(level, 'test', { where: `<b>Testing</b> · ${level.name ?? 'Custom level'}` });
  }

  openEditor(level?: LevelData, keep = false): void {
    if (this.machine.state !== 'EDITOR') this.go('EDITOR');
    audio.stopMusic();
    const screen = new EditorScreen(this, level, keep, () => this.showTitle());
    this.show(screen);
  }

  saveCustomLevel(level: LevelData): void {
    const list = loadCustomLevels().filter(l => l.id !== level.id);
    list.push(level);
    saveCustomLevels(list);
    this.customLevels = list;
  }

  deleteCustomLevel(id: string): void {
    const list = loadCustomLevels().filter(l => l.id !== id);
    saveCustomLevels(list);
    this.customLevels = list;
  }

  // ------------------------------------------------------------------ menus

  private showSettings(): void {
    this.go('SETTINGS');
    const toggle = (key: 'sound' | 'music' | 'classicBlastTiming' | 'treeTimer', label: string, hint: string) => {
      const sw = h('button', { class: 'switch', role: 'switch', 'aria-checked': String(this.settings[key]), 'aria-label': label });
      sw.addEventListener('click', () => {
        this.updateSettings({ [key]: !this.settings[key] });
        sw.setAttribute('aria-checked', String(this.settings[key]));
        audio.unlock();
        audio.ui();
      });
      return h('div', { class: 'setting' }, h('div', { class: 'setting-text' }, h('span', {}, label), h('small', {}, hint)), sw);
    };
    const motion = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Motion' });
    for (const [value, label] of [['system', 'System'], ['full', 'Full'], ['reduced', 'Reduced']] as const) {
      const b = h('button', { 'aria-pressed': String(this.settings.motion === value) }, label);
      b.addEventListener('click', () => {
        this.updateSettings({ motion: value });
        for (const other of motion.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === b));
      });
      motion.append(b);
    }
    const el = h('div', { class: 'page' },
      h('div', { class: 'page-head' },
        h('button', { class: 'btn icon', 'aria-label': 'Back', html: svgIcon('back'), onclick: () => this.showTitle() }),
        h('h1', {}, 'Settings')),
      h('div', { class: 'page-body scroll' },
        h('div', { class: 'panel narrow' },
          toggle('sound', 'Sound effects', 'Clicks, blasts and fanfares.'),
          toggle('music', 'Music', 'A gentle loop that quickens as the clock runs down. Press M to toggle.'),
          h('div', { class: 'setting' }, h('div', { class: 'setting-text' }, h('span', {}, 'Motion'), h('small', {}, 'Reduced removes shake, particles and drifting backgrounds.')), motion),
          toggle('classicBlastTiming', 'Classic blast timing', 'Hold blasts for 1.5 s like the 1991 original. Everything pauses during a blast either way, so puzzles play the same.'),
          toggle('treeTimer', 'Level tree timer', 'The original chooses for you after 10 seconds on the level tree.'),
          h('div', { class: 'setting' },
            h('div', { class: 'setting-text' }, h('span', {}, 'Reset progress'), h('small', {}, 'Forget stars, bests and high scores on this device.')),
            h('button', {
              class: 'btn ghost', onclick: (e: Event) => {
                const b = e.currentTarget as HTMLButtonElement;
                if (b.dataset.armed) {
                  for (const k of ['records', 'highscores', 'run']) localStorage.removeItem(`brix:${k}`);
                  this.records = {};
                  b.textContent = 'Done';
                  b.disabled = true;
                } else {
                  b.dataset.armed = '1';
                  b.textContent = 'Tap again to confirm';
                }
              },
            }, 'Reset'),
          ),
        )));
    this.show({ el, onKey: e => { if (e.code === 'Escape') { this.showTitle(); return true; } return false; } });
  }

  private showHelp(): void {
    this.go('HELP');
    const icon = (t: number) => h('img', { src: blockIcon(t, 40), alt: '', style: 'width: 26px; height: 26px; vertical-align: middle' });
    const el = h('div', { class: 'page' },
      h('div', { class: 'page-head' },
        h('button', { class: 'btn icon', 'aria-label': 'Back', html: svgIcon('back'), onclick: () => this.showTitle() }),
        h('h1', {}, 'How to play')),
      h('div', { class: 'page-body scroll' },
        h('div', { class: 'panel narrow help' },
          h('h2', {}, 'Clear the board'),
          h('p', {}, 'Every block must go. When two or more blocks of the same kind touch — side by side or one on top of the other — they blast away. ', icon(1), icon(1)),
          h('p', {}, 'If a kind has an odd number of blocks, the last three have to meet at the same moment, or one is left stranded.'),
          h('h2', {}, 'Moving blocks'),
          h('ul', {},
            h('li', {}, 'Pick up a block, then push it left or right into empty space. Blocks never move up or down by themselves — except by falling.'),
            h('li', {}, 'Anything with nothing underneath falls. While any block is falling, no block can be pushed; a push you make meanwhile happens as soon as everything lands.'),
            h('li', {}, 'Golden elevators carry whatever stands on them up and down their shaft.'),
          ),
          h('h2', {}, 'Controls'),
          h('ul', {},
            h('li', {}, h('span', { class: 'kbd' }, '←↑↓→'), ' or ', h('span', { class: 'kbd' }, 'WASD'), ' move the cursor. ', h('span', { class: 'kbd' }, 'Space'), ' picks up and puts down.'),
            h('li', {}, 'Touch or mouse: tap a block to pick it up and drag it sideways; release to put it down. Tap anywhere to move the cursor there.'),
            h('li', {}, h('span', { class: 'kbd' }, 'R'), ' retries a problem (the clock keeps running), ', h('span', { class: 'kbd' }, 'Esc'), ' pauses, ', h('span', { class: 'kbd' }, 'M'), ' toggles music.'),
          ),
          h('h2', {}, 'Scoring'),
          h('p', {}, 'Each blast of n blocks scores (n − 1) × 100. Blast more than three blocks without moving one yourself for a chain bonus of 400, 600 or 1000. Clearing a problem without a retry is worth 1000 per level, plus 100 per level for every second left.'),
          h('h2', {}, 'The level tree'),
          h('p', {}, 'A run starts with a choice of any path in levels 1 to 5. Clear a path’s four problems and the tree offers the two paths beside it on the next level. Reach and clear the bottom-right path of level 7 to win. You have five continues.'),
        )));
    this.show({ el, onKey: e => { if (e.code === 'Escape') { this.showTitle(); return true; } return false; } });
  }

  private showHighScores(): void {
    this.go('HIGH_SCORES');
    const list = loadHighScores();
    const el = h('div', { class: 'page' },
      h('div', { class: 'page-head' },
        h('button', { class: 'btn icon', 'aria-label': 'Back', html: svgIcon('back'), onclick: () => this.showTitle() }),
        h('h1', {}, 'Hall of fame')),
      h('div', { class: 'page-body scroll' },
        h('div', { class: 'panel narrow', style: 'padding: 8px 4px' },
          list.length
            ? h('table', { class: 'scores' },
              h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'Name'), h('th', {}, 'Reached'), h('th', { style: 'text-align:right' }, 'Score'))),
              h('tbody', {}, ...list.map((s, i) => h('tr', {}, h('td', {}, String(i + 1)), h('td', {}, s.name), h('td', {}, s.reached), h('td', { class: 'score' }, formatScore(s.score))))))
            : h('p', { style: 'padding: 20px; text-align: center; color: var(--ink-dim)' }, 'No scores yet. Finish a run to get on the board.'),
        )));
    this.show({ el, onKey: e => { if (e.code === 'Escape') { this.showTitle(); return true; } return false; } });
  }
}
