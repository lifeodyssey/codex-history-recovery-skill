# Codex Desktop Sidebar State

Use this reference when a dry-run summary looks surprising.

## Main Files

- `~/.codex/sqlite/state_5.sqlite`: active thread table used by recent Codex Desktop builds.
- `~/.codex/state_5.sqlite`: legacy thread table that may still contain visible rows.
- `~/.codex/.codex-global-state.json`: sidebar ordering and project metadata.
- `~/.codex/sessions/**/*.jsonl`: rollout/session metadata; the first line may contain `model_provider` and `cwd`.

## Important Global State Keys

- `project-order`: ordered project IDs. For path-based local projects, the project ID is the workspace root path.
- `electron-saved-workspace-roots`: workspace roots available to local project grouping.
- `thread-workspace-root-hints`: map from thread ID to workspace root.
- `sidebar-project-thread-orders`: map from project ID to `{ threadIds: [...] }`. Projects can appear empty if this is missing.
- `projectless-thread-ids`: thread IDs shown as plain Chats instead of Projects.
- `sidebar-chat-thread-order`: order for projectless Chats.
- `thread-project-assignments`: optional override; if present, inspect it before assuming cwd grouping.

## Known Failure Shapes

- Chats restored but Projects empty:
  `thread-workspace-root-hints` exists, but `sidebar-project-thread-orders` is missing or empty.

- Projects have many fake labels:
  `project-order` was rebuilt from every distinct thread cwd, including worktrees and date folders.

- Project count is right but histories are wrong:
  stale `thread-workspace-root-hints` or `sidebar-project-thread-orders` include archived or old cwd rows.

- History disappears after provider/routing experiments:
  visible rows or session metadata may use `model_provider='headroom'`; normalize visible history back to `openai`.

- Provider fixes return after a live apply:
  Codex Desktop can rewrite stale legacy state while the app is still open. If a dry-run immediately shows `legacyModelProviderRowsWouldChange > 0` again, avoid another live apply; run the after-quit watcher, have the user fully quit Codex, and let the watcher repair the state after the GUI exits.

- Project exists and DB rows are correct, but the expanded Project still says `No chats`:
  check `projectHydrationRisks` from the restore script. If the status is `present-but-not-hydrated`, or if `rowsInProject > 0`, `top50 = 0`, and `newestRank > 50`, the data is present but the Desktop renderer has not hydrated that old project window. This is a UI/recent-window limitation, not a lost-history case.

- Many `New chat` or `Codex Companion` rows appear:
  empty title/body rows render as `New chat`; empty `Codex Companion Task:` rows and `has_user_event=0` subagent rows are system/helper artifacts, not ordinary user chat history.

## Renderer Hydration Notes

- Current Codex Desktop builds prioritize a small recent thread window for sidebar hydration. Project metadata can be complete while older project children are not mounted in the expanded Project list.
- Diagnose this with rank-based counts before changing data: `top50 = 0` means the project can appear empty even though data exists; `top50 > 0` with a larger total means only the newest subset is likely visible.
- Do not bump timestamps or edit `updated_at_ms` solely to surface old projects. Use direct search/open/pinning or an upstream Desktop fix instead.
