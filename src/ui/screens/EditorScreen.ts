import { Play } from '../../game/Play.ts';
import { lintLevel, type ElevatorDirection, type LevelData } from '../../levels/format.ts';
import { BoardRenderer } from '../../rendering/BoardRenderer.ts';
import { Effects } from '../../rendering/effects.ts';
import { blockIcon } from '../../rendering/thumbnails.ts';
import { audio } from '../../audio/audio.ts';
import { h, svgIcon } from '../dom.ts';
import type { App, Screen } from '../App.ts';

type Tool = '.' | '#' | '=' | ' ' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | 'elevator' | 'cursor';

const TOOL_LABEL: Record<string, string> = {
  '.': 'Empty', '#': 'Frame', '=': 'Wall', ' ': 'Outside', elevator: 'Elevator', cursor: 'Start',
};

export function blankLevel(width = 14, height = 12): LevelData {
  const tiles: string[] = [];
  for (let y = 0; y < height; y++) {
    let row = '';
    for (let x = 0; x < width; x++) row += x === 0 || y === 0 || x === width - 1 || y === height - 1 ? '#' : '.';
    tiles.push(row);
  }
  return {
    format: 'brix-level/1', id: `custom-${Date.now().toString(36)}`, number: 0, origin: 'custom', name: 'Untitled',
    width, height, tiles, cursor: { x: 1, y: 1 }, elevator: null, timeLimit: { minutes: 1, seconds: 30 },
  };
}

/** Advisory checks that do not stop a level from loading. */
export function designWarnings(level: LevelData): string[] {
  const out: string[] = [];
  const counts = new Map<string, number>();
  for (const row of level.tiles) for (const ch of row) if (ch >= '1' && ch <= '8') counts.set(ch, (counts.get(ch) ?? 0) + 1);
  if (counts.size === 0) out.push('No blocks: the level clears the moment it starts.');
  for (const [ch, n] of counts) if (n === 1) out.push(`Only one block of type ${ch}: it can never blast.`);
  const c = level.tiles[level.cursor.y]?.[level.cursor.x];
  if (c === '#') out.push('The start is on a frame wall.');
  for (let x = 0; x < level.width; x++) {
    if ('12345678'.includes(level.tiles[0][x]) || '12345678'.includes(level.tiles[level.height - 1][x])) { out.push('Blocks on the outer rows are never scanned by the rules.'); break; }
  }
  return out;
}

export class EditorScreen implements Screen {
  readonly el: HTMLElement;
  private readonly app: App;
  private level: LevelData;
  private readonly readOnly: boolean;
  private tool: Tool = '1';
  private history: string[] = [];
  private future: string[] = [];
  private readonly renderer: BoardRenderer;
  private readonly fx = new Effects();
  private play: Play;
  private painting = false;
  private meta: HTMLElement;
  private messages: HTMLElement;
  private toolButtons = new Map<Tool, HTMLButtonElement>();

  constructor(app: App, level: LevelData | undefined, _keep: boolean, onBack: () => void) {
    this.app = app;
    this.level = structuredClone(level ?? blankLevel());
    this.readOnly = this.level.origin === 'original';
    this.play = new Play(this.level, { blastFreezeMs: 0 });

    const canvas = h('canvas', { 'aria-label': 'Level being edited', role: 'img' });
    this.renderer = new BoardRenderer(canvas);
    canvas.addEventListener('pointerdown', e => { if (this.readOnly) return; this.painting = true; canvas.setPointerCapture(e.pointerId); this.snapshot(); this.paintAt(e); });
    canvas.addEventListener('pointermove', e => { if (this.painting) this.paintAt(e); });
    canvas.addEventListener('pointerup', () => { this.painting = false; });
    canvas.addEventListener('pointercancel', () => { this.painting = false; });

    const palette = h('div', { class: 'palette', role: 'toolbar', 'aria-label': 'Tiles' });
    const tools: Tool[] = ['1', '2', '3', '4', '5', '6', '7', '8', '.', '=', '#', ' ', 'elevator', 'cursor'];
    for (const t of tools) {
      const isBlockTool = t >= '1' && t <= '8' && t.length === 1;
      const b = h('button', {
        class: 'tool', 'aria-pressed': String(t === this.tool), 'aria-label': isBlockTool ? `Block ${t}` : TOOL_LABEL[t],
        title: isBlockTool ? `Block ${t} (${t})` : TOOL_LABEL[t],
        onclick: () => this.setTool(t),
      }, isBlockTool ? h('img', { src: blockIcon(Number(t), 40), alt: '' }) : h('span', {}, TOOL_LABEL[t]));
      this.toolButtons.set(t, b);
      palette.append(b);
    }

    this.meta = h('div', { class: 'editor-meta panel' });
    this.messages = h('div', { style: 'display:grid; gap:6px' });

    const toolsPanel = h('div', { class: 'editor-tools panel' },
      this.readOnly
        ? h('div', { style: 'display:grid; gap:10px' },
          h('span', { class: 'badge locked' }, 'Original · read-only'),
          h('p', { class: 'note' }, 'Original levels are protected. Duplicate this one to make your own version.'),
          h('button', { class: 'btn primary', onclick: () => this.duplicate() }, 'Duplicate to edit'))
        : palette,
      this.readOnly ? null : h('div', { class: 'row' },
        h('button', { class: 'btn icon', 'aria-label': 'Undo', title: 'Undo (Ctrl+Z)', html: svgIcon('undo'), onclick: () => this.undo() }),
        h('button', { class: 'btn icon', 'aria-label': 'Redo', title: 'Redo (Ctrl+Y)', html: svgIcon('redo'), onclick: () => this.redo() })),
    );

    this.el = h('div', { class: 'page' },
      h('div', { class: 'page-head' },
        h('button', { class: 'btn icon', 'aria-label': 'Back', html: svgIcon('back'), onclick: onBack }),
        h('h1', {}, 'Level editor'),
        h('button', { class: 'btn primary', onclick: () => { audio.unlock(); this.app.startTest(structuredClone(this.level)); } }, h('span', { html: svgIcon('play') }), 'Test'),
      ),
      h('div', { class: 'editor' }, toolsPanel, h('div', { class: 'editor-canvas-wrap' }, canvas), this.meta),
    );
    this.renderMeta();
  }

