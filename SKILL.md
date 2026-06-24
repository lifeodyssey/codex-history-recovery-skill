---
name: codex-history-recovery
description: Diagnose and repair Codex Desktop local history/sidebar state when chats, projects, project labels, project counts, or project history are missing, empty, duplicated, or scrambled. Use for local Codex history recovery involving ~/.codex state, state_5.sqlite, .codex-global-state.json, projectless-thread-ids, thread-workspace-root-hints, sidebar-project-thread-orders, model_provider=headroom, or after Headroom/provider experiments appear to hide Codex history.
---

# Codex History Recovery

## Workflow

1. Verify live state before changing anything:

```bash
node scripts/restore-codex-history.mjs
```

2. Read the JSON summary. Continue only when the intended shape is clear:

- `projectThreadOrdersAfter` should match `projectOrderAfter`.
- `projectThreadsMatched` should be close to `projectThreadsAfter`.
- `projectThreadsUnmatched` should be small or explainable.
- `projectlessAfter` should stay small. A huge value usually means the old broken "everything is Chats" state.
- `activeModelProviderRowsWouldChange` and `legacyModelProviderRowsWouldChange` should be `0` after a successful repair. If either comes back while Codex Desktop is still open, treat it as the app rewriting stale state and use the after-quit watcher instead of repeatedly applying live.
- `projectHydrationRisks` explains Projects that have real threads in metadata/SQLite but may still show `No chats` because the renderer only hydrates a recent window. Treat `present-but-not-hydrated` as "data exists, UI did not mount it", not as missing history. Do not rewrite timestamps just to force old Projects into the recent window.

3. Apply only after dry-run looks right:

```bash
node scripts/restore-codex-history.mjs --apply
```

4. Tell the user to fully quit Codex Desktop with `Cmd+Q`, wait a few seconds, then reopen. The renderer may cache sidebar state until restart. When live state keeps reverting while Codex is open, run the after-quit watcher and confirm its log says it is waiting for Codex GUI to exit.

## What The Script Fixes

- Copies visible legacy rows from `~/.codex/state_5.sqlite` into active `~/.codex/sqlite/state_5.sqlite` when needed.
- Normalizes visible `model_provider='headroom'` rows in both legacy `~/.codex/state_5.sqlite` and active `~/.codex/sqlite/state_5.sqlite`, plus session metadata, back to `openai`.
- Rebuilds `thread-workspace-root-hints` and object-shaped `thread-project-assignments` (`{ projectKind: "local", projectId, path, pendingCoreUpdate: false }`) from each visible thread's `cwd`, walking upward to a real project marker such as `.git`, `package.json`, or `pyproject.toml`; `AGENTS.md`/`CLAUDE.md` alone are not treated as project markers because broad history folders use them too.
- Uses thread history text as extra evidence when `cwd` is too broad: configured project roots mentioned in the thread can map broad sessions back to real projects.
- Canonicalizes generated worktrees and missing old cwd values back to a unique matching project basename when possible; local aliases in `scripts/restore-codex-history.mjs` are only a fallback for ambiguous moves.
- Imports non-empty, non-subagent legacy rows even when `has_user_event=0`, because some image generation/project tasks are represented that way.
- Rebuilds `sidebar-project-thread-orders`, which current Codex uses to populate each Project.
- Removes project-backed threads from `projectless-thread-ids` and `sidebar-chat-thread-order`, while preserving small true projectless chat sets.
- Forces the flat project sidebar preference to `mode: "list"` so Chats/Recent can show the full recent-thread list instead of only projectless threads.
- Filters out empty `New chat` placeholders, empty `Codex Companion Task:` placeholders, subagent rows, `.claude-mem` observer rows, and old helper boilerplate such as action-assessment and worker task prompts.
- Keeps generic/app-owned roots like `/`, `~/Documents`, `/private/tmp`, and `.claude-mem` out of Projects.
- Normalizes generated worktree/date-folder cwd values back to the clean project root when possible.
- Reports renderer hydration misses with per-project `top50`, `top100`, `top500`, and `newestRank` counts so old-but-valid Projects can be distinguished from missing data.
- Writes a backup under `~/.codex/backups/history-visible-index-<timestamp>/` before applying.

## Safety Rules

- Never apply while Codex Desktop is actively rewriting state unless the user accepts that a restart may be needed.
- If `legacyModelProviderRowsWouldChange` or missing project assignments reappear immediately after applying, assume Codex Desktop rewrote stale state while open. Arm `scripts/wait-for-codex-quit-and-restore.sh` or the local LaunchAgent, then have the user `Cmd+Q` and reopen.
- Do not falsify `updated_at` / `updated_at_ms` to make an old Project appear in the renderer. Old Projects with valid rows but `top50: 0` are a Desktop hydration limitation, not recovered-history loss.
- Prefer dry-run first; the script is intentionally safe by default.
- Do not run destructive Git or app cleanup commands as part of history recovery.
- If project roots look suspicious, read `references/sidebar-state.md` before applying.

## Useful Commands

Check the current sidebar shape without changing files:

```bash
node scripts/restore-codex-history.mjs
```

Apply after Codex quits:

```bash
sh scripts/wait-for-codex-quit-and-restore.sh
```

Use a non-default Codex home:

```bash
CODEX_HOME=/path/to/.codex node scripts/restore-codex-history.mjs
```
