const ALLOWED = new Set(['light', 'dark', 'system']);

export function applyBootTheme(): void {
  const cookie = readCookie('tradr_theme');
  const valid = cookie && ALLOWED.has(cookie) ? cookie : null;
  const resolved =
    valid === 'light'
      ? 'light'
      : valid === 'dark'
        ? 'dark'
        : valid === 'system' || valid === null
          ? typeof window !== 'undefined' &&
            window.matchMedia('(prefers-color-scheme: dark)').matches
            ? 'dark'
            : 'light'
          : 'light';
  const root = document.documentElement;
  if (resolved === 'dark') root.classList.add('dark');
  else root.classList.remove('dark');
}

export function readCookie(name: string): string | null {
  const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
  const match = document.cookie.match(new RegExp('(?:^|;\\s*)' + escaped + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : null;
}

// §H: this string MUST equal the <script> body in apps/web/index.html.
// A Vitest test compares the two — drift fails CI.
export const INLINE_BOOT_SCRIPT_SOURCE = `
(function () {
  var ALLOWED = { light: 1, dark: 1, system: 1 };
  var match = document.cookie.match(/(?:^|;\\s*)tradr_theme=([^;]*)/);
  var cookie = match ? decodeURIComponent(match[1]) : null;
  var valid = cookie && ALLOWED[cookie] ? cookie : null;
  var resolved =
    valid === 'light' ? 'light'
    : valid === 'dark' ? 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  if (resolved === 'dark') document.documentElement.classList.add('dark');
  else document.documentElement.classList.remove('dark');
})();
`.trim();
