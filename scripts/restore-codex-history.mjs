import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  closeSync,
  openSync,
  mkdirSync,
  readSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const CODEX_HOME = process.env.CODEX_HOME || path.join(homedir(), ".codex");
const CLAUDE_MEM_PREFIX_SQL = path.join(homedir(), ".claude-mem").replaceAll("'", "''");
const LEGACY_STATE_DB = path.join(CODEX_HOME, "state_5.sqlite");
const ACTIVE_STATE_DB = existsSync(path.join(CODEX_HOME, "sqlite", "state_5.sqlite"))
  ? path.join(CODEX_HOME, "sqlite", "state_5.sqlite")
  : LEGACY_STATE_DB;
const GLOBAL_STATE = path.join(CODEX_HOME, ".codex-global-state.json");
const SESSION_INDEX = path.join(CODEX_HOME, "session_index.jsonl");
const ELECTRON_ATOM_STATE = "electron-persisted-atom-state";
const FLAT_PROJECT_SIDEBAR_PREFS = "flat-project-sidebar-preferences-v1";
const APPLY = process.argv.includes("--apply");
const TIMESTAMP_RESTORE_WAVE_DAYS = new Set(["2026-06-09", "2026-06-15"]);
const TIMESTAMP_DRIFT_MS = 2 * 24 * 60 * 60 * 1000;
const THREAD_COLUMNS = [
  "id",
  "rollout_path",
  "created_at",
  "updated_at",
  "source",
  "model_provider",
  "cwd",
  "title",
  "sandbox_policy",
  "approval_mode",
  "tokens_used",
  "has_user_event",
  "archived",
  "archived_at",
  "git_sha",
  "git_branch",
  "git_origin_url",
  "cli_version",
  "first_user_message",
  "agent_nickname",
  "agent_role",
  "memory_mode",
  "model",
  "reasoning_effort",
  "agent_path",
  "created_at_ms",
  "updated_at_ms",
  "thread_source",
  "preview",
];
const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "deno.json",
  "bun.lockb",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "uv.lock",
  "Makefile",
];
const HOME = homedir();
// ponytail: local migration hints, add your own aliases here if cwd history moved.
const PROJECT_ROOT_ALIASES = new Map([]);
const TEXT_PROJECT_ROOTS = [];
const VISIBLE_THREAD_WHERE = `
    archived = 0
    AND cwd != ''
    AND (
      has_user_event = 1
      OR first_user_message != ''
      OR preview != ''
      OR title != ''
    )
    AND NOT (
      COALESCE(thread_source, '') = 'subagent'
      OR source LIKE '{"subagent":%'
    )
    AND cwd != '${CLAUDE_MEM_PREFIX_SQL}'
    AND cwd NOT LIKE '${CLAUDE_MEM_PREFIX_SQL}/%'
    AND NOT (
      title = ''
      AND first_user_message = ''
      AND preview = ''
    )
    AND NOT (
      lower(title) LIKE 'codex companion task:%'
      AND first_user_message = ''
      AND preview = ''
    )
    AND NOT (
      title LIKE 'The following is the Codex agent history whose request action you are assessing.%'
      OR title LIKE 'You are Worker %'
      OR title LIKE 'You are helping break Reins v0.1 into implementable stories.%'
      OR title LIKE '你负责%不要编辑文件%'
      OR title LIKE '外部资料调研线已释放线程后重启。不要编辑文件。%'
      OR title LIKE 'Hello memory agent,%'
      OR title LIKE '%<observed_from_primary_session>%'
      OR first_user_message LIKE 'Hello memory agent,%'
      OR first_user_message LIKE '%<observed_from_primary_session>%'
      OR preview LIKE 'Hello memory agent,%'
      OR preview LIKE '%<observed_from_primary_session>%'
      OR title LIKE '<command-name>/%'
      OR first_user_message LIKE '<command-name>/%'
      OR preview LIKE '<command-name>/%'
      OR (
        title IN ('Warmup', 'hi')
        AND first_user_message = title
        AND preview = title
      )
      OR title LIKE 'You have an internal tool called image_gen for image generation. Use it.%'
      OR first_user_message LIKE 'You have an internal tool called image_gen for image generation. Use it.%'
      OR preview LIKE 'You have an internal tool called image_gen for image generation. Use it.%'
      OR title LIKE 'IMPORTANT: Do NOT read or execute any files under ~/.claude/%'
      OR first_user_message LIKE 'IMPORTANT: Do NOT read or execute any files under ~/.claude/%'
      OR preview LIKE 'IMPORTANT: Do NOT read or execute any files under ~/.claude/%'
    )
	`;

const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z");
const backupRoot = path.join(CODEX_HOME, "backups", `history-visible-index-${stamp}`);

function quoteSql(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

function sqlite(db, sql) {
  execFileSync("sqlite3", [db, sql], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  });
}

function sqliteJson(db, sql) {
  return JSON.parse(execFileSync("sqlite3", ["-json", db, sql], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
  }));
}

