import readline from 'node:readline';
import { c, pad, truncate, relativeAge, tildify, statusBadge, syncBadge, visibleLength } from './format.js';
import { runGit } from './git.js';
import { describeWorktree } from './scanner.js';

const ALT_SCREEN_ON = '\x1b[?1049h';
const ALT_SCREEN_OFF = '\x1b[?1049l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const CLEAR = '\x1b[2J\x1b[H';

// Render: streaming list, navigation, deletion. opts.streamWorktrees is an async iterable.
// Returns when user quits. Performs `git worktree remove` calls inline.
export async function runUI({ streamWorktrees, dryRun = false, onPrune = null, title = 'wtkill' }) {
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    throw new Error('wtkill requires an interactive TTY. Use --json or --prune for non-interactive use.');
  }

  const state = {
    items: [], // { wt, describe?, removed?, removing?, error? }
    cursor: 0,
    scroll: 0,
    filter: '',
    inFilter: false,
    status: 'Scanning…',
    prompt: null, // { kind: 'confirm-force'|'confirm-quit', text, resolve }
    scanning: true,
    quit: false,
  };

  process.stdout.write(ALT_SCREEN_ON + HIDE_CURSOR + CLEAR);

  // Raw keypress input
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let cleanedUp = false;
  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    state.quit = true;
    process.stdin.removeListener('keypress', keypressHandler);
    try { process.stdin.setRawMode(false); } catch {}
    process.stdin.pause();
    // Reset attributes, show cursor, leave alt screen.
    process.stdout.write('\x1b[0m' + SHOW_CURSOR + ALT_SCREEN_OFF);
  };

  // Ensure cleanup runs even on uncaught exits.
  const onExit = () => cleanup();
  process.once('exit', onExit);
  process.once('SIGTERM', () => { cleanup(); process.exit(130); });
  process.once('SIGHUP', () => { cleanup(); process.exit(129); });

  const render = () => {
    if (cleanedUp || state.quit) return;
    draw(state, title);
  };

  // Background: consume the worktree stream
  const consumeStream = (async () => {
    for await (const wt of streamWorktrees) {
      state.items.push({ wt });
      // Kick off describe in background; rerender when it lands
      describeWorktree(wt.path).then((d) => {
        const found = state.items.find((it) => it.wt.path === wt.path);
        if (found) found.describe = d;
        render();
      }).catch(() => {});
      render();
    }
    state.scanning = false;
    state.status = state.items.length === 0 ? 'No worktrees found.' : `${state.items.length} worktree${state.items.length === 1 ? '' : 's'} found.`;
    render();
  })();

  // Keypress handler
  const onKey = async (str, key) => {
    if (!key) return;
    if (state.prompt) {
      // Inline confirmation
      if (key.name === 'y' || (str && str.toLowerCase() === 'y')) {
        const p = state.prompt; state.prompt = null; render(); p.resolve(true);
      } else if (key.name === 'n' || key.name === 'escape' || (str && str.toLowerCase() === 'n')) {
        const p = state.prompt; state.prompt = null; render(); p.resolve(false);
      }
      return;
    }
    if (state.inFilter) {
      if (key.name === 'return' || key.name === 'escape') {
        state.inFilter = false;
        if (key.name === 'escape') state.filter = '';
        clampCursor(state);
        render();
        return;
      }
      if (key.name === 'backspace') {
        state.filter = state.filter.slice(0, -1);
      } else if (str && str >= ' ' && str.length === 1) {
        state.filter += str;
      }
      state.cursor = 0;
      state.scroll = 0;
      render();
      return;
    }
    // Normal mode
    if (key.ctrl && key.name === 'c') { state.quit = true; return; }
    switch (key.name) {
      case 'q': case 'escape': state.quit = true; return;
      case 'down': case 'j': moveCursor(state, +1); render(); return;
      case 'up':   case 'k': moveCursor(state, -1); render(); return;
      case 'pagedown': moveCursor(state, +10); render(); return;
      case 'pageup':   moveCursor(state, -10); render(); return;
      case 'home': state.cursor = 0; render(); return;
      case 'end': state.cursor = visibleItems(state).length - 1; render(); return;
      case 'r': // refresh describe for current
        await refreshCurrent(state, render); return;
    }
    if (str === '/') { state.inFilter = true; state.filter = ''; state.cursor = 0; render(); return; }
    if (str === ' ' || key.name === 'delete' || key.name === 'backspace') {
      await tryRemove(state, render, { force: false, dryRun });
      return;
    }
    if (str === 'F') {
      await tryRemove(state, render, { force: true, dryRun });
      return;
    }
    if (str === 'p' || str === 'P') {
      if (onPrune) {
        state.status = 'Pruning…'; render();
        const summary = await onPrune();
        state.status = summary || 'Prune complete.';
        render();
      }
      return;
    }
  };

  const keypressHandler = (str, key) => {
    onKey(str, key).catch((err) => {
      state.status = c.red(`error: ${err.message || err}`);
      render();
    });
  };
  process.stdin.on('keypress', keypressHandler);

  render();

  // Wait until quit
  while (!state.quit) {
    await new Promise((r) => setTimeout(r, 80));
  }
  cleanup();
  process.removeListener('exit', onExit);
  // Don't await consumeStream — in global scans it may still be walking the
  // filesystem. cleanup() has already torn the UI down and render() is a no-op,
  // so any remaining describe/scan work is harmless and will be cancelled when
  // the process exits.
  return state;
}

