// Minimal ANSI helpers — no chalk dependency.
const ESC = '\x1b[';
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (open, close) => (s) => (useColor ? `${ESC}${open}m${s}${ESC}${close}m` : String(s));

export const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  inverse: wrap(7, 27),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  bgRed: wrap(41, 49),
  bgYellow: wrap(43, 49),
  bgBlue: wrap(44, 49),
};

const STRIP_RE = /\x1b\[[0-9;]*m/g;
export const stripAnsi = (s) => String(s).replace(STRIP_RE, '');
export const visibleLength = (s) => stripAnsi(s).length;

export function pad(s, n, align = 'left') {
  const v = visibleLength(s);
  if (v >= n) return truncate(s, n);
  const space = ' '.repeat(n - v);
  return align === 'right' ? space + s : s + space;
}

export function truncate(s, n) {
  if (visibleLength(s) <= n) return s;
  // Truncate visible chars, ignoring ANSI sequences. Naive: strip color and re-truncate.
  const plain = stripAnsi(s);
  if (plain.length <= n) return s;
  return plain.slice(0, Math.max(0, n - 1)) + '…';
}

// "5m", "3h", "2d", "4w", "11mo", "2y"
export function relativeAge(epochSeconds) {
  if (!epochSeconds) return '—';
  const diff = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
  if (diff < 60) return `${diff}s`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
  if (diff < 86400 * 14) return `${Math.floor(diff / 86400)}d`;
  if (diff < 86400 * 60) return `${Math.floor(diff / (86400 * 7))}w`;
  if (diff < 86400 * 365 * 2) return `${Math.floor(diff / (86400 * 30))}mo`;
  return `${Math.floor(diff / (86400 * 365))}y`;
}

export function tildify(p) {
  const home = process.env.HOME;
  if (home && p.startsWith(home + '/')) return '~' + p.slice(home.length);
  if (home && p === home) return '~';
  return p;
}

// Status badge for a worktree based on its describe() result + meta.
export function statusBadge(wt) {
  if (wt.isMain) return c.blue('main ');
  if (wt.locked) return c.yellow('lockd');
  if (wt.prunable) return c.gray('prune');
  if (wt.describe?.dirty) return c.red('dirty');
  return c.green('clean');
}

export function syncBadge(wt) {
  const d = wt.describe;
  if (!d || !d.hasUpstream) return c.gray('—');
  if (d.ahead === 0 && d.behind === 0) return c.green('✓');
  const parts = [];
  if (d.ahead) parts.push(c.cyan(`↑${d.ahead}`));
  if (d.behind) parts.push(c.magenta(`↓${d.behind}`));
  return parts.join(' ');
}
