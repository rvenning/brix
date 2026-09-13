// Slow-drifting block glyphs behind every screen. Cheap: a few dozen shapes, no per-frame allocation.

import { BLOCKS } from './palette.ts';
import { glyphPath } from './sprites.ts';

interface Mote { x: number; y: number; r: number; speed: number; drift: number; phase: number; type: number; spin: number }

export class Backdrop {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private motes: Mote[] = [];
  reducedMotion = false;
  private dpr = 1;

  constructor(host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    for (let i = 0; i < 26; i++) {
      this.motes.push({
        x: Math.random(), y: Math.random(), r: 8 + Math.random() * 26, speed: 0.004 + Math.random() * 0.01,
        drift: (Math.random() - 0.5) * 0.02, phase: Math.random() * 6.28, type: 1 + (i % 8), spin: (Math.random() - 0.5) * 0.3,
      });
    }
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(window.innerWidth * this.dpr);
    this.canvas.height = Math.round(window.innerHeight * this.dpr);
  }

  render(now: number, dt: number): void {
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const w = canvas.width, hgt = canvas.height;
    for (const m of this.motes) {
      if (!this.reducedMotion) {
        m.y -= m.speed * dt;
        m.x += Math.sin(now / 4000 + m.phase) * m.drift * dt;
        if (m.y < -0.1) { m.y = 1.1; m.x = Math.random(); }
      }
      const s = BLOCKS[m.type];
      ctx.save();
      ctx.translate(m.x * w, m.y * hgt);
      ctx.rotate(this.reducedMotion ? m.phase : now / 1000 * m.spin + m.phase);
      ctx.globalAlpha = 0.07;
      glyphPath(ctx, s.glyph, 0, 0, m.r * this.dpr);
      ctx.fillStyle = s.base;
      ctx.fill();
      ctx.restore();
    }
  }
}
