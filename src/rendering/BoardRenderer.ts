// Draws a Play onto a canvas. Reads state; never changes it.

import { Tile, isBlock } from '../levels/format.ts';
import { SUBSTEPS } from '../game/rules.ts';
import type { Play } from '../game/Play.ts';
import type { GridPosition } from '../game/types.ts';
import { Effects } from './effects.ts';
import { MATERIAL } from './palette.ts';
import { SpriteSet, roundRect } from './sprites.ts';

export interface RenderOptions {
  reducedMotion: boolean;
  debug: boolean;
}

export class BoardRenderer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private sprites: SpriteSet | null = null;
  private staticLayer: HTMLCanvasElement | null = null;
  private staticKey = '';
  /** Device pixels per cell, and the board origin within the canvas. */
  cell = 32;
  private ox = 0;
  private oy = 0;
  private dpr = 1;
  private cursorDraw: { x: number; y: number } | null = null;
  private lastNow = 0;
  private boardW = 14;
  private boardH = 12;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
  }

  /**
   * Fit a board of w x h cells into the canvas's CSS box. With `crop`, only that rectangle
   * of cells (a level's playfield, without the void around it) is fitted, so oddly shaped
   * levels use the whole screen.
   */
  layout(boardW: number, boardH: number, crop?: { x0: number; y0: number; x1: number; y1: number }): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const pw = Math.max(1, Math.round(rect.width * dpr)), ph = Math.max(1, Math.round(rect.height * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    this.dpr = dpr;
    this.boardW = boardW;
    this.boardH = boardH;
    const c = crop ?? { x0: 0, y0: 0, x1: boardW - 1, y1: boardH - 1 };
    const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
    // a little room around the playfield for the glow and blasts at the edge
    const margin = crop ? 0.35 : 0;
    const cell = Math.max(8, Math.floor(Math.min(pw / (cw + margin * 2), ph / (ch + margin * 2))));
    if (!this.sprites || this.sprites.cell !== cell) {
      this.sprites = new SpriteSet(cell);
      this.staticKey = '';
    }
    this.cell = cell;
    this.ox = Math.floor((pw - cell * cw) / 2) - c.x0 * cell;
    this.oy = Math.floor((ph - cell * ch) / 2) - c.y0 * cell;
  }

  /** The rectangle of non-void cells of a level. */
  static playfieldBounds(tiles: string[]): { x0: number; y0: number; x1: number; y1: number } {
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    tiles.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        if (row[x] === ' ') continue;
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
    });
    return x1 < 0 ? { x0: 0, y0: 0, x1: tiles[0].length - 1, y1: tiles.length - 1 } : { x0, y0, x1, y1 };
  }

  /** The board cell under a client (CSS) point, or null outside the board. */
  cellAt(clientX: number, clientY: number): GridPosition | null {
    const rect = this.canvas.getBoundingClientRect();
    const px = (clientX - rect.left) * this.dpr - this.ox, py = (clientY - rect.top) * this.dpr - this.oy;
    const x = Math.floor(px / this.cell), y = Math.floor(py / this.cell);
    if (x < 0 || y < 0 || x >= this.boardW || y >= this.boardH) return null;
    return { x, y };
  }

  /** Fractional column under a client x, for drags. */
  columnAt(clientX: number): number {
    const rect = this.canvas.getBoundingClientRect();
    return ((clientX - rect.left) * this.dpr - this.ox) / this.cell;
  }

  /** CSS-pixel rectangle of a board cell, relative to the canvas. */
  cellRect(x: number, y: number): { left: number; top: number; size: number } {
    return { left: (this.ox + x * this.cell) / this.dpr, top: (this.oy + y * this.cell) / this.dpr, size: this.cell / this.dpr };
  }

  private buildStatic(play: Play): HTMLCanvasElement {
    const s = play.state, n = this.cell, sp = this.sprites!;
    const key = `${play.level.id}:${n}:${s.width}x${s.height}:${play.level.tiles.join("|")}:${play.level.elevator?.x},${play.level.elevator?.y}`;
    if (this.staticLayer && this.staticKey === key) return this.staticLayer;
    const c = document.createElement('canvas');
    c.width = n * s.width;
    c.height = n * s.height;
    const ctx = c.getContext('2d')!;
    // original tiles from the level data: walls never change during play
    const tileAt = (x: number, y: number): string => (x < 0 || y < 0 || x >= s.width || y >= s.height) ? ' ' : play.level.tiles[y][x];
    // soft glow under the whole playfield silhouette
    ctx.save();
    ctx.shadowColor = 'rgba(90, 110, 255, 0.35)';
    ctx.shadowBlur = n * 0.6;
    for (let y = 0; y < s.height; y++) for (let x = 0; x < s.width; x++) {
      if (tileAt(x, y) !== ' ') { ctx.fillStyle = MATERIAL.frameDark; ctx.fillRect(x * n, y * n, n, n); }
    }
    ctx.restore();
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        const t = tileAt(x, y);
        if (t === ' ') continue;
        if (t === '#') {
          const f = (dx: number, dy: number) => tileAt(x + dx, y + dy) === '#' ? 1 : 0;
          const mask = f(0, -1) | (f(1, 0) << 1) | (f(0, 1) << 2) | (f(-1, 0) << 3);
          ctx.drawImage(sp.frame(mask), x * n, y * n);
          continue;
        }
        ctx.drawImage(sp.floorTile(), x * n, y * n);
        if (t === '=') ctx.drawImage(sp.innerWall(), x * n, y * n);
      }
    }
    // elevator track: the stretch of its column not blocked by walls
    const e = play.level.elevator;
    if (e) {
      let top = e.y, bottom = e.y;
      while (top - 1 >= 0 && !'#='.includes(tileAt(e.x, top - 1))) top--;
      while (bottom + 1 < s.height && !'#='.includes(tileAt(e.x, bottom + 1))) bottom++;
      ctx.fillStyle = MATERIAL.track;
      roundRect(ctx, e.x * n + n * 0.38, top * n + n * 0.1, n * 0.24, (bottom - top + 1) * n - n * 0.2, n * 0.12);
      ctx.fill();
    }
    this.staticLayer = c;
    this.staticKey = key;
    return c;
  }

  render(play: Play, fx: Effects, now: number, opts: RenderOptions): void {
    const dt = this.lastNow ? Math.min(0.05, (now - this.lastNow) / 1000) : 0;
    this.lastNow = now;
    const s = play.state, n = this.cell, sp = this.sprites!, ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const [sx, sy] = fx.shakeOffset(now);
    ctx.translate(this.ox + sx * n, this.oy + sy * n);
    ctx.drawImage(this.buildStatic(play), 0, 0);

    const e = s.elevator;
    const falling = new Set(s.fallOffset > 0 ? s.falling.map(f => f.y * s.width + f.x) : []);
    let elevatorShift = 0;
    if (e) {
      elevatorShift = e.offset / SUBSTEPS;
      if (e.offset !== 0 && e.pause === 0 && !opts.reducedMotion) elevatorShift += (e.dir * play.sim.elevatorPhase) / SUBSTEPS;
    }
    const onStack = (x: number, y: number) => !!e && x === e.x && y >= e.y - e.stack && y < e.y;
    const yShift = (x: number, y: number) => {
      if (falling.has(y * s.width + x)) return s.fallOffset / SUBSTEPS;
      if (onStack(x, y)) return elevatorShift;
      return 0;
    };

    // elevator platform
    if (e) ctx.drawImage(sp.elevatorTile(e.dir), e.x * n, (e.y + elevatorShift) * n);

    const cur = s.cursor;
    const pulse = opts.reducedMotion ? 0 : Math.sin(now / 160) * 0.5 + 0.5;
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        const v = s.cells[y * s.width + x];
        if (!isBlock(v)) continue;
        const dy = yShift(x, y);
        const carried = s.carrying && x === cur.x && y === cur.y;
        if (carried) {
          const lift = n * 0.06, grow = n * 0.08;
          ctx.save();
          ctx.shadowColor = 'rgba(255, 216, 74, 0.55)';
          ctx.shadowBlur = n * (0.35 + pulse * 0.15);
          ctx.drawImage(sp.block(v), x * n - grow / 2, (y + dy) * n - grow / 2 - lift, n + grow, n + grow);
          ctx.restore();
        } else {
          ctx.drawImage(sp.block(v), x * n, (y + dy) * n);
        }
      }
    }

    // blocks being blasted: already gone from the board, drawn from the effect
    for (const b of fx.blasts) {
      const t = (now - b.start) / b.duration;
      for (const c of b.cells) {
        const cx = c.x * n, cy = (c.y + (onStack(c.x, c.y) ? elevatorShift : 0)) * n;
        if (t < 0.5) {
          // flicker, as the original flashes the pair before it vanishes
          const flash = opts.reducedMotion ? t * 1.6 : (Math.floor(t * 20) % 2 === 0 ? 0.9 : 0.15);
          const k = 1 + Math.sin(t * Math.PI * 2) * 0.05;
          ctx.drawImage(sp.block(c.block, flash), cx + (n - n * k) / 2, cy + (n - n * k) / 2, n * k, n * k);
        } else if (t < 0.75) {
          const u = (t - 0.5) / 0.25;
          const k = 1 + u * 0.35;
          ctx.globalAlpha = 1 - u;
          ctx.drawImage(sp.block(c.block, 1), cx + (n - n * k) / 2, cy + (n - n * k) / 2, n * k, n * k);
          ctx.globalAlpha = 1;
        }
      }
    }

    // cursor
    const cdy = s.cursorFalling ? s.fallOffset / SUBSTEPS : s.riding ? elevatorShift : 0;
    const target = { x: cur.x, y: cur.y + cdy };
    if (!this.cursorDraw || opts.reducedMotion) this.cursorDraw = { ...target };
    else {
      const k = 1 - Math.exp(-dt * 28);
      this.cursorDraw.x += (target.x - this.cursorDraw.x) * k;
      this.cursorDraw.y += (target.y - this.cursorDraw.y) * k;
      if (Math.abs(target.x - this.cursorDraw.x) > 3 || Math.abs(target.y - this.cursorDraw.y) > 3) this.cursorDraw = { ...target };
    }
    this.drawCursor(ctx, this.cursorDraw.x * n, this.cursorDraw.y * n, n, s.carrying, pulse);

    fx.draw(ctx, n, dt, now);

    if (opts.debug) this.drawDebug(ctx, play, n);
  }

  private drawCursor(ctx: CanvasRenderingContext2D, x: number, y: number, n: number, carrying: boolean, pulse: number): void {
    const color = carrying ? MATERIAL.cursorCarry : MATERIAL.cursor;
    const pad = n * (carrying ? -0.1 : -0.04) - pulse * n * 0.02;
    const len = n * 0.3, w = Math.max(2, n * 0.08), r = n * 0.16;
    const x0 = x + pad, y0 = y + pad, x1 = x + n - pad, y1 = y + n - pad;
    ctx.save();
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.shadowColor = color;
    ctx.shadowBlur = n * 0.25;
    const corners = () => {
      ctx.beginPath();
      ctx.moveTo(x0, y0 + len); ctx.lineTo(x0, y0 + r); ctx.arcTo(x0, y0, x0 + r, y0, r); ctx.lineTo(x0 + len, y0);
      ctx.moveTo(x1 - len, y0); ctx.lineTo(x1 - r, y0); ctx.arcTo(x1, y0, x1, y0 + r, r); ctx.lineTo(x1, y0 + len);
      ctx.moveTo(x1, y1 - len); ctx.lineTo(x1, y1 - r); ctx.arcTo(x1, y1, x1 - r, y1, r); ctx.lineTo(x1 - len, y1);
      ctx.moveTo(x0 + len, y1); ctx.lineTo(x0 + r, y1); ctx.arcTo(x0, y1, x0, y1 - r, r); ctx.lineTo(x0, y1 - len);
    };
    corners();
    ctx.lineWidth = w + 3;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.lineWidth = w;
    corners();
    ctx.stroke();
    ctx.restore();
  }

  private drawDebug(ctx: CanvasRenderingContext2D, play: Play, n: number): void {
    const s = play.state;
    ctx.save();
    ctx.font = `${Math.max(8, Math.round(n * 0.22))}px ui-monospace, monospace`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    for (let y = 0; y < s.height; y++) {
      for (let x = 0; x < s.width; x++) {
        if (play.level.tiles[y][x] === ' ') continue;
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillText(`${x},${y}`, x * n + 2, y * n + 2);
        const v = s.cells[y * s.width + x];
        if (v !== Tile.Empty && !isBlock(v) && v !== Tile.Frame && v !== Tile.Wall) {
          ctx.fillStyle = '#0ff';
          ctx.fillText(v.toString(16), x * n + 2, y * n + n * 0.5);
        }
      }
    }
    ctx.strokeStyle = 'rgba(0,255,255,0.8)';
    ctx.lineWidth = 2;
    for (const f of s.falling) ctx.strokeRect(f.x * n + 3, f.y * n + 3, n - 6, n - 6);
    ctx.restore();
  }
}
