type Attrs = Record<string, string | number | boolean | ((ev: never) => void) | undefined>;
type Child = Node | string | number | null | undefined | false;

/** Minimal element builder: h('button', { class: 'btn', onclick: fn }, 'Play'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'html') el.innerHTML = String(v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
  return el;
}

export function svgIcon(name: keyof typeof ICONS): string {
  return `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;
}

export const ICONS = {
  pause: '<rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  back: '<path d="M15 5l-7 7 7 7"/>',
  retry: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v5h5"/>',
  play: '<path d="M8 5l11 7-11 7z" fill="currentColor" stroke="none"/>',
  sound: '<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" stroke="none"/><path d="M17 8a5 5 0 0 1 0 8"/>',
  mute: '<path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" stroke="none"/><path d="M17 9l5 6M22 9l-5 6"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
};

export function formatScore(n: number): string {
  return n.toLocaleString('en-US');
}

export function formatClock(minutes: number, seconds: number): string {
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Focus the first focusable element inside `root`, for keyboard users. */
export function focusFirst(root: HTMLElement): void {
  const el = root.querySelector<HTMLElement>('[autofocus], button:not([disabled]), [tabindex="0"], input');
  el?.focus({ preventScroll: true });
}