function loadSessionIndexUpdatedAtMs() {
  const timestamps = new Map();
  if (!existsSync(SESSION_INDEX)) {
    return timestamps;
  }

  for (const line of readFileSync(SESSION_INDEX, "utf8").split("\n")) {
    if (line.trim() === "") {
      continue;
    }

    try {
      const entry = JSON.parse(line);
      if (typeof entry.id !== "string" || typeof entry.updated_at !== "string") {
        continue;
      }

      const updatedAtMs = Date.parse(entry.updated_at);
      if (!Number.isFinite(updatedAtMs)) {
        continue;
      }

      const existing = timestamps.get(entry.id);
      if (existing == null || updatedAtMs > existing) {
        timestamps.set(entry.id, updatedAtMs);
      }
    } catch {
      // Ignore damaged index lines; the live DB and rollout files are still backed up before apply.
    }
  }

  return timestamps;
}

function rowTimestampMs(row, secondsColumn, msColumn) {
  const milliseconds = Number(row[msColumn]);
  if (Number.isFinite(milliseconds) && milliseconds > 0) {
    return milliseconds;
  }

  const seconds = Number(row[secondsColumn]);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.round(seconds * 1000);
  }

  return 0;
}

function buildTimestampChanges() {
  const sessionIndexTimestamps = loadSessionIndexUpdatedAtMs();
  if (sessionIndexTimestamps.size === 0) {
    return [];
  }

  const rows = sqliteJson(ACTIVE_STATE_DB, `
    SELECT id, created_at, updated_at, created_at_ms, updated_at_ms
    FROM threads
    WHERE ${VISIBLE_THREAD_WHERE};
  `);
  const changes = [];

  for (const row of rows) {
    const indexUpdatedAtMs = sessionIndexTimestamps.get(row.id);
    if (indexUpdatedAtMs == null) {
      continue;
    }

    const activeUpdatedAtMs = rowTimestampMs(row, "updated_at", "updated_at_ms");
    if (activeUpdatedAtMs === 0) {
      continue;
    }

    const activeDay = new Date(activeUpdatedAtMs).toISOString().slice(0, 10);
    if (!TIMESTAMP_RESTORE_WAVE_DAYS.has(activeDay)) {
      continue;
    }

    const createdAtMs = rowTimestampMs(row, "created_at", "created_at_ms");
    const nextUpdatedAtMs = Math.max(indexUpdatedAtMs, createdAtMs || indexUpdatedAtMs);
    if (activeUpdatedAtMs - nextUpdatedAtMs <= TIMESTAMP_DRIFT_MS) {
      continue;
    }

    changes.push({
      id: row.id,
      updatedAt: Math.floor(nextUpdatedAtMs / 1000),
      updatedAtMs: nextUpdatedAtMs,
    });
  }

  return changes;
}

function restoreActiveTimestamps(timestampChanges) {
  if (timestampChanges.length === 0) {
    return 0;
  }

  sqlite(ACTIVE_STATE_DB, `
    BEGIN IMMEDIATE;
    ${timestampChanges.map((change) => `
      UPDATE threads
      SET updated_at = ${change.updatedAt},
          updated_at_ms = ${change.updatedAtMs}
      WHERE id = ${quoteSql(change.id)};
    `).join("\n")}
    COMMIT;
  `);

  return timestampChanges.length;
}

function threadColumnExpression(alias, column) {
  if (column === "model_provider") {
    return `CASE WHEN ${alias}.${column} = 'headroom' THEN 'openai' ELSE ${alias}.${column} END`;
  }
  return `${alias}.${column}`;
}

function readFirstLine(file) {
  const fd = openSync(file, "r");
  const chunks = [];
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;

  try {
    while (true) {
      const bytesRead = readSync(fd, buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }

      const newline = buffer.subarray(0, bytesRead).indexOf(10);
      if (newline !== -1) {
        chunks.push(Buffer.from(buffer.subarray(0, newline)));
        break;
      }

      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      position += bytesRead;
    }
  } finally {
    closeSync(fd);
  }

  return Buffer.concat(chunks).toString("utf8");
}

