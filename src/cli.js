import * as path from 'node:path';
import * as os from 'node:os';
import { findRepoRoot, findRepos, enumerateWorktrees, scanLocalRepo } from './scanner.js';
import { runGit } from './git.js';
import { runUI } from './ui.js';
import { c, tildify } from './format.js';

const HELP = `wtkill — find and kill git worktrees

USAGE
  wtkill [options]

DEFAULT
  Lists worktrees of the repo containing the current directory.

OPTIONS
  -d, --directory <path>   Start from <path> (a repo, or a directory to scan).
  -g, --global             Scan a directory tree for all repos. Default root: ~ (override with -d).
      --max-depth <n>      Max scan depth in --global mode (default 8).
      --prune              Run \`git worktree prune\` across discovered repos and exit.
      --dry-run            Don't actually remove anything; simulate.
      --json               Print discovered worktrees as JSON and exit.
  -y, --yes                Assume yes to confirmations (used with --prune).
  -h, --help               Show this help.
  -v, --version            Show version.

KEYS (interactive UI)
  ↑/↓ or j/k    move cursor
  Space / Del   remove worktree
  F             force-remove (requires confirm)
  /             filter by path/branch (regex)
  r             refresh status of current row
  p             run \`git worktree prune\` across repos
  q / Esc / ^C  quit
`;

function userError(msg, exitCode = 2) {
  const e = new Error(msg);
  e.userFacing = true;
  e.exitCode = exitCode;
  return e;
}

function parseArgs(argv) {
  const opts = { directory: null, global: false, maxDepth: 8, prune: false, dryRun: false, json: false, yes: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      case '-d': case '--directory': opts.directory = next(); break;
      case '-g': case '--global': opts.global = true; break;
      case '--max-depth': opts.maxDepth = Number(next()) || 8; break;
      case '--prune': opts.prune = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--json': opts.json = true; break;
      case '-y': case '--yes': opts.yes = true; break;
      default:
        if (a.startsWith('-')) throw userError(`unknown flag: ${a}. Try --help.`);
        if (opts.directory == null) opts.directory = a;
        else throw userError(`unexpected argument: ${a}`);
    }
  }
  return opts;
}

export async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { process.stdout.write(HELP); return; }
  if (opts.version) {
    const pkg = await import('../package.json', { with: { type: 'json' } }).catch(() => ({ default: { version: '0.0.0' } }));
    process.stdout.write((pkg.default?.version || '0.0.0') + '\n');
    return;
  }

  const startDir = path.resolve(opts.directory || process.cwd());

  // Build worktree stream
  let worktreeStream;
  let title;
  let repoRootsForPrune = [];

  if (opts.global) {
    const root = startDir;
    title = `wtkill — global scan of ${tildify(root)}`;
    worktreeStream = (async function* () {
      const repos = [];
      for await (const repoRoot of findRepos(root, { maxDepth: opts.maxDepth })) {
        repos.push(repoRoot);
        for await (const wt of enumerateWorktrees([repoRoot])) yield wt;
      }
      repoRootsForPrune = repos;
    })();
  } else {
    const repoRoot = await findRepoRoot(startDir);
    if (!repoRoot) {
      process.stderr.write(`wtkill: ${tildify(startDir)} is not inside a git repo. Try \`wtkill -g\` for a global scan.\n`);
      process.exit(2);
    }
    title = `wtkill — ${tildify(repoRoot)}`;
    repoRootsForPrune = [repoRoot];
    worktreeStream = (async function* () {
      for await (const wt of enumerateWorktrees([repoRoot])) yield wt;
    })();
  }

  // --prune: just run prune and exit
  if (opts.prune) {
    // Drain stream first to collect repos
    const collected = [];
    for await (const wt of worktreeStream) collected.push(wt);
    const repos = repoRootsForPrune.length > 0 ? repoRootsForPrune : Array.from(new Set(collected.map((w) => w.repoRoot)));
    if (repos.length === 0) { process.stderr.write('wtkill: no repos found.\n'); process.exit(1); }
    if (!opts.yes) {
      process.stderr.write(`About to run \`git worktree prune\` in ${repos.length} repo(s). Pass -y to confirm.\n`);
      process.exit(1);
    }
    let pruned = 0;
    for (const r of repos) {
      const out = await runGit(['worktree', 'prune', '-v'], r, { timeoutMs: 15000 });
      if (out.ok && out.stdout.trim()) {
        process.stdout.write(`${tildify(r)}:\n${out.stdout}\n`);
        pruned++;
      }
    }
    process.stdout.write(`prune complete (${pruned} repo${pruned === 1 ? '' : 's'} had stale entries).\n`);
    return;
  }

  // --json: drain and print
  if (opts.json) {
    const out = [];
    for await (const wt of worktreeStream) out.push(wt);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    return;
  }

  // Interactive UI
  await runUI({
    streamWorktrees: worktreeStream,
    dryRun: opts.dryRun,
    title,
    onPrune: async () => {
      const repos = repoRootsForPrune.length > 0 ? repoRootsForPrune : [];
      let pruned = 0;
      for (const r of repos) {
        const out = await runGit(['worktree', 'prune', '-v'], r, { timeoutMs: 15000 });
        if (out.ok && out.stdout.trim()) pruned++;
      }
      return c.green(`Pruned in ${repos.length} repo${repos.length === 1 ? '' : 's'} (${pruned} had stale entries).`);
    },
  });
}
