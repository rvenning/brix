// Small images for menus: block icons and level previews.

import type { LevelData } from '../levels/format.ts';
import { SpriteSet } from './sprites.ts';
import { BLOCKS, MATERIAL } from './palette.ts';

const iconCache = new Map<string, string>();

export function blockIcon(type: number, px = 52): string {
  const key = `${type}:${px}`;
  let url = iconCache.get(key);
  if (!url) {
    url = new SpriteSet(px).block(type).toDataURL();
    iconCache.set(key, url);
  }
  return url;
}

const previewCache = new Map<string, string>();

/** A flat, fast preview of a level's starting layout. */
export function levelPreview(level: LevelData, cell = 10): string {
  const key = `${level.id}:${cell}:${level.tiles.join('')}:${level.elevator?.x},${level.elevator?.y}`;
  const hit = previewCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = level.width * cell;
  c.height = level.height * cell;
  const ctx = c.getContext('2d')!;
  const r = Math.max(1, cell * 0.22);
  for (let y = 0; y < level.height; y++) {
    for (let x = 0; x < level.width; x++) {
      const t = level.tiles[y][x];
      const px = x * cell, py = y * cell;
      if (t === ' ') continue;
      if (t === '#') { ctx.fillStyle = MATERIAL.frameLight; ctx.fillRect(px, py, cell, cell); continue; }
      ctx.fillStyle = MATERIAL.floor;
      ctx.fillRect(px, py, cell, cell);
      if (t === '=') { ctx.fillStyle = MATERIAL.wallBase; ctx.fillRect(px + 0.5, py + 0.5, cell - 1, cell - 1); }
      if (t >= '1' && t <= '8') {
        const s = BLOCKS[Number(t)];
        ctx.fillStyle = s.base;
        ctx.beginPath();
        ctx.roundRect(px + 1, py + 1, cell - 2, cell - 2, r);
        ctx.fill();
      }
    }
  }
  if (level.elevator) {
    ctx.fillStyle = MATERIAL.elevatorBase;
    ctx.fillRect(level.elevator.x * cell + 1, level.elevator.y * cell + cell * 0.2, cell - 2, cell * 0.6);
  }
  const url = c.toDataURL();
  previewCache.set(key, url);
  return url;
}
