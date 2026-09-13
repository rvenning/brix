import {
  Node, TREE_LEVELS, TREE_SELECT_SECONDS, chooseNode, moveTreeCursor, pointTreeCursor, type Session,
} from '../../game/session.ts';
import { treeIndex, type LevelData } from '../../levels/format.ts';
import { levelPreview } from '../../rendering/thumbnails.ts';
import { audio } from '../../audio/audio.ts';
import { h, svgIcon, formatScore, focusFirst } from '../dom.ts';
import type { App, Screen } from '../App.ts';

/** The level tree of a run: pick which choice of four problems to play next. */
export class TreeScreen implements Screen {
  readonly el: HTMLElement;
  private readonly session: Session;
  private readonly levels: LevelData[];
  private readonly onChosen: () => void;
  private nodes = new Map<string, HTMLButtonElement>();
  private side: HTMLElement;
  private timerEl: HTMLElement;
  private deadline: number | null;

  constructor(app: App, session: Session, levels: LevelData[], onChosen: () => void, onBack: () => void) {
    this.session = session;
    this.levels = levels;
    this.onChosen = onChosen;
    this.deadline = app.settings.treeTimer ? performance.now() + TREE_SELECT_SECONDS * 1000 : null;

    const tree = h('div', { class: 'tree panel', role: 'group', 'aria-label': 'Level tree' });
    const svgNS = 'http://www.w3.org/2000/svg';
    const links = document.createElementNS(svgNS, 'svg');
    links.classList.add('links');
    links.setAttribute('viewBox', '0 0 100 100');
    links.setAttribute('preserveAspectRatio', 'none');
    tree.append(links);

    const pos = (c: number, r: number) => ({ x: ((c + 0.5) / TREE_LEVELS) * 100, y: 54 + (r - c / 2) * (86 / TREE_LEVELS) });
    for (let c = 0; c < TREE_LEVELS; c++) {
      const label = h('div', { class: 'tree-col-label', style: `left: calc(12px + (100% - 24px) * ${pos(c, 0).x / 100})` }, `Level ${c + 1}`);
      tree.append(label);
      for (let r = 0; r <= c; r++) {
        const from = pos(c, r);
        if (c < TREE_LEVELS - 1) {
          for (const nr of [r, r + 1]) {
            const to = pos(c + 1, nr);
            const line = document.createElementNS(svgNS, 'line');
            line.setAttribute('x1', String(from.x)); line.setAttribute('y1', String(from.y));
            line.setAttribute('x2', String(to.x)); line.setAttribute('y2', String(to.y));
            const lit = session.tree[c][r] === Node.Done && session.tree[c + 1][nr] !== Node.Locked;
            line.setAttribute('stroke', lit ? 'rgba(124,240,255,0.7)' : 'rgba(150,170,255,0.18)');
            line.setAttribute('stroke-width', lit ? '3' : '2');
            line.setAttribute('vector-effect', 'non-scaling-stroke');
            links.append(line);
          }
        } else if (r < c) {
          const to = pos(c, r + 1);
          const line = document.createElementNS(svgNS, 'line');
          line.setAttribute('x1', String(from.x)); line.setAttribute('y1', String(from.y));
          line.setAttribute('x2', String(to.x)); line.setAttribute('y2', String(to.y));
          line.setAttribute('stroke', 'rgba(255,216,74,0.25)');
          line.setAttribute('stroke-dasharray', '4 4');
          line.setAttribute('stroke-width', '2');
          line.setAttribute('vector-effect', 'non-scaling-stroke');
          links.append(line);
        }
        const state = session.tree[c][r];
        const node = h('button', {
          class: `tree-node ${state === Node.Offered ? 'offered' : state === Node.Done ? 'done' : ''}${c === 6 && r === 6 ? ' goal' : ''}`,
          style: `left: calc(12px + (100% - 24px) * ${from.x / 100}); top: calc(12px + (100% - 24px) * ${from.y / 100}); --node: clamp(30px, 6vmin, 58px)`,
          'aria-label': `Level ${c + 1}, choice ${r + 1}, ${state === Node.Offered ? 'available' : state === Node.Done ? 'cleared' : 'locked'}`,
          tabindex: state === Node.Offered ? '0' : '-1',
          disabled: state !== Node.Offered,
          onclick: () => { if (pointTreeCursor(session, c, r)) this.choose(); },
          onmouseenter: () => this.preview(c, r),
          onfocus: () => { if (pointTreeCursor(session, c, r)) this.refresh(); },
        }, state === Node.Done ? '✓' : String(r + 1));
        this.nodes.set(`${c},${r}`, node);
        tree.append(node);
      }
    }

    this.side = h('div', { class: 'tree-side panel' });
    this.timerEl = h('span', { class: 'tree-timer' });
    this.el = h('div', { class: 'page' },
      h('div', { class: 'page-head' },
        h('button', { class: 'btn icon', 'aria-label': 'Back to title', html: svgIcon('back'), onclick: onBack }),
        h('h1', {}, 'Choose your path'),
        this.timerEl,
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Score'), h('span', { class: 'stat-value' }, formatScore(session.score))),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Credits'), h('span', { class: 'stat-value' }, String(session.credits))),
      ),
      h('div', { class: 'tree-wrap' }, tree, this.side),
    );
    this.refresh();
    requestAnimationFrame(() => this.nodes.get(`${session.col},${session.row}`)?.focus({ preventScroll: true }) ?? focusFirst(this.el));
  }

  private refresh(): void {
    for (const [key, node] of this.nodes) node.classList.toggle('cursor', key === `${this.session.col},${this.session.row}`);
    this.preview(this.session.col, this.session.row);
  }

  private preview(c: number, r: number): void {
    const first = this.levels[treeIndex(c + 1, r + 1, 1)];
    const done = this.session.tree[c][r] === Node.Done;
    this.side.replaceChildren(...[
      h('h2', {}, `Level ${c + 1} · Choice ${r + 1}`),
      h('img', { class: 'preview', src: levelPreview(first, 16), alt: `First problem of level ${c + 1}, choice ${r + 1}` }),
      h('p', { class: 'meta' },
        done ? 'Cleared.' : `Four problems, ${first.timeLimit.minutes}:${String(first.timeLimit.seconds).padStart(2, '0')} for the first.`,
        h('br'),
        `Clear bonus ${formatScore((c + 1) * 1000)}, plus ${(c + 1) * 100} per second left.`),
      this.session.tree[c][r] === Node.Offered ? h('button', { class: 'btn primary', onclick: () => { pointTreeCursor(this.session, c, r); this.choose(); } }, 'Play this choice') : null,
    ].filter(n => n !== null) as HTMLElement[]);
  }

  private choose(): void {
    audio.unlock();
    audio.ui();
    chooseNode(this.session);
    this.onChosen();
  }

  frame(now: number): void {
    if (this.deadline === null) return;
    const left = Math.max(0, Math.ceil((this.deadline - now) / 1000));
    this.timerEl.textContent = `Time ${String(left).padStart(2, '0')}`;
    if (now >= this.deadline) {
      this.deadline = null;
      this.choose();
    }
  }

  onKey(e: KeyboardEvent): boolean {
    const dirs: Record<string, 'up' | 'down' | 'left' | 'right'> = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
    };
    const d = dirs[e.code];
    if (d) {
      if (moveTreeCursor(this.session, d)) {
        audio.move();
        this.nodes.get(`${this.session.col},${this.session.row}`)?.focus({ preventScroll: true });
        this.refresh();
      }
      return true;
    }
    if (e.code === 'Space' || e.code === 'Enter') {
      this.choose();
      return true;
    }
    return false;
  }
}