function restoreActiveDbFromLegacy() {
  if (ACTIVE_STATE_DB === LEGACY_STATE_DB || !existsSync(LEGACY_STATE_DB)) {
    return;
  }

  const setColumns = THREAD_COLUMNS
    .filter((column) => column !== "id")
    .map((column) => `${column} = (SELECT ${threadColumnExpression("source", column)} FROM legacy.threads AS source WHERE source.id = target.id)`)
    .join(",\n    ");
  const columns = THREAD_COLUMNS.join(", ");
  const selectColumns = THREAD_COLUMNS
    .map((column) => threadColumnExpression("source", column))
    .join(", ");

  sqlite(ACTIVE_STATE_DB, `
    ATTACH DATABASE ${quoteSql(LEGACY_STATE_DB)} AS legacy;
    BEGIN IMMEDIATE;
    UPDATE main.threads AS target
    SET ${setColumns}
    WHERE target.id IN (
      SELECT id
      FROM legacy.threads
      WHERE archived = 0
        AND cwd != ''
        AND (
          has_user_event = 1
          OR first_user_message != ''
          OR preview != ''
          OR title != ''
        )
        AND COALESCE(thread_source, '') != 'subagent'
        AND cwd NOT LIKE '${CLAUDE_MEM_PREFIX_SQL}/%'
        AND NOT (
          title = ''
          AND first_user_message = ''
          AND preview = ''
        )
        AND NOT (
          lower(title) LIKE 'codex companion task:%'
          AND first_user_message = ''
          AND preview = ''
        )
        AND NOT (
          title LIKE 'The following is the Codex agent history whose request action you are assessing.%'
          OR title LIKE 'You are Worker %'
          OR title LIKE 'You are helping break Reins v0.1 into implementable stories.%'
          OR title LIKE '你负责%不要编辑文件%'
          OR title LIKE '外部资料调研线已释放线程后重启。不要编辑文件。%'
        )
    );
    INSERT OR IGNORE INTO main.threads (${columns})
    SELECT ${selectColumns}
    FROM legacy.threads AS source
    WHERE source.archived = 0
      AND source.cwd != ''
      AND (
        source.has_user_event = 1
        OR source.first_user_message != ''
        OR source.preview != ''
        OR source.title != ''
      )
      AND COALESCE(source.thread_source, '') != 'subagent'
      AND source.cwd NOT LIKE '${CLAUDE_MEM_PREFIX_SQL}/%'
      AND NOT (
        source.title = ''
        AND source.first_user_message = ''
        AND source.preview = ''
      )
      AND NOT (
        lower(source.title) LIKE 'codex companion task:%'
        AND source.first_user_message = ''
        AND source.preview = ''
      )
      AND NOT (
        source.title LIKE 'The following is the Codex agent history whose request action you are assessing.%'
        OR source.title LIKE 'You are Worker %'
        OR source.title LIKE 'You are helping break Reins v0.1 into implementable stories.%'
        OR source.title LIKE '你负责%不要编辑文件%'
        OR source.title LIKE '外部资料调研线已释放线程后重启。不要编辑文件。%'
      );
    COMMIT;
    DETACH DATABASE legacy;
  `);
}

function countHeadroomModelProviderRows(db) {
  if (!existsSync(db)) {
    return 0;
  }

  return sqliteJson(db, `
    SELECT COUNT(*) AS count
    FROM threads
    WHERE archived = 0
      AND model_provider = 'headroom';
  `)[0].count;
}

function normalizeModelProvider(db) {
  const changed = countHeadroomModelProviderRows(db);
  if (changed === 0) {
    return 0;
  }

  sqlite(db, `
    UPDATE threads
    SET model_provider = 'openai'
    WHERE archived = 0
      AND model_provider = 'headroom';
  `);
  return changed;
}

function normalizeSessionMetaModelProvider() {
  const candidates = sqliteJson(ACTIVE_STATE_DB, `
    SELECT id, rollout_path
    FROM threads
    WHERE archived = 0
      AND rollout_path LIKE ${quoteSql(path.join(CODEX_HOME, "sessions", "%"))};
  `);
  const backupDir = path.join(backupRoot, "session-meta-model-provider");
  let changed = 0;

  for (const thread of candidates) {
    if (!existsSync(thread.rollout_path)) {
      continue;
    }

    const firstLine = readFirstLine(thread.rollout_path);
    if (!firstLine.includes('"model_provider":"headroom"')) {
      continue;
    }

    const entry = JSON.parse(firstLine);
    if (entry.type === "session_meta" && entry.payload?.model_provider === "headroom") {
      mkdirSync(backupDir, { recursive: true });
      copyFileSync(thread.rollout_path, path.join(backupDir, path.basename(thread.rollout_path)));
      execFileSync("perl", [
        "-i",
        "-pe",
        'if ($. == 1) { s/"model_provider"\\s*:\\s*"headroom"/"model_provider":"openai"/ }',
        thread.rollout_path,
      ]);
      changed += 1;
    }
  }

  return changed;
}

function mergeUnique(...lists) {
  const seen = new Set();
  const merged = [];

  for (const list of lists) {
    for (const value of Array.isArray(list) ? list : []) {
      if (typeof value === "string" && value !== "" && !seen.has(value)) {
        seen.add(value);
        merged.push(value);
      }
    }
  }

  return merged;
}

function isBlockedProjectRoot(root) {
  // ponytail: generic/app-owned roots are Chats or hidden noise, not Projects.
  if (
    root === "/" ||
    root === HOME ||
    root === path.join(HOME, "Documents") ||
    root === CODEX_HOME ||
    root === "/private/tmp" ||
    root.startsWith(path.join(HOME, ".claude-mem") + "/") ||
    root.startsWith(path.join(HOME, ".gstack") + "/") ||
    root.startsWith(path.join(HOME, ".codex") + "/") ||
    root.includes("/Open Design.app/") ||
    root.includes("/Library/Application Support/Open Design/")
  ) {
    return true;
  }

  return false;
}

