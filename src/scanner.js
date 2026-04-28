import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runGit, parseWorktreeList, describeWorktree } from './git.js';

const SKIP_DIRS = new Set([
  'node_modules', '.cache', '.npm', '.yarn', '.pnpm-store',
  'Library', 'Applications', 'System', 'Volumes', 'private',
  '.Trash', '.cargo', '.rustup', '.gradle', '.m2', '.vscode-server',
  '.local', 'venv', '.venv', '__pycache__', 'dist', 'build', 'target',
  '.next', '.nuxt', '.terraform', 'vendor', 'Pods',
  'mux-worktrees', // worktrees themselves; main repos already include them
]);

// Find the main git common dir for a worktree path -- returns the repo whose
// `.git` is a directory. Returns null if not in a repo.
export async function findRepoRoot(startDir) {
  const r = await runGit(['rev-parse', '--git-common-dir'], startDir);
  if (!r.ok) return null;
  let gitCommonDir = r.stdout.trim();
  if (!gitCommonDir) return null;
  if (!path.isAbsolute(gitCommonDir)) {
    gitCommonDir = path.resolve(startDir, gitCommonDir);
  }
  // The common dir is the .git directory of the main repo. The repo root is its parent.
  // (For a bare repo, common dir IS the repo; we still report its parent as a root marker.)
  return path.dirname(gitCommonDir);
}

// Walk a directory tree finding repos (dirs containing a `.git` directory).
// Yields each repo root as it's discovered. Skips SKIP_DIRS, hidden dirs (except .git itself),
// and bounds depth.
export async function* findRepos(rootDir, { maxDepth = 8, onProgress } = {}) {
  rootDir = path.resolve(rootDir);
  const queue = [{ dir: rootDir, depth: 0 }];
  let scanned = 0;
  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    scanned++;
    if (onProgress && scanned % 50 === 0) onProgress({ scanned, current: dir });

    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    // Is this dir a repo? (.git is a real directory, not a file/worktree pointer)
    const gitEntry = entries.find((e) => e.name === '.git');
    if (gitEntry && gitEntry.isDirectory()) {
      yield dir;
      continue; // Don't descend into a repo; worktree list will handle nested ones.
    }

    if (depth >= maxDepth) continue;

    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.isSymbolicLink && e.isSymbolicLink()) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      // Skip hidden dirs except a few we care about
      if (e.name.startsWith('.') && e.name !== '.git') continue;
      queue.push({ dir: path.join(dir, e.name), depth: depth + 1 });
    }
  }
  if (onProgress) onProgress({ scanned, current: null, done: true });
}

// Given a list of repo roots, list every worktree across them.
// Returns enriched objects: { repoRoot, path, branch, head, isMain, locked, ... }.
// Yields incrementally so the UI can stream rows.
export async function* enumerateWorktrees(repoRoots) {
  for (const repoRoot of repoRoots) {
    const r = await runGit(['worktree', 'list', '--porcelain'], repoRoot);
    if (!r.ok) continue;
    const entries = parseWorktreeList(r.stdout);
    for (const e of entries) {
      const isMain = path.resolve(e.path) === path.resolve(repoRoot);
      yield { ...e, repoRoot, isMain };
    }
  }
}

// Convenience: scan a single repo (the repo containing `cwd`).
export async function scanLocalRepo(cwd) {
  const root = await findRepoRoot(cwd);
  if (!root) return { repoRoot: null, worktrees: [] };
  const worktrees = [];
  for await (const wt of enumerateWorktrees([root])) worktrees.push(wt);
  return { repoRoot: root, worktrees };
}

// Convenience: scan a directory tree for all repos and their worktrees.
export async function* scanGlobal(rootDir, opts = {}) {
  const repos = [];
  for await (const r of findRepos(rootDir, opts)) repos.push(r);
  for await (const wt of enumerateWorktrees(repos)) yield wt;
}

export function defaultGlobalRoot() {
  // Prefer ~/src if it exists, else ~
  const home = os.homedir();
  return home;
}

export { describeWorktree };
