import { spawn } from 'node:child_process';

export function runGit(args, cwd, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: stderr || String(err), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });
  });
}

// Parse `git worktree list --porcelain` output.
export function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (cur) {
        out.push(cur);
        cur = null;
      }
      continue;
    }
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice('worktree '.length), head: null, branch: null, detached: false, bare: false, locked: false, lockedReason: null, prunable: false, prunableReason: null };
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'detached') {
      cur.detached = true;
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line.startsWith('locked')) {
      cur.locked = true;
      const rest = line.slice('locked'.length).trim();
      cur.lockedReason = rest || null;
    } else if (line.startsWith('prunable')) {
      cur.prunable = true;
      const rest = line.slice('prunable'.length).trim();
      cur.prunableReason = rest || null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// Returns { dirty: bool, untracked: number, modified: number, ahead: number, behind: number, lastCommit: epochSeconds|null, lastSubject: string|null }
export async function describeWorktree(path) {
  const info = { dirty: false, modified: 0, untracked: 0, ahead: 0, behind: 0, lastCommit: null, lastSubject: null, hasUpstream: false };

  const status = await runGit(['status', '--porcelain=v2', '--branch'], path, { timeoutMs: 4000 });
  if (status.ok) {
    for (const line of status.stdout.split('\n')) {
      if (!line) continue;
      if (line.startsWith('# branch.ab ')) {
        info.hasUpstream = true;
        const m = line.match(/\+(-?\d+)\s+-(-?\d+)/);
        if (m) {
          info.ahead = Number(m[1]);
          info.behind = Number(m[2]);
        }
      } else if (line.startsWith('?')) {
        info.untracked++;
      } else if (line.startsWith('1') || line.startsWith('2') || line.startsWith('u')) {
        info.modified++;
      }
    }
    info.dirty = info.modified > 0 || info.untracked > 0;
  }

  const log = await runGit(['log', '-1', '--format=%ct%x09%s', 'HEAD'], path, { timeoutMs: 3000 });
  if (log.ok) {
    const idx = log.stdout.indexOf('\t');
    if (idx > 0) {
      info.lastCommit = Number(log.stdout.slice(0, idx)) || null;
      info.lastSubject = log.stdout.slice(idx + 1).split('\n')[0];
    }
  }
  return info;
}