function visibleItems(state) {
  if (!state.filter) return state.items;
  let re;
  try { re = new RegExp(state.filter, 'i'); } catch { return state.items.filter((it) => it.wt.path.includes(state.filter)); }
  return state.items.filter((it) => re.test(it.wt.path) || re.test(it.wt.branch || ''));
}

function clampCursor(state) {
  const len = visibleItems(state).length;
  if (state.cursor >= len) state.cursor = Math.max(0, len - 1);
  if (state.cursor < 0) state.cursor = 0;
}

function moveCursor(state, delta) {
  const len = visibleItems(state).length;
  if (len === 0) return;
  state.cursor = Math.max(0, Math.min(len - 1, state.cursor + delta));
}

async function refreshCurrent(state, render) {
  const items = visibleItems(state);
  const cur = items[state.cursor];
  if (!cur) return;
  cur.describe = await describeWorktree(cur.wt.path);
  render();
}

async function tryRemove(state, render, { force, dryRun }) {
  const items = visibleItems(state);
  const cur = items[state.cursor];
  if (!cur || cur.removed || cur.removing) return;
  const wt = cur.wt;
  if (wt.isMain) {
    state.status = c.yellow('Cannot remove the main worktree.');
    render(); return;
  }

  // Safety prompt for dirty / locked / non-force when needed
  const dirty = cur.describe?.dirty;
  if ((dirty || wt.locked) && !force) {
    const reason = wt.locked ? 'locked' : 'dirty';
    state.status = c.yellow(`Worktree is ${reason}; press F to force-remove or skip.`);
    render(); return;
  }
  if (force && !await confirm(state, render, `Force remove ${tildify(wt.path)}?`)) {
    state.status = 'Cancelled.'; render(); return;
  }

  cur.removing = true;
  state.status = `${dryRun ? '[dry-run] ' : ''}Removing ${tildify(wt.path)}…`;
  render();

  if (dryRun) {
    await new Promise((r) => setTimeout(r, 200));
    cur.removing = false; cur.removed = true;
    state.status = c.green(`[dry-run] would remove ${tildify(wt.path)}`);
    render(); return;
  }

  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(wt.path);
  const r = await runGit(args, wt.repoRoot, { timeoutMs: 30000 });
  cur.removing = false;
  if (r.ok) {
    cur.removed = true;
    state.status = c.green(`Removed ${tildify(wt.path)}`);
  } else {
    cur.error = (r.stderr || r.stdout || `exit ${r.code}`).trim().split('\n').slice(-1)[0];
    state.status = c.red(`Failed: ${cur.error}`);
  }
  render();
}

