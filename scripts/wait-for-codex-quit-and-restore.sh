#!/bin/sh
set -u

CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
RESTORE="$SCRIPT_DIR/restore-codex-history.mjs"
if [ ! -f "$RESTORE" ]; then
  RESTORE="$SCRIPT_DIR/restore-all-visible-to-chats.mjs"
fi
LOG="$CODEX_HOME/restore-chats/restore-chats-after-codex-quits.log"
NODE="${NODE:-}"

if [ -z "$NODE" ] && [ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]; then
  NODE="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
elif [ -z "$NODE" ] && [ -x "$HOME/.nvm/versions/node/v22.16.0/bin/node" ]; then
  NODE="$HOME/.nvm/versions/node/v22.16.0/bin/node"
elif [ -z "$NODE" ]; then
  NODE="$(command -v node)"
fi

mkdir -p "$(dirname "$LOG")"

log() {
  printf '[%s] %s\n' "$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$LOG"
}

codex_gui_is_running() {
  /bin/ps -axo command= | /usr/bin/awk '
    /\/Applications\/Codex\.app\/Contents\/MacOS\/Codex$/ { found = 1 }
    END { exit found ? 0 : 1 }
  '
}

if [ -z "$NODE" ]; then
  log "node not found"
  exit 127
fi

log "waiting for Codex GUI to exit"

quiet_checks=0
i=0
while [ "$i" -lt 900 ]; do
  if codex_gui_is_running; then
    quiet_checks=0
  else
    quiet_checks=$((quiet_checks + 1))
    if [ "$quiet_checks" -ge 3 ]; then
      log "Codex GUI appears closed; applying history restore"
      CODEX_HOME="$CODEX_HOME" "$NODE" "$RESTORE" --apply >> "$LOG" 2>&1
      status=$?
      log "restore exit status: $status"
      log "post-restore dry-run summary"
      CODEX_HOME="$CODEX_HOME" "$NODE" "$RESTORE" >> "$LOG" 2>&1
      exit "$status"
    fi
  fi

  i=$((i + 1))
  /bin/sleep 2
done

log "timed out waiting for Codex GUI to close"
exit 1