function isGeneratedProjectRoot(root) {
  if (isBlockedProjectRoot(root)) {
    return true;
  }

  return root.includes("/.codex/worktrees/") ||
    root.includes("/.claude/worktrees/") ||
    root.includes("/.worktrees/");
}

function hasProjectMarker(root) {
  return PROJECT_MARKERS.some((marker) => existsSync(path.join(root, marker)));
}

function canonicalProjectRoot(root) {
  if (root === "") {
    return "";
  }

  let current = path.resolve(root);
  const seen = new Set();
  while (PROJECT_ROOT_ALIASES.has(current) && !seen.has(current)) {
    seen.add(current);
    current = PROJECT_ROOT_ALIASES.get(current);
  }

  return current;
}

function isRealProjectRoot(root) {
  return !isGeneratedProjectRoot(root) && hasProjectMarker(root);
}

function findFilesystemProjectRoot(cwd) {
  let dir = path.resolve(cwd);

  while (dir !== path.dirname(dir)) {
    if (isBlockedProjectRoot(dir)) {
      return "";
    }

    if (isRealProjectRoot(dir)) {
      return canonicalProjectRoot(dir);
    }

    dir = path.dirname(dir);
  }

  return "";
}

function isPathWithin(child, root) {
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return child === root || child.startsWith(prefix);
}

function threadText(thread) {
  return [thread.cwd, thread.title, thread.first_user_message, thread.preview]
    .filter((value) => typeof value === "string" && value !== "")
    .join("\n");
}

function firstExistingTextRootMention(text) {
  const candidateRoots = mergeUnique(TEXT_PROJECT_ROOTS.map(canonicalProjectRoot))
    .filter((root) => root !== "" && existsSync(root))
    .sort((a, b) => b.length - a.length);

  for (const root of candidateRoots) {
    if (text.includes(root)) {
      return root;
    }

    const originalRoots = TEXT_PROJECT_ROOTS.filter((candidate) => canonicalProjectRoot(candidate) === root);
    if (originalRoots.some((candidate) => text.includes(candidate))) {
      return root;
    }
  }

  return "";
}

function inferProjectRootFromHistory(thread) {
  const text = threadText(thread);
  const mentionedRoot = firstExistingTextRootMention(text);
  if (mentionedRoot !== "") {
    return mentionedRoot;
  }

  return "";
}

function inferProjectRootsFromThreads() {
  const rows = sqliteJson(ACTIVE_STATE_DB, `
    SELECT DISTINCT cwd, title, first_user_message, preview
    FROM threads
    WHERE ${VISIBLE_THREAD_WHERE};
  `);

  return mergeUnique(
    rows.map((row) => findFilesystemProjectRoot(row.cwd)),
    rows.map((row) => inferProjectRootFromHistory(row)),
  );
}

function loadCleanProjectRoots(existingState) {
  return inferProjectRootsFromThreads();
}

function findUniqueBasenameRoot(cwd, roots) {
  const cwdBase = path.basename(cwd);
  const basenameMatches = roots.filter((root) => path.basename(root) === cwdBase);
  return basenameMatches.length === 1 ? basenameMatches[0] : "";
}

function selfCheckBasenameRoot() {
  const root = path.join("/tmp", "new", "demo");
  console.assert(findUniqueBasenameRoot(path.join("/old", "demo"), [root]) === root);
  console.assert(findUniqueBasenameRoot(path.join("/old", "demo"), [root, path.join("/other", "demo")]) === "");
}

if (process.argv.includes("--self-check")) {
  selfCheckBasenameRoot();
  process.exit(0);
}

function findProjectRoot(thread, roots) {
  const cwd = thread.cwd;
  const historyRoot = inferProjectRootFromHistory(thread);
  if (historyRoot !== "") {
    return historyRoot;
  }

  if (
    !existsSync(cwd) ||
    cwd.includes("/.codex/worktrees/") ||
    cwd.includes("/.claude/worktrees/") ||
    cwd.includes("/.worktrees/")
  ) {
    const basenameRoot = findUniqueBasenameRoot(cwd, roots);
    if (basenameRoot !== "") {
      return basenameRoot;
    }
  }

  let bestRoot = "";

  for (const root of roots) {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if ((cwd === root || cwd.startsWith(prefix)) && root.length > bestRoot.length) {
      bestRoot = root;
    }
  }

  if (bestRoot !== "") {
    return bestRoot;
  }

  return findUniqueBasenameRoot(cwd, roots);
}

