// The running build, and whether a newer one has been deployed.

export interface BuildInfo {
  version: string;
  /** Short commit hash. */
  sha: string;
  /** ISO timestamp of the build. */
  built: string;
}

declare const __BUILD__: BuildInfo;

export const BUILD: BuildInfo = __BUILD__;

/** "0.1.0 · 14 Sep 2026 · a1b2c3d" */
export function versionLabel(b: BuildInfo = BUILD): string {
  const date = new Date(b.built);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = Number.isNaN(date.getTime()) ? '' : `${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
  return [b.version, day, b.sha].filter(Boolean).join(' · ');
}

/** The build currently deployed, or null when offline or unknown. Bypasses every cache. */
export async function fetchLatestBuild(): Promise<BuildInfo | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const info = (await res.json()) as BuildInfo;
    return typeof info.sha === 'string' ? info : null;
  } catch {
    return null;
  }
}

/** Fetch the new build through the service worker, then reload into it. */
export async function updateToLatest(): Promise<void> {
  const reg = await navigator.serviceWorker?.getRegistration();
  if (reg) {
    const reloaded = new Promise<void>(resolve => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
    await reg.update().catch(() => undefined);
    // the new worker takes over by itself; reload when it does, or after a few seconds regardless
    await Promise.race([reloaded, new Promise(r => setTimeout(r, 4000))]);
  }
  location.reload();
}