  private setTool(t: Tool): void {
    this.tool = t;
    for (const [k, b] of this.toolButtons) b.setAttribute('aria-pressed', String(k === t));
  }

  private snapshot(): void {
    this.history.push(JSON.stringify(this.level));
    if (this.history.length > 200) this.history.shift();
    this.future = [];
  }

  private undo(): void {
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push(JSON.stringify(this.level));
    this.level = JSON.parse(prev);
    this.changed();
  }

  private redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(JSON.stringify(this.level));
    this.level = JSON.parse(next);
    this.changed();
  }

  private paintAt(e: PointerEvent): void {
    const cell = this.renderer.cellAt(e.clientX, e.clientY);
    if (!cell) return;
    const { x, y } = cell;
    const lv = this.level;
    if (this.tool === 'cursor') {
      lv.cursor = { x, y };
    } else if (this.tool === 'elevator') {
      lv.elevator = { x, y, direction: lv.elevator?.direction ?? -1 };
      this.setTile(x, y, '.');
    } else {
      if (lv.tiles[y][x] === this.tool) return;
      this.setTile(x, y, this.tool);
      if (lv.elevator && lv.elevator.x === x && lv.elevator.y === y && this.tool !== '.') lv.elevator = null;
    }
    this.changed(false);
  }

  private setTile(x: number, y: number, ch: string): void {
    const row = this.level.tiles[y];
    this.level.tiles[y] = row.slice(0, x) + ch + row.slice(x + 1);
  }

  private changed(save = true): void {
    delete this.level.original;
    this.play = new Play(this.level, { blastFreezeMs: 0 });
    if (save) this.renderMeta();
    else this.renderMessages();
    if (!this.readOnly) this.app.saveCustomLevel(structuredClone(this.level));
  }

  private duplicate(): void {
    const copy = structuredClone(this.level);
    copy.id = `custom-${Date.now().toString(36)}`;
    copy.origin = 'custom';
    copy.name = this.level.tree ? `My ${this.level.tree.level}-${this.level.tree.choice}-${this.level.tree.problem}` : `${this.level.name ?? 'Level'} copy`;
    copy.number = 0;
    delete copy.tree;
    delete copy.original;
    this.app.saveCustomLevel(copy);
    this.app.openEditor(copy, true);
  }

  private resize(width: number, height: number): void {
    width = Math.max(4, Math.min(24, width | 0));
    height = Math.max(4, Math.min(20, height | 0));
    if (width === this.level.width && height === this.level.height) return;
    this.snapshot();
    const lv = this.level;
    const tiles: string[] = [];
    for (let y = 0; y < height; y++) {
      let row = '';
      for (let x = 0; x < width; x++) {
        const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
        const old = y < lv.height && x < lv.width ? lv.tiles[y][x] : '.';
        row += edge ? '#' : (old === '#' && (x === lv.width - 1 || y === lv.height - 1) ? '.' : old);
      }
      tiles.push(row);
    }
    lv.tiles = tiles;
    lv.width = width;
    lv.height = height;
    lv.cursor = { x: Math.min(lv.cursor.x, width - 2), y: Math.min(lv.cursor.y, height - 2) };
    if (lv.elevator && (lv.elevator.x >= width - 1 || lv.elevator.y >= height - 1)) lv.elevator = null;
    this.changed();
  }

  private renderMessages(): void {
    const problems = lintLevel(this.level), warnings = designWarnings(this.level);
    const items: Node[] = [
      ...problems.map(p => h('p', { class: 'note', style: 'color: var(--danger)' }, p)),
      ...warnings.map(w => h('p', { class: 'note' }, `⚠ ${w}`)),
    ];
    if (!items.length) items.push(h('p', { class: 'note', style: 'color: var(--good)' }, 'Looks playable.'));
    this.messages.replaceChildren(...items);
  }

  private renderMeta(): void {
    const lv = this.level;
    const ro = this.readOnly;
    const num = (value: number, min: number, max: number, on: (v: number) => void, label: string) => {
      const input = h('input', { type: 'number', min: String(min), max: String(max), value: String(value), disabled: ro, 'aria-label': label });
      input.addEventListener('change', () => on(Number(input.value)));
      return h('label', { class: 'field' }, label, input);
    };
    const name = h('input', { type: 'text', value: lv.name ?? (lv.tree ? `Original ${lv.tree.level}-${lv.tree.choice}-${lv.tree.problem}` : ''), disabled: ro, maxlength: '40' });
    name.addEventListener('change', () => { this.snapshot(); lv.name = name.value; this.changed(); });
    const dir = h('select', { disabled: ro || !lv.elevator, 'aria-label': 'Elevator direction' },
      ...([[-1, 'Starts up'], [1, 'Starts down'], [0, 'Never moves']] as const).map(([v, l]) => h('option', { value: String(v), selected: lv.elevator?.direction === v }, l)));
    dir.addEventListener('change', () => { if (!lv.elevator) return; this.snapshot(); lv.elevator.direction = Number(dir.value) as ElevatorDirection; this.changed(); });

    const importInput = h('input', { type: 'file', accept: 'application/json,.json', class: 'sr-only' });
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text()) as LevelData;
        const errors = data.format === 'brix-level/1' ? lintLevel(data) : ['not a brix-level/1 file'];
        if (errors.length) { this.messages.replaceChildren(h('p', { class: 'note', style: 'color: var(--danger)' }, `Import failed: ${errors[0]}`)); return; }
        data.id = `custom-${Date.now().toString(36)}`;
        data.origin = 'custom';
        delete data.tree;
        this.app.saveCustomLevel(data);
        this.app.openEditor(data, true);
      } catch (err) {
        this.messages.replaceChildren(h('p', { class: 'note', style: 'color: var(--danger)' }, `Import failed: ${(err as Error).message}`));
      }
    });

    const levelPicker = h('select', { 'aria-label': 'Open level' },
      h('option', { value: '' }, 'Open…'),
      h('option', { value: 'new' }, 'New blank level'),
      ...this.app.customLevels.map(l => h('option', { value: l.id }, `✎ ${l.name ?? l.id}`)),
      ...this.app.levels.map(l => h('option', { value: l.id }, `Original ${l.tree!.level}-${l.tree!.choice}-${l.tree!.problem}`)));
    levelPicker.addEventListener('change', () => {
      const v = levelPicker.value;
      if (!v) return;
      if (v === 'new') { const b = blankLevel(); this.app.saveCustomLevel(b); this.app.openEditor(b, true); return; }
      const found = this.app.customLevels.find(l => l.id === v) ?? this.app.levels.find(l => l.id === v);
      if (found) this.app.openEditor(found, true);
    });

    this.meta.replaceChildren(...[
      levelPicker,
      h('label', { class: 'field' }, 'Name', name),
      h('div', { class: 'row' },
        num(lv.width, 4, 24, v => this.resize(v, lv.height), 'Width'),
        num(lv.height, 4, 20, v => this.resize(lv.width, v), 'Height')),
      h('div', { class: 'row' },
        num(lv.timeLimit.minutes, 0, 9, v => { this.snapshot(); lv.timeLimit.minutes = Math.max(0, Math.min(9, v | 0)); this.changed(); }, 'Minutes'),
        num(lv.timeLimit.seconds, 0, 59, v => { this.snapshot(); lv.timeLimit.seconds = Math.max(0, Math.min(59, v | 0)); this.changed(); }, 'Seconds')),
      h('label', { class: 'field' }, 'Elevator', dir),
      this.messages,
      h('div', { style: 'flex:1' }),
      h('button', { class: 'btn', onclick: () => this.exportJson() }, 'Export JSON'),
      ro ? null : h('button', { class: 'btn ghost', onclick: () => importInput.click() }, 'Import JSON'),
      ro ? null : h('button', { class: 'btn ghost', onclick: () => { this.app.deleteCustomLevel(lv.id); this.app.openEditor(); } }, 'Delete level'),
      importInput,
    ].filter((n): n is HTMLElement => n !== null));
    this.renderMessages();
  }

  private exportJson(): void {
    const blob = new Blob([JSON.stringify(this.level, null, 2) + '\n'], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `${this.level.id}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  frame(now: number): void {
    this.renderer.layout(this.level.width, this.level.height);
    this.renderer.render(this.play, this.fx, now, { reducedMotion: true, debug: this.app.debug });
  }

  onKey(e: KeyboardEvent): boolean {
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ') { if (e.shiftKey) this.redo(); else this.undo(); return true; }
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyY') { this.redo(); return true; }
    if (!this.readOnly && /^Digit[1-8]$/.test(e.code)) { this.setTool(e.code.slice(5) as Tool); return true; }
    return false;
  }
}