function confirm(state, render, text) {
  return new Promise((resolve) => {
    state.prompt = { kind: 'confirm', text, resolve };
    render();
  });
}

// ----------------- rendering -----------------

function draw(state, title) {
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 24;
  const out = [];
  out.push('\x1b[H\x1b[2J');

  // Header
  const head = `${c.bold(title)} ${c.dim('— git worktree killer')}`;
  out.push(head + '\n');

  const items = visibleItems(state);
  const filterLine = state.inFilter
    ? c.inverse(` /${state.filter}_ `) + c.dim(`  (Enter to apply, Esc to clear)`)
    : (state.filter ? c.dim(`filter: /${state.filter}/`) : '');
  if (filterLine) out.push(filterLine + '\n');

  // Help
  out.push(c.dim('↑↓/jk move  Space remove  F force  / filter  r refresh  p prune  q quit') + '\n');

  // Column widths
  const wStatus = 6;
  const wSync = 8;
  const wAge = 6;
  const wBranch = Math.min(28, Math.max(12, Math.floor(cols * 0.22)));
  const wPath = Math.max(20, cols - (wStatus + wSync + wAge + wBranch + 6));

  out.push(
    c.dim(
      pad('STATUS', wStatus) + ' ' +
      pad('SYNC', wSync) + ' ' +
      pad('AGE', wAge, 'right') + ' ' +
      pad('BRANCH', wBranch) + ' ' +
      pad('PATH', wPath),
    ) + '\n',
  );

  // Body — scroll window
  const headerRows = 4 + (filterLine ? 1 : 0);
  const footerRows = 3;
  const bodyHeight = Math.max(3, rows - headerRows - footerRows);
  if (state.cursor < state.scroll) state.scroll = state.cursor;
  if (state.cursor >= state.scroll + bodyHeight) state.scroll = state.cursor - bodyHeight + 1;

  const slice = items.slice(state.scroll, state.scroll + bodyHeight);
  if (slice.length === 0) {
    out.push(c.dim(state.scanning ? '  (scanning…)' : '  (no results)') + '\n');
  }
  slice.forEach((it, i) => {
    const idx = state.scroll + i;
    const isCursor = idx === state.cursor;
    const wt = it.wt;
    const branch = wt.branch || (wt.detached ? '(detached)' : '?');
    const branchStr = pad(truncate(branch, wBranch), wBranch);
    const pathRaw = tildify(wt.path);
    const pathStr = pad(truncate(pathRaw, wPath), wPath);
    const status = it.removed ? c.dim('gone ') : it.removing ? c.yellow('rm…  ') : statusBadge({ ...wt, describe: it.describe });
    const sync = it.removed || it.removing ? '       ' : pad(syncBadge({ ...wt, describe: it.describe }), wSync);
    const age = pad(relativeAge(it.describe?.lastCommit), wAge, 'right');

    let line = `${pad(status, wStatus)} ${sync} ${age} ${branchStr} ${pathStr}`;
    if (it.removed) line = c.dim(line);
    if (isCursor) line = c.inverse(line);
    out.push(line + '\n');
  });

  // Pad body so footer position is stable
  for (let i = slice.length; i < bodyHeight; i++) out.push('\n');

  // Footer status / prompt
  out.push('\n');
  if (state.prompt) {
    out.push(c.bgYellow(c.bold(` ${state.prompt.text} `)) + ' ' + c.dim('(y/n)') + '\n');
  } else {
    out.push(state.status + '\n');
  }
  const cur = items[state.cursor];
  if (cur && !state.prompt) {
    const subj = cur.describe?.lastSubject ? c.dim('“' + truncate(cur.describe.lastSubject, cols - 4) + '”') : '';
    out.push(subj + '\n');
  }

  process.stdout.write(out.join(''));
}
