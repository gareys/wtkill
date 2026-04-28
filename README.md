# wtkill

Find and kill git worktrees from a tiny interactive TUI. Inspired by [npkill](https://github.com/voidcosmos/npkill).

```
$ npx wtkill
```

Zero runtime dependencies. Pure Node ESM. Requires Node 18+.

[![npm](https://img.shields.io/npm/v/wtkill.svg)](https://www.npmjs.com/package/wtkill)
[![license](https://img.shields.io/npm/l/wtkill.svg)](./LICENSE)

## Why

`git worktree` is great until you've got a dozen of them scattered across
`~/mux-worktrees/`, `.claude/worktrees/`, `~/src/foo-feature-branch/`, etc.
Listing and pruning by hand is a pain. `wtkill` lists them in a TUI and lets
you pick what to kill — like `npkill`, but for worktrees.

## Install

You don't need to install — just `npx`:

```bash
npx wtkill            # in any git repo
npx wtkill -g         # global scan from $HOME
```

Or install globally:

```bash
npm i -g wtkill
wtkill --help
```

You can also run it straight from GitHub without npm registry:

```bash
npx github:gareys/wtkill
```

## Usage

```bash
wtkill                    # list worktrees in the repo containing CWD
wtkill -d ~/src/myrepo    # target a specific repo
wtkill -g                 # global scan starting at $HOME
wtkill -g -d ~/src        # global scan rooted somewhere else
wtkill --json             # dump worktrees as JSON, no UI
wtkill --prune -y         # run `git worktree prune` across discovered repos
wtkill --dry-run          # interactive UI but never actually deletes
```

### Keys

| key | action |
| --- | --- |
| `↑`/`↓` or `j`/`k` | move cursor |
| `Space` / `Del` | remove worktree (`git worktree remove`) |
| `F` | force-remove (`git worktree remove --force`, prompts) |
| `/` | filter by path/branch (regex) |
| `r` | refresh status of current row |
| `p` | run `git worktree prune` across repos |
| `q` / `Esc` / `Ctrl+C` | quit |

### Columns

- **STATUS** — `main` (the primary worktree, can't remove), `clean`, `dirty`, `lockd`, `prune`
- **SYNC** — `↑n` ahead / `↓n` behind upstream, `✓` even, `—` no upstream
- **AGE** — relative age of `HEAD` (cheap, from `git log -1`)
- **BRANCH** — checked-out branch (or `(detached)`)
- **PATH** — worktree path

## Flags

| flag | description |
| --- | --- |
| `-d, --directory <path>` | start from `<path>` (a repo, or a directory tree to scan) |
| `-g, --global` | scan a directory tree for *every* repo. Default root: `$HOME` (override with `-d`) |
| `--max-depth <n>` | max scan depth in `--global` mode (default `8`) |
| `--prune` | run `git worktree prune` across discovered repos and exit |
| `--dry-run` | interactive UI but never actually removes anything |
| `--json` | print discovered worktrees as JSON and exit |
| `-y, --yes` | assume yes (used with `--prune`) |
| `-h, --help` | show help |
| `-v, --version` | show version |

## How global scan works

`-g` walks the directory tree from `-d` (default `$HOME`) looking for
directories that contain a real `.git` *directory* (i.e. main repos).
Worktrees themselves have a `.git` *file* and are surfaced via
`git worktree list` on the parent repo, so they're never double-counted.

The walker skips heavy/uninteresting dirs (`node_modules`, `Library`,
`.cache`, `dist`, `build`, etc.), caps depth (`--max-depth`, default `8`),
and ignores hidden directories other than `.git` itself.

## Safety

- The main worktree is never offered for removal.
- Dirty or locked worktrees require `F` (force) and a `y/n` confirmation.
- `--dry-run` simulates removal without touching anything.
- `--prune` requires `-y` to actually run.

## License

MIT
