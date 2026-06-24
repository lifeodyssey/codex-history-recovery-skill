# Codex History Recovery Skill

[View on skills.sh](https://skills.sh/lifeodyssey/codex-history-recovery-skill/codex-history-recovery)

A Codex skill for diagnosing and repairing local Codex Desktop history/sidebar state.

It targets cases where chats, projects, project labels, or project history disappear after local state drift, provider experiments, or `model_provider=headroom` rows in Codex state databases.

## Install

Recommended:

```sh
npx skills add lifeodyssey/codex-history-recovery-skill --skill codex-history-recovery -g -a codex -y
```

Preview the skill before installing:

```sh
npx skills add lifeodyssey/codex-history-recovery-skill --list
```

Manual install:

```sh
git clone https://github.com/lifeodyssey/codex-history-recovery-skill.git ~/.codex/skills/codex-history-recovery
```

Restart Codex so the skill is discovered.

## Use

Dry-run first:

```sh
node ~/.codex/skills/codex-history-recovery/scripts/restore-codex-history.mjs
```

Apply only after the summary looks right:

```sh
node ~/.codex/skills/codex-history-recovery/scripts/restore-codex-history.mjs --apply
```

If Codex Desktop keeps rewriting stale state while open, run the after-quit helper:

```sh
sh ~/.codex/skills/codex-history-recovery/scripts/wait-for-codex-quit-and-restore.sh
```

Then fully quit Codex Desktop with `Cmd+Q`, wait a few seconds, and reopen it.

## Safety

- The script writes backups under `~/.codex/backups/history-visible-index-*` before applying.
- It only edits local Codex state files under `~/.codex`.
- It reports `projectHydrationRisks` so old project histories that exist in SQLite but are not mounted by the renderer are not mistaken for lost data.
- It maps generated worktrees and missing old cwd values back to a unique matching project basename when possible. Manual aliases are only for ambiguous local moves.

## Contents

- `SKILL.md`: skill workflow and safety rules
- `scripts/restore-codex-history.mjs`: dry-run/apply repair script
- `scripts/wait-for-codex-quit-and-restore.sh`: helper that waits for Codex Desktop to quit before applying
- `references/sidebar-state.md`: notes on Codex Desktop sidebar state keys