function buildProjectIndexes(existingState, preservedProjectlessIds) {
  const projectRoots = loadCleanProjectRoots(existingState);
  const projectThreads = sqliteJson(ACTIVE_STATE_DB, `
    SELECT id, cwd, title, first_user_message, preview
    FROM threads
    WHERE ${VISIBLE_THREAD_WHERE}
    ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC, id DESC;
  `);
  const hints = {};
  const assignments = {};
  const projectOrders = {};
  let matched = 0;
  let unmatched = 0;

  for (const thread of projectThreads) {
    if (preservedProjectlessIds.has(thread.id)) {
      continue;
    }

    const root = findProjectRoot(thread, projectRoots);
    if (root === "") {
      unmatched += 1;
      continue;
    }

    hints[thread.id] = root;
    assignments[thread.id] = {
      projectKind: "local",
      projectId: root,
      path: root,
      pendingCoreUpdate: false,
    };
    if (projectOrders[root] == null) {
      projectOrders[root] = { threadIds: [] };
    }
    projectOrders[root].threadIds.push(thread.id);
    matched += 1;
  }

  return { assignments, hints, projectOrders, projectRoots, threadCount: projectThreads.length, matched, unmatched };
}

function buildSidebarModel(existingState, preservedProjectlessIds, visibleIds) {
  const projectIndexes = buildProjectIndexes(existingState, preservedProjectlessIds);
  const projectThreadIds = new Set(Object.keys(projectIndexes.hints));
  const projectlessIds = visibleIds.filter((id) => preservedProjectlessIds.has(id) || !projectThreadIds.has(id));

  return {
    projectIndexes,
    projectlessIds,
    projectOrder: projectIndexes.projectRoots,
    workspaceRoots: projectIndexes.projectRoots,
  };
}

function buildCwdChanges(projectRoots, preservedProjectlessIds) {
  const projectThreads = sqliteJson(ACTIVE_STATE_DB, `
    SELECT id, cwd, rollout_path, title, first_user_message, preview
    FROM threads
    WHERE ${VISIBLE_THREAD_WHERE}
    ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC, id DESC;
  `);
  const changes = [];
  const beforeRoots = new Set();
  const afterRoots = new Set();

  for (const thread of projectThreads) {
    if (preservedProjectlessIds.has(thread.id)) {
      beforeRoots.add(thread.cwd);
      afterRoots.add(thread.cwd);
      continue;
    }

    const root = findProjectRoot(thread, projectRoots);
    const nextCwd = root || thread.cwd;
    beforeRoots.add(thread.cwd);
    afterRoots.add(nextCwd);

    if (root !== "" && thread.cwd !== root) {
      changes.push({ ...thread, nextCwd: root });
    }
  }

  return { changes, distinctBefore: beforeRoots.size, distinctAfter: afterRoots.size };
}

function normalizeActiveCwd(cwdChanges) {
  if (cwdChanges.length === 0) {
    return 0;
  }

  sqlite(ACTIVE_STATE_DB, `
    BEGIN IMMEDIATE;
    ${cwdChanges.map((change) => `
      UPDATE threads
      SET cwd = ${quoteSql(change.nextCwd)}
      WHERE id = ${quoteSql(change.id)};
    `).join("\n")}
    COMMIT;
  `);

  return cwdChanges.length;
}

function escapePerlReplacement(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("$", "\\$")
    .replaceAll("@", "\\@")
    .replaceAll("}", "\\}");
}

function normalizeSessionMetaCwd(cwdChanges) {
  const backupDir = path.join(backupRoot, "session-meta-cwd");
  let changed = 0;

  for (const change of cwdChanges) {
    if (!change.rollout_path || !existsSync(change.rollout_path)) {
      continue;
    }

    const firstLine = readFirstLine(change.rollout_path);
    const entry = JSON.parse(firstLine);

    if (entry.type !== "session_meta" || entry.payload?.cwd === change.nextCwd) {
      continue;
    }

    const currentCwd = entry.payload?.cwd;
    if (typeof currentCwd !== "string" || currentCwd === "") {
      continue;
    }

    mkdirSync(backupDir, { recursive: true });
    copyFileSync(change.rollout_path, path.join(backupDir, path.basename(change.rollout_path)));
    execFileSync("perl", [
      "-i",
      "-pe",
      `if ($. == 1) { s{"cwd"\\s*:\\s*\\Q${JSON.stringify(currentCwd)}\\E}{"cwd":${escapePerlReplacement(JSON.stringify(change.nextCwd))}} }`,
      change.rollout_path,
    ]);
    changed += 1;
  }

  return changed;
}

function forceSidebarListMode(target) {
  const atomState = target[ELECTRON_ATOM_STATE];
  target[ELECTRON_ATOM_STATE] = {
    ...(atomState != null && typeof atomState === "object" && !Array.isArray(atomState) ? atomState : {}),
    // ponytail: list mode makes Chats show all recent threads; project metadata still exists.
    [FLAT_PROJECT_SIDEBAR_PREFS]: { initialized: true, mode: "list" },
  };
}

function countLocalProjectAssignments(value) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return 0;
  }

  return Object.values(value).filter((assignment) => (
    assignment != null &&
    typeof assignment === "object" &&
    assignment.projectKind === "local" &&
    typeof assignment.projectId === "string" &&
    typeof assignment.path === "string" &&
    assignment.pendingCoreUpdate === false
  )).length;
}

function threadIdsFromOrder(value) {
  if (value == null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value.threadIds)) {
    return value.threadIds;
  }
  return [];
}

