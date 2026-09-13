// Transient visual effects: blasts, particles, floating score text, screen shake.
// Purely presentational; nothing here feeds back into the rules.

import { BLOCKS, type Glyph } from './palette.ts';
import { glyphPath } from './sprites.ts';

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; age: number; size: number; spin: number; angle: number;
  color: string; glyph: Glyph | null;
}

export interface BlastFx {
  cells: { x: number; y: number; block: number }[];
  start: number;
  duration: number;
  popped: boolean;
}

interface Floater { x: number; y: number; text: string; color: string; start: number; duration: number; size: number }
interface Ring { x: number; y: number; start: number; duration: number; color: string }

export class Effects {
  reducedMotion = false;
  readonly blasts: BlastFx[] = [];
  private particles: Particle[] = [];
  private floaters: Floater[] = [];
  private rings: Ring[] = [];
  private shakeUntil = 0;
  private shakeAmp = 0;

  clear(): void {
    this.blasts.length = 0;
    this.particles.length = 0;
    this.floaters.length = 0;
    this.rings.length = 0;
    this.shakeUntil = 0;
  }

  blast(cells: BlastFx['cells'], now: number, duration: number, points: number, bonus: number, chain: number): void {
    // duplicates (the stack quirk) show once
    const seen = new Set<string>();
    const unique = cells.filter(c => { const k = `${c.x},${c.y}`; if (seen.has(k)) return false; seen.add(k); return true; });
    this.blasts.push({ cells: unique, start: now, duration, popped: false });
    const cx = unique.reduce((a, c) => a + c.x, 0) / unique.length + 0.5;
    const cy = unique.reduce((a, c) => a + c.y, 0) / unique.length + 0.5;
    const popAt = now + duration * 0.5;
    this.floaters.push({ x: cx, y: cy - 0.2, text: `+${points}`, color: '#ffffff', start: popAt, duration: 1100, size: 0.55 });
    if (bonus > 0) {
      this.floaters.push({ x: cx, y: cy - 0.9, text: `CHAIN ${chain} +${bonus}`, color: '#ffd84a', start: popAt + 80, duration: 1500, size: 0.62 });
    }
  }

  update(now: number): void {
    for (const b of this.blasts) {
      if (!b.popped && now >= b.start + b.duration * 0.5) {
        b.popped = true;
        for (const c of b.cells) this.burst(c.x + 0.5, c.y + 0.5, c.block, now);
        if (!this.reducedMotion) this.shake(now, Math.min(0.12, 0.04 + b.cells.length * 0.012), 220);
      }
    }
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      if (now > b.start + b.duration) this.blasts.splice(i, 1);
    }
  }

  private burst(x: number, y: number, block: number, now: number): void {
    const style = BLOCKS[block] ?? BLOCKS[8];
    this.rings.push({ x, y, start: now, duration: 420, color: style.light });
    const count = this.reducedMotion ? 4 : 14;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + Math.random() * 0.5;
      const speed = 2.2 + Math.random() * 3.5;
      this.particles.push({
        x, y, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed - 2.5,
        life: 0.55 + Math.random() * 0.45, age: 0, size: 0.08 + Math.random() * 0.1,
        spin: (Math.random() - 0.5) * 12, angle: Math.random() * 6,
        color: i % 3 === 0 ? style.light : style.base, glyph: i % 4 === 0 ? style.glyph : null,
      });
    }
  }

  private shake(now: number, amp: number, ms: number): void {
    this.shakeAmp = Math.max(this.shakeAmp * (this.shakeUntil > now ? 1 : 0), amp);
    this.shakeUntil = now + ms;
  }

  /** Current shake offset in cells. */
  shakeOffset(now: number): [number, number] {
    if (now >= this.shakeUntil || this.reducedMotion) return [0, 0];
    const k = (this.shakeUntil - now) / 220;
    return [Math.sin(now * 0.09) * this.shakeAmp * k, Math.cos(now * 0.11) * this.shakeAmp * k];
  }

  /** Blast progress for a cell, if it is part of an active blast: 0..1. */
  blastAt(x: number, y: number, now: number): { t: number; block: number } | null {
    for (const b of this.blasts) {
      for (const c of b.cells) if (c.x === x && c.y === y) return { t: (now - b.start) / b.duration, block: c.block };
    }
    return null;
  }

  draw(ctx: CanvasRenderingContext2D, cell: number, dt: number, now: number): void {
    const g = 14;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) { this.particles.splice(i, 1); continue; }
      p.vy += g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.angle += p.spin * dt;
      const alpha = 1 - p.age / p.life;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      if (p.glyph) {
        ctx.save();
        ctx.translate(p.x * cell, p.y * cell);
        ctx.rotate(p.angle);
        glyphPath(ctx, p.glyph, 0, 0, p.size * cell * 1.6);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x * cell, p.y * cell, p.size * cell * (0.6 + alpha * 0.4), 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      const t = (now - r.start) / r.duration;
      if (t >= 1) { this.rings.splice(i, 1); continue; }
      if (t < 0) continue;
      ctx.globalAlpha = (1 - t) * 0.8;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = cell * 0.08 * (1 - t);
      ctx.beginPath();
      ctx.arc(r.x * cell, r.y * cell, cell * (0.3 + t * 0.9), 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      const t = (now - f.start) / f.duration;
      if (t >= 1) { this.floaters.splice(i, 1); continue; }
      if (t < 0) continue;
      const rise = this.reducedMotion ? 0 : t * 0.9;
      const scale = t < 0.15 ? 0.6 + (t / 0.15) * 0.4 : 1;
      ctx.globalAlpha = t > 0.7 ? (1 - t) / 0.3 : 1;
      ctx.font = `700 ${Math.round(f.size * cell * scale)}px "Fredoka Variable", "Fredoka", system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = cell * 0.12;
      ctx.strokeStyle = 'rgba(8,10,30,0.85)';
      ctx.strokeText(f.text, f.x * cell, (f.y - rise) * cell);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x * cell, (f.y - rise) * cell);
    }
    ctx.globalAlpha = 1;
  }

  get busy(): boolean {
    return this.blasts.length > 0 || this.particles.length > 0 || this.floaters.length > 0;
  }
}
