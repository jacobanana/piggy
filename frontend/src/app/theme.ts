import { THEMES } from '../lib/constants';

/** Chart/avatar palette — re-derived from the active theme. Live binding. */
export let COLORS = ['#5A67E8', '#3EA7E8', '#17B39A', '#FFB43D', '#9B6DFF', '#F2683C', '#4FC3F7', '#E86A9B'];

/**
 * Keep the browser's own chrome on the book's paper.
 *
 * Installed, this is the strip behind the status bar on Android and the paint
 * around the app on a desktop; in a tab it is the address bar. Left at the
 * static value in `index.html` a book on Citrus opens inside a Blueberry
 * frame — the one part of the theme the palette variables cannot reach,
 * because it is chrome rather than page.
 */
function setThemeColor(paper: string): void {
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = paper;
}

export function applyTheme(name: string): void {
  const t = THEMES[name] || THEMES.blueberry;
  const s = document.documentElement.style;
  setThemeColor(t.paper);
  s.setProperty('--ink', t.ink); s.setProperty('--ink-soft', t.inkSoft);
  s.setProperty('--paper', t.paper); s.setProperty('--paperA', t.paperA);
  s.setProperty('--glow1', t.glow1); s.setProperty('--glow2', t.glow2); s.setProperty('--glow3', t.glow3);
  s.setProperty('--tint', t.tint); s.setProperty('--tint2', t.tint2); s.setProperty('--line', t.line);
  s.setProperty('--accent', t.accent); s.setProperty('--mint', t.mint);
  s.setProperty('--butter', t.butter); s.setProperty('--sky', t.sky); s.setProperty('--grape', t.grape);
  COLORS = [t.accent, t.sky, t.mint, t.butter, t.grape, '#E86A9B', '#4FC3F7', '#8FBF3F'];
}