function compactTitle(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function buildProjectHydrationDiagnostics(projectOrders, rankedThreads) {
  const threadById = new Map(rankedThreads.map((thread) => [thread.id, thread]));
  const rankById = new Map(rankedThreads.map((thread, index) => [thread.id, index + 1]));
  const projects = Object.entries(projectOrders || {}).map(([project, order]) => {
    const ids = threadIdsFromOrder(order);
    const rows = ids.map((id) => threadById.get(id)).filter(Boolean);
    const ranks = rows
      .map((row) => rankById.get(row.id))
      .filter((rank) => typeof rank === "number")
      .sort((left, right) => left - right);
    const newest = rows.slice().sort((left, right) => (
      Number(right.updated_ms || 0) - Number(left.updated_ms || 0)
    ))[0];
    const top50 = rows.filter((row) => (rankById.get(row.id) ?? Infinity) <= 50).length;
    const top100 = rows.filter((row) => (rankById.get(row.id) ?? Infinity) <= 100).length;
    const top500 = rows.filter((row) => (rankById.get(row.id) ?? Infinity) <= 500).length;
    const status = rows.length === 0
      ? "no-visible-rows"
      : top50 === 0
        ? "present-but-not-hydrated"
        : rows.length > top50
          ? "partial-recent-window"
          : "recent-window-ok";

    return {
      project,
      status,
      rowsInProject: rows.length,
      totalThreadIds: ids.length,
      top50,
      top100,
      top500,
      newestRank: ranks[0] ?? null,
      oldestRank: ranks.at(-1) ?? null,
      newestUpdatedAt: newest?.updated_utc ?? null,
      newestTitle: compactTitle(newest?.title),
    };
  }).sort((left, right) => {
    const priority = {
      "present-but-not-hydrated": 0,
      "partial-recent-window": 1,
      "no-visible-rows": 2,
      "recent-window-ok": 3,
    };
    return (priority[left.status] ?? 9) - (priority[right.status] ?? 9)
      || (left.newestRank ?? Infinity) - (right.newestRank ?? Infinity)
      || left.project.localeCompare(right.project);
  });
  const risks = projects.filter((project) => project.status !== "recent-window-ok");

  return {
    note: "Ranks are computed from renderer-eligible active threads sorted newest first. Projects with rowsInProject > 0 and top50 = 0 may still show No chats because Codex Desktop hydrates a recent window.",
    riskCount: risks.length,
    presentButNotHydratedCount: risks.filter((project) => project.status === "present-but-not-hydrated").length,
    partialCount: risks.filter((project) => project.status === "partial-recent-window").length,
    risks: risks.slice(0, 25),
  };
}

const state = JSON.parse(readFileSync(GLOBAL_STATE, "utf8"));
const beforeIds = new Set(state["projectless-thread-ids"] || []);
const beforeChatOrder = state["sidebar-chat-thread-order"];
const beforeProjectOrder = state["project-order"];
const beforeWorkspaceRoots = state["electron-saved-workspace-roots"];
const beforeWorkspaceHints = state["thread-workspace-root-hints"];
const beforeProjectAssignments = state["thread-project-assignments"];
const beforeProjectThreadOrders = state["sidebar-project-thread-orders"];
const legacyVisibleThreads = sqliteJson(LEGACY_STATE_DB, `
  SELECT id, title, updated_at
  FROM threads
  WHERE archived = 0
    AND has_user_event = 1
  ORDER BY updated_at DESC, id DESC;
`);
const activeVisibleBefore = sqliteJson(ACTIVE_STATE_DB, `
  SELECT COUNT(*) AS count
  FROM threads
  WHERE ${VISIBLE_THREAD_WHERE};
`)[0].count;
let sessionMetaProviderFilesChanged = 0;
let activeModelProviderRowsWouldChange = countHeadroomModelProviderRows(ACTIVE_STATE_DB);
let legacyModelProviderRowsWouldChange = ACTIVE_STATE_DB === LEGACY_STATE_DB
  ? activeModelProviderRowsWouldChange
  : countHeadroomModelProviderRows(LEGACY_STATE_DB);
let activeModelProviderRowsChanged = 0;
let legacyModelProviderRowsChanged = 0;
let activeCwdRowsChanged = 0;
let sessionMetaCwdFilesChanged = 0;
let timestampRowsWouldChange = 0;
let timestampRowsChanged = 0;

if (APPLY) {
  mkdirSync(backupRoot, { recursive: true });
  sqlite(ACTIVE_STATE_DB, `.backup ${quoteSql(path.join(backupRoot, "active-state_5.sqlite"))}`);
  if (ACTIVE_STATE_DB !== LEGACY_STATE_DB) {
    copyFileSync(LEGACY_STATE_DB, path.join(backupRoot, "legacy-state_5.sqlite"));
  }
  copyFileSync(GLOBAL_STATE, path.join(backupRoot, ".codex-global-state.json"));
  if (existsSync(SESSION_INDEX)) {
    copyFileSync(SESSION_INDEX, path.join(backupRoot, "session_index.jsonl"));
  }

  restoreActiveDbFromLegacy();
  const timestampChanges = buildTimestampChanges();
  timestampRowsWouldChange = timestampChanges.length;
  timestampRowsChanged = restoreActiveTimestamps(timestampChanges);
  sessionMetaProviderFilesChanged = normalizeSessionMetaModelProvider();
  activeModelProviderRowsChanged = normalizeModelProvider(ACTIVE_STATE_DB);
  if (ACTIVE_STATE_DB === LEGACY_STATE_DB) {
    legacyModelProviderRowsChanged = activeModelProviderRowsChanged;
  } else {
    legacyModelProviderRowsChanged = normalizeModelProvider(LEGACY_STATE_DB);
  }
} else {
  timestampRowsWouldChange = buildTimestampChanges().length;
}

const visibleThreads = sqliteJson(ACTIVE_STATE_DB, `
  SELECT
    id,
    title,
    updated_at,
    COALESCE(updated_at_ms, updated_at * 1000) AS updated_ms,
    datetime(COALESCE(updated_at_ms / 1000, updated_at), 'unixepoch') AS updated_utc
  FROM threads
  WHERE ${VISIBLE_THREAD_WHERE}
  ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC, id DESC;
`);
const visibleIds = visibleThreads.map((thread) => thread.id);
const rendererRankedThreads = sqliteJson(ACTIVE_STATE_DB, `
  SELECT
    id,
    title,
    updated_at,
    COALESCE(updated_at_ms, updated_at * 1000) AS updated_ms,
    datetime(COALESCE(updated_at_ms / 1000, updated_at), 'unixepoch') AS updated_utc
  FROM threads
  WHERE archived = 0
    AND model_provider = 'openai'
    AND COALESCE(thread_source, '') != 'subagent'
    AND source NOT LIKE '{"subagent":%'
  ORDER BY COALESCE(updated_at_ms, updated_at * 1000) DESC, id DESC;
`);
const missing = visibleThreads.filter((thread) => !beforeIds.has(thread.id));
const visibleIdSet = new Set(visibleIds);
const existingProjectlessIds = new Set(
  [...beforeIds].filter((id) => visibleIdSet.has(id)),
);
// ponytail: preserve small real projectless sets; huge sets are the old broken "everything is Chats" state.
const preservedProjectlessIds = existingProjectlessIds.size <= Math.max(50, Math.floor(visibleIds.length * 0.1))
  ? existingProjectlessIds
  : new Set();
let sidebarModel = buildSidebarModel(state, preservedProjectlessIds, visibleIds);
const cwdChanges = buildCwdChanges(sidebarModel.projectIndexes.projectRoots, preservedProjectlessIds);

if (APPLY) {
  sessionMetaCwdFilesChanged = normalizeSessionMetaCwd(cwdChanges.changes);
  activeCwdRowsChanged = normalizeActiveCwd(cwdChanges.changes);

  if (activeCwdRowsChanged > 0 || sessionMetaCwdFilesChanged > 0) {
    sidebarModel = buildSidebarModel(state, preservedProjectlessIds, visibleIds);
  }

  state["projectless-thread-ids"] = sidebarModel.projectlessIds;
  state["sidebar-chat-thread-order"] = {
    ...(
      beforeChatOrder != null &&
      typeof beforeChatOrder === "object" &&
      !Array.isArray(beforeChatOrder)
        ? beforeChatOrder
        : {}
    ),
    threadIds: sidebarModel.projectlessIds,
  };
  state["thread-workspace-root-hints"] = sidebarModel.projectIndexes.hints;
  state["thread-project-assignments"] = sidebarModel.projectIndexes.assignments;
  state["sidebar-project-thread-orders"] = sidebarModel.projectIndexes.projectOrders;
  state["project-order"] = sidebarModel.projectOrder;
  state["electron-saved-workspace-roots"] = sidebarModel.workspaceRoots;
  forceSidebarListMode(state);
  writeFileSync(GLOBAL_STATE, `${JSON.stringify(state, null, 2)}\n`);
}

const afterState = APPLY
  ? JSON.parse(readFileSync(GLOBAL_STATE, "utf8"))
	  : {
	      ...state,
	      "projectless-thread-ids": sidebarModel.projectlessIds,
	      "sidebar-chat-thread-order": { threadIds: sidebarModel.projectlessIds },
	      "thread-workspace-root-hints": sidebarModel.projectIndexes.hints,
	      "thread-project-assignments": sidebarModel.projectIndexes.assignments,
	      "sidebar-project-thread-orders": sidebarModel.projectIndexes.projectOrders,
	      "project-order": sidebarModel.projectOrder,
	      "electron-saved-workspace-roots": sidebarModel.workspaceRoots,
	    };
if (!APPLY) {
  forceSidebarListMode(afterState);
}
const afterProjectless = afterState["projectless-thread-ids"] || [];
const afterChatOrder = afterState["sidebar-chat-thread-order"];
const afterProjectOrder = afterState["project-order"] || [];
const afterWorkspaceRoots = afterState["electron-saved-workspace-roots"] || [];
const afterWorkspaceHints = afterState["thread-workspace-root-hints"] || {};
const afterProjectAssignments = afterState["thread-project-assignments"] || {};
const afterProjectThreadOrders = afterState["sidebar-project-thread-orders"] || {};
const afterSidebarPrefs = afterState[ELECTRON_ATOM_STATE]?.[FLAT_PROJECT_SIDEBAR_PREFS];
const projectHydrationDiagnostics = buildProjectHydrationDiagnostics(afterProjectThreadOrders, rendererRankedThreads);

console.log(JSON.stringify({
  apply: APPLY,
  activeDb: ACTIVE_STATE_DB,
  legacyDb: LEGACY_STATE_DB,
  activeVisibleBefore,
  legacyVisibleThreads: legacyVisibleThreads.length,
  visibleThreads: visibleIds.length,
  projectlessBefore: beforeIds.size,
  preservedProjectless: preservedProjectlessIds.size,
  missingVisibleBefore: missing.length,
  chatOrderBefore: Array.isArray(beforeChatOrder?.threadIds) ? beforeChatOrder.threadIds.length : 0,
  projectOrderBefore: Array.isArray(beforeProjectOrder) ? beforeProjectOrder.length : 0,
  workspaceRootsBefore: Array.isArray(beforeWorkspaceRoots) ? beforeWorkspaceRoots.length : 0,
	  workspaceHintsBefore: beforeWorkspaceHints != null && typeof beforeWorkspaceHints === "object" && !Array.isArray(beforeWorkspaceHints)
	    ? Object.keys(beforeWorkspaceHints).length
	    : 0,
	  projectAssignmentsBefore: beforeProjectAssignments != null && typeof beforeProjectAssignments === "object" && !Array.isArray(beforeProjectAssignments)
	    ? Object.keys(beforeProjectAssignments).length
	    : 0,
	  projectAssignmentsLocalObjectsBefore: countLocalProjectAssignments(beforeProjectAssignments),
	  projectThreadOrdersBefore: beforeProjectThreadOrders != null && typeof beforeProjectThreadOrders === "object" && !Array.isArray(beforeProjectThreadOrders)
	    ? Object.keys(beforeProjectThreadOrders).length
	    : 0,
	  distinctCwdBefore: cwdChanges.distinctBefore,
	  distinctCwdAfter: cwdChanges.distinctAfter,
  activeModelProviderRowsWouldChange,
  legacyModelProviderRowsWouldChange,
  activeModelProviderRowsChanged,
  legacyModelProviderRowsChanged,
	  timestampRowsWouldChange,
  timestampRowsChanged,
  activeCwdRowsChanged,
  sessionMetaCwdFilesChanged,
  projectlessAfter: afterProjectless.length,
	  chatOrderAfter: Array.isArray(afterChatOrder?.threadIds) ? afterChatOrder.threadIds.length : 0,
	  projectThreadsAfter: sidebarModel.projectIndexes.threadCount,
	  projectThreadsMatched: sidebarModel.projectIndexes.matched,
	  projectThreadsUnmatched: sidebarModel.projectIndexes.unmatched,
	  projectOrderAfter: afterProjectOrder.length,
	  workspaceRootsAfter: afterWorkspaceRoots.length,
	  workspaceHintsAfter: afterWorkspaceHints != null && typeof afterWorkspaceHints === "object" && !Array.isArray(afterWorkspaceHints)
	    ? Object.keys(afterWorkspaceHints).length
	    : 0,
	  projectAssignmentsAfter: afterProjectAssignments != null && typeof afterProjectAssignments === "object" && !Array.isArray(afterProjectAssignments)
	    ? Object.keys(afterProjectAssignments).length
	    : 0,
	  projectAssignmentsLocalObjectsAfter: countLocalProjectAssignments(afterProjectAssignments),
	  projectThreadOrdersAfter: afterProjectThreadOrders != null && typeof afterProjectThreadOrders === "object" && !Array.isArray(afterProjectThreadOrders)
	    ? Object.keys(afterProjectThreadOrders).length
    : 0,
  sidebarModeAfter: afterSidebarPrefs?.mode ?? null,
  sessionMetaProviderFilesChanged,
  projectHydrationRiskCount: projectHydrationDiagnostics.riskCount,
  projectHydrationPresentButNotHydratedCount: projectHydrationDiagnostics.presentButNotHydratedCount,
  projectHydrationPartialCount: projectHydrationDiagnostics.partialCount,
  projectHydrationRisks: projectHydrationDiagnostics.risks,
  projectHydrationNote: projectHydrationDiagnostics.note,
  globalStateMtime: statSync(GLOBAL_STATE).mtime.toISOString(),
  backupRoot: APPLY ? backupRoot : null,
  sampleAdded: missing.slice(0, 8).map((thread) => thread.id),
}, null, 2));
