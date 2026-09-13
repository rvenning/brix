import './ui/styles.css';
import type { LevelData } from './levels/format.ts';
import { App } from './ui/App.ts';

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  const res = await fetch(`${import.meta.env.BASE_URL}levels/original/levels.json`);
  const pack = (await res.json()) as { levels: LevelData[] };
  await document.fonts?.ready;
  const app = new App(root, pack.levels);
  // development hook for automated checks: window.brix.stepFrames(60)
  if (import.meta.env.DEV) (window as unknown as { brix: App }).brix = app;
}

void boot();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // offline support is a bonus; the game runs without it
    });
  });
}
