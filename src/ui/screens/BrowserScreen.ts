import { treeIndex, type LevelData } from '../../levels/format.ts';
import { levelPreview } from '../../rendering/thumbnails.ts';
import type { LevelRecord } from '../../storage/storage.ts';
import { h, svgIcon, formatScore } from '../dom.ts';
import type { App, Screen } from '../App.ts';

/**
 * Practice mode: every problem the player has reached. Unlocking follows the tree:
 * all of levels 1-5 start open, a problem opens once the one before it in its choice
 * is cleared, and a choice in levels 6-7 opens once a neighbouring choice in the
 * level before is fully cleared.
 */
export function isUnlocked(index: number, levels: LevelData[], records: Record<string, LevelRecord>): boolean {
  const lvl = levels[index];
  const t = lvl.tree!;
  const cleared = (i: number) => !!records[levels[i].id]?.cleared;
  if (t.problem > 1) return cleared(index - 1);
  if (t.level <= 5) return true;
  const choiceDone = (level: number, choice: number) =>
    choice >= 1 && choice <= level && [1, 2, 3, 4].every(p => cleared(treeIndex(level, choice, p)));
  if (t.level === 7 && t.choice > 1 && choiceDone(7, t.choice - 1)) return true;
  return choiceDone(t.level - 1, t.choice) || choiceDone(t.level - 1, t.choice - 1);
}

export class BrowserScreen implements Screen {
  readonly el: HTMLElement;

  constructor(app: App, onPlay: (level: LevelData) => void, onBack: () => void) {
    const records = app.records;
    const levels = app.levels;
    const cleared = levels.filter(l => records[l.id]?.cleared).length;
    const stars = levels.reduce((a, l) => a + (records[l.id]?.stars ?? 0), 0);

    const body = h('div', { class: 'browser' });
    for (let lv = 1; lv <= 7; lv++) {
      const choices = h('div', { class: 'choices' });
      for (let ch = 1; ch <= lv; ch++) {
        const problems = h('div', { class: 'problems' });
        for (let p = 1; p <= 4; p++) {
          const i = treeIndex(lv, ch, p);
          const level = levels[i];
          const rec = records[level.id];
          const open = isUnlocked(i, levels, records);
          problems.append(h('button', {
            class: 'problem',
            disabled: !open,
            'aria-label': `Problem ${lv}-${ch}-${p}${rec?.cleared ? `, cleared, ${rec.stars} stars, best ${rec.bestPoints} points` : open ? '' : ', locked'}`,
            title: rec?.cleared ? `Best ${formatScore(rec.bestPoints)} pts · ${rec.bestSeconds}s` : '',
            onclick: () => onPlay(level),
          },
          h('img', { src: levelPreview(level, 10), alt: '' }),
          h('span', { class: 'num' }, `${lv}-${ch}-${p}`),
          h('span', { class: 'mini-stars', 'aria-hidden': 'true' }, rec?.cleared ? '★'.repeat(rec.stars) + '☆'.repeat(3 - rec.stars) : ''),
          ));
        }
        choices.append(h('div', { class: 'choice panel' }, h('div', { class: 'choice-head' }, h('span', {}, `Choice ${ch}`), h('span', {}, `${[1, 2, 3, 4].filter(p => records[levels[treeIndex(lv, ch, p)].id]?.cleared).length}/4`)), problems));
      }
      body.append(h('section', { class: 'browser-level' }, h('h2', {}, h('b', {}, `Level ${lv}`), ` · ${lv} ${lv === 1 ? 'choice' : 'choices'}`), choices));
    }

    const custom = app.customLevels;
    if (custom.length) {
      const problems = h('div', { class: 'choices' });
      for (const level of custom) {
        problems.append(h('div', { class: 'choice panel' },
          h('div', { class: 'choice-head' }, h('span', {}, level.name ?? level.id), h('span', {}, `${level.timeLimit.minutes}:${String(level.timeLimit.seconds).padStart(2, '0')}`)),
          h('div', { class: 'row' },
            h('img', { src: levelPreview(level, 10), alt: '', style: 'width: 96px; border-radius: 6px' }),
            h('div', { style: 'display:grid; gap:6px' },
              h('button', { class: 'btn', onclick: () => onPlay(level) }, 'Play'),
              h('button', { class: 'btn ghost', onclick: () => app.openEditor(level) }, 'Edit')),
          )));
      }
      body.append(h('section', { class: 'browser-level' }, h('h2', {}, h('b', {}, 'Your levels')), problems));
    }

    this.el = h('div', { class: 'page' },
      h('div', { class: 'page-head' },
        h('button', { class: 'btn icon', 'aria-label': 'Back to title', html: svgIcon('back'), onclick: onBack }),
        h('h1', {}, 'Levels'),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Cleared'), h('span', { class: 'stat-value' }, `${cleared}/112`)),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Stars'), h('span', { class: 'stat-value' }, `${stars}/336`)),
      ),
      h('div', { class: 'page-body scroll' }, body),
    );
  }
}
