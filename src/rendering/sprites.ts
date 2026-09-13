// Board artwork, drawn once per cell size into offscreen canvases and blitted per frame.

import { BLOCKS, MATERIAL, type Glyph } from './palette.ts';

type Canvas2D = HTMLCanvasElement;

function makeCanvas(w: number, h: number): [Canvas2D, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  const ctx = c.getContext('2d')!;
  return [c, ctx];
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number | [number, number, number, number]): void {
  const [tl, tr, br, bl] = typeof r === 'number' ? [r, r, r, r] : r;
  ctx.beginPath();
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

/** Glyph path centred on (cx, cy) fitting a circle of radius r. */
export function glyphPath(ctx: CanvasRenderingContext2D, glyph: Glyph, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  switch (glyph) {
    case 'circle':
      ctx.arc(cx, cy, r * 0.78, 0, Math.PI * 2);
      break;
    case 'triangle': {
      const h = r * 0.95;
      ctx.moveTo(cx, cy - h);
      ctx.lineTo(cx + h * 0.95, cy + h * 0.72);
      ctx.lineTo(cx - h * 0.95, cy + h * 0.72);
      ctx.closePath();
      break;
    }
    case 'star':
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 === 0 ? r * 1.0 : r * 0.44;
        const px = cx + Math.cos(a) * rr, py = cy + Math.sin(a) * rr + r * 0.06;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    case 'diamond':
      ctx.moveTo(cx, cy - r);
      ctx.lineTo(cx + r * 0.78, cy);
      ctx.lineTo(cx, cy + r);
      ctx.lineTo(cx - r * 0.78, cy);
      ctx.closePath();
      break;
    case 'hexagon':
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + (i * Math.PI) / 3;
        const px = cx + Math.cos(a) * r * 0.86, py = cy + Math.sin(a) * r * 0.86;
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      break;
    case 'heart': {
      const s = r * 0.92;
      ctx.moveTo(cx, cy + s * 0.9);
      ctx.bezierCurveTo(cx - s * 1.25, cy + s * 0.05, cx - s * 0.7, cy - s * 1.0, cx, cy - s * 0.35);
      ctx.bezierCurveTo(cx + s * 0.7, cy - s * 1.0, cx + s * 1.25, cy + s * 0.05, cx, cy + s * 0.9);
      ctx.closePath();
      break;
    }
    case 'cross': {
      const a = r * 0.3, b = r * 0.88;
      ctx.moveTo(cx - a, cy - b);
      ctx.lineTo(cx + a, cy - b);
      ctx.lineTo(cx + a, cy - a);
      ctx.lineTo(cx + b, cy - a);
      ctx.lineTo(cx + b, cy + a);
      ctx.lineTo(cx + a, cy + a);
      ctx.lineTo(cx + a, cy + b);
      ctx.lineTo(cx - a, cy + b);
      ctx.lineTo(cx - a, cy + a);
      ctx.lineTo(cx - b, cy + a);
      ctx.lineTo(cx - b, cy - a);
      ctx.lineTo(cx - a, cy - a);
      ctx.closePath();
      break;
    }
    case 'crescent':
      ctx.arc(cx, cy, r * 0.84, Math.PI * 0.2, Math.PI * 1.8, false);
      ctx.arc(cx + r * 0.42, cy - r * 0.12, r * 0.62, Math.PI * 1.62, Math.PI * 0.38, true);
      ctx.closePath();
      break;
  }
}

export class SpriteSet {
  readonly cell: number;
  private blocks = new Map<string, Canvas2D>();
  private frames = new Map<number, Canvas2D>();
  private wall: Canvas2D | null = null;
  private floor: Canvas2D | null = null;
  private elevator = new Map<number, Canvas2D>();

  constructor(cell: number) {
    this.cell = cell;
  }

  /** A block of `type`; `flash` 0..1 washes it towards white. */
  block(type: number, flash = 0): Canvas2D {
    const f = Math.round(flash * 4);
    const key = `${type}:${f}`;
    let c = this.blocks.get(key);
    if (!c) {
      c = this.drawBlock(type, f / 4);
      this.blocks.set(key, c);
    }
    return c;
  }

  private drawBlock(type: number, flash: number): Canvas2D {
    const n = this.cell;
    const style = BLOCKS[type] ?? BLOCKS[8];
    const [c, ctx] = makeCanvas(n, n);
    const inset = n * 0.045, size = n - inset * 2, rad = n * 0.2;
    // drop shadow
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.45)';
    ctx.shadowBlur = n * 0.06;
    ctx.shadowOffsetY = n * 0.04;
    roundRect(ctx, inset, inset, size, size, rad);
    ctx.fillStyle = style.dark;
    ctx.fill();
    ctx.restore();
    // body
    const g = ctx.createLinearGradient(0, inset, 0, inset + size);
    g.addColorStop(0, style.light);
    g.addColorStop(0.42, style.base);
    g.addColorStop(1, style.dark);
    roundRect(ctx, inset, inset, size, size, rad);
    ctx.fillStyle = g;
    ctx.fill();
    // bevel rim
    roundRect(ctx, inset + n * 0.03, inset + n * 0.03, size - n * 0.06, size - n * 0.06, rad * 0.8);
    ctx.lineWidth = Math.max(1, n * 0.03);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.stroke();
    // gloss
    ctx.save();
    roundRect(ctx, inset, inset, size, size, rad);
    ctx.clip();
    const gloss = ctx.createLinearGradient(0, inset, 0, inset + size * 0.5);
    gloss.addColorStop(0, 'rgba(255,255,255,0.55)');
    gloss.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gloss;
    ctx.beginPath();
    ctx.ellipse(n * 0.5, inset + size * 0.08, size * 0.62, size * 0.36, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // glyph
    const cx = n / 2, cy = n / 2 + n * 0.01, r = n * 0.25;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = n * 0.03;
    ctx.shadowOffsetY = n * 0.02;
    glyphPath(ctx, style.glyph, cx, cy, r);
    ctx.fillStyle = style.ink;
    ctx.fill();
    ctx.restore();
    // outline
    roundRect(ctx, inset + 0.5, inset + 0.5, size - 1, size - 1, rad);
    ctx.lineWidth = Math.max(1, n * 0.025);
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.stroke();
    if (flash > 0) {
      ctx.globalCompositeOperation = 'source-atop';
      ctx.fillStyle = `rgba(255,255,255,${0.85 * flash})`;
      ctx.fillRect(0, 0, n, n);
      ctx.globalCompositeOperation = 'source-over';
    }
    return c;
  }

  /** Frame wall; `mask` bits say which neighbours are also frame: 1 up, 2 right, 4 down, 8 left. */
  frame(mask: number): Canvas2D {
    let c = this.frames.get(mask);
    if (c) return c;
    const n = this.cell;
    let ctx: CanvasRenderingContext2D;
    [c, ctx] = makeCanvas(n, n);
    const up = mask & 1, right = mask & 2, down = mask & 4, left = mask & 8;
    const r = n * 0.28;
    const radii: [number, number, number, number] = [
      !up && !left ? r : 0, !up && !right ? r : 0, !down && !right ? r : 0, !down && !left ? r : 0,
    ];
    const g = ctx.createLinearGradient(0, 0, 0, n);
    g.addColorStop(0, MATERIAL.frameLight);
    g.addColorStop(0.35, MATERIAL.frameBase);
    g.addColorStop(1, MATERIAL.frameDark);
    roundRect(ctx, 0, 0, n, n, radii);
    ctx.fillStyle = g;
    ctx.fill();
    // stone texture: a few soft specks at fixed positions
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    for (const [px, py, pr] of [[0.28, 0.35, 0.09], [0.7, 0.62, 0.07], [0.45, 0.8, 0.05]]) {
      ctx.beginPath();
      ctx.arc(px * n, py * n, pr * n, 0, Math.PI * 2);
      ctx.fill();
    }
    // bevels on open edges
    const bw = Math.max(1, n * 0.09);
    ctx.save();
    roundRect(ctx, 0, 0, n, n, radii);
    ctx.clip();
    if (!up) { ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(0, 0, n, bw); }
    if (!left) { ctx.fillStyle = 'rgba(255,255,255,0.1)'; ctx.fillRect(0, 0, bw, n); }
    if (!down) { ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.fillRect(0, n - bw, n, bw); }
    if (!right) { ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(n - bw, 0, bw, n); }
    ctx.restore();
    this.frames.set(mask, c);
    return c;
  }

  /** Inner wall: a carved slab, lighter than the frame. */
  innerWall(): Canvas2D {
    if (this.wall) return this.wall;
    const n = this.cell;
    const [c, ctx] = makeCanvas(n, n);
    const inset = n * 0.03, size = n - inset * 2;
    const g = ctx.createLinearGradient(0, 0, 0, n);
    g.addColorStop(0, MATERIAL.wallLight);
    g.addColorStop(0.5, MATERIAL.wallBase);
    g.addColorStop(1, MATERIAL.wallDark);
    roundRect(ctx, inset, inset, size, size, n * 0.1);
    ctx.fillStyle = g;
    ctx.fill();
    // brick seams
    ctx.strokeStyle = 'rgba(20,24,48,0.45)';
    ctx.lineWidth = Math.max(1, n * 0.035);
    ctx.beginPath();
    ctx.moveTo(inset, n / 2); ctx.lineTo(n - inset, n / 2);
    ctx.moveTo(n * 0.5, inset); ctx.lineTo(n * 0.5, n / 2);
    ctx.moveTo(n * 0.25, n / 2); ctx.lineTo(n * 0.25, n - inset);
    ctx.moveTo(n * 0.75, n / 2); ctx.lineTo(n * 0.75, n - inset);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = Math.max(1, n * 0.03);
    ctx.beginPath();
    ctx.moveTo(inset + n * 0.06, inset + n * 0.05); ctx.lineTo(n - inset - n * 0.06, inset + n * 0.05);
    ctx.stroke();
    this.wall = c;
    return c;
  }

  floorTile(): Canvas2D {
    if (this.floor) return this.floor;
    const n = this.cell;
    const [c, ctx] = makeCanvas(n, n);
    ctx.fillStyle = MATERIAL.floor;
    ctx.fillRect(0, 0, n, n);
    // a faint recessed well per cell keeps the grid readable without a pattern
    roundRect(ctx, n * 0.08, n * 0.08, n * 0.84, n * 0.84, n * 0.18);
    ctx.fillStyle = MATERIAL.floorDot;
    ctx.fill();
    this.floor = c;
    return c;
  }

  /** Elevator platform with a direction chevron (-1 up, 1 down, 0 none). */
  elevatorTile(dir: number): Canvas2D {
    let c = this.elevator.get(dir);
    if (c) return c;
    const n = this.cell;
    let ctx: CanvasRenderingContext2D;
    [c, ctx] = makeCanvas(n, n);
    const inset = n * 0.04;
    const g = ctx.createLinearGradient(0, 0, 0, n);
    g.addColorStop(0, MATERIAL.elevatorLight);
    g.addColorStop(0.45, MATERIAL.elevatorBase);
    g.addColorStop(1, MATERIAL.elevatorDark);
    roundRect(ctx, inset, n * 0.08, n - inset * 2, n * 0.84, n * 0.14);
    ctx.fillStyle = g;
    ctx.fill();
    // hazard-free rails: two dark grooves
    ctx.fillStyle = 'rgba(80,45,0,0.35)';
    ctx.fillRect(n * 0.12, n * 0.24, n * 0.76, n * 0.06);
    ctx.fillRect(n * 0.12, n * 0.7, n * 0.76, n * 0.06);
    if (dir !== 0) {
      ctx.save();
      ctx.translate(n / 2, n / 2);
      if (dir > 0) ctx.rotate(Math.PI);
      ctx.beginPath();
      ctx.moveTo(-n * 0.2, n * 0.1);
      ctx.lineTo(0, -n * 0.12);
      ctx.lineTo(n * 0.2, n * 0.1);
      ctx.lineWidth = n * 0.09;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(90,50,0,0.85)';
      ctx.stroke();
      ctx.restore();
    }
    this.elevator.set(dir, c);
    return c;
  }
}
