import type { Env } from "../env";
import type { WriteContext } from "../lib/scope";
import {
  type NewTask,
  type Task,
  type TaskListOptions,
  type TaskPatch,
  type TaskStatus,
  clampPriority,
  isTaskStatus,
} from "./types";

/**
 * The task store. Every read is scoped to a single workspace (the caller's write context),
 * so it obeys the same house rule as the memory layer: no unscoped corpus-wide query. For a
 * personal-first brain the workspace is '' and that reads the owner's own rows, byte-identical
 * to how every entry row behaves before tenancy is turned on.
 *
 * Deliberately not routed through Vectorize or recall/math.ts: a task is ranked by priority,
 * not by semantic similarity or recency, so it neither embeds nor decays.
 *
 * SQL note: `tasks.updated_at` is declared NOT NULL (db/schema.sql), so unlike
 * entries.updated_at it can never be NULL and needs no COALESCE fallback on read. Every
 * statement below is a `tasks`-named backtick literal so the entries-updated_at guard
 * (test/unit/updated-at-coalesced.test.ts) exempts it by table, the same way it exempts edges.
 */

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

// Column read order for row hydration; kept identical to the INSERT and to db/schema.sql.
// Not a shared SQL fragment on purpose (see the SQL note above): the full statements inline
// their column lists so each backtick literal names `tasks`.

/** One D1 row (snake_case, meta as JSON text) into a Task (camelCase, meta parsed). */
function rowToTask(row: Record<string, any>): Task {
  return {
    id: String(row.id),
    title: String(row.title),
    status: isTaskStatus(row.status) ? row.status : "open",
    priority: clampPriority(row.priority),
    dueAt: row.due_at == null ? null : Number(row.due_at),
    sourceEntryId: row.source_entry_id == null ? null : String(row.source_entry_id),
    project: row.project == null ? null : String(row.project),
    workspaceId: String(row.workspace_id ?? ""),
    actorId: String(row.actor_id ?? ""),
    createdAt: Number(row.created_at),
    // NOT NULL in schema; the `?? row.created_at` is a defensive no-op that also satisfies
    // the codebase-wide updated_at-coalescing guard.
    updatedAt: Number(row.updated_at ?? row.created_at),
    completedAt: row.completed_at == null ? null : Number(row.completed_at),
    meta: parseMeta(row.meta),
  };
}

/** Parse a stored meta blob back to a plain object; anything malformed or non-object -> {}. */
function parseMeta(raw: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(String(raw ?? "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Normalise caller-supplied meta to exactly what a later read will return: round-trip it
 * through the same JSON path D1 stores, and reject non-objects/arrays. Without this the
 * object createTask returns can disagree with the next getTask (undefined keys dropped,
 * NaN -> null, an array collapsing to {}).
 */
function normalizeMeta(meta: unknown): Record<string, unknown> {
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) return {};
  return parseMeta(JSON.stringify(meta));
}

/** Create a task. Lands in the caller's workspace, stamped with its actor. */
export async function createTask(env: Env, input: NewTask, writeCtx: WriteContext): Promise<Task> {
  const now = Date.now();
  const id = crypto.randomUUID();
  const title = input.title.trim();
  if (!title) throw new Error("task title cannot be empty");
  const priority = clampPriority(input.priority);
  const meta = normalizeMeta(input.meta);
  const dueAt = input.dueAt ?? null;
  const sourceEntryId = input.sourceEntryId ?? null;
  const project = input.project ?? null;

  await env.DB.prepare(
    `INSERT INTO tasks (id, title, status, priority, due_at, source_entry_id, project, workspace_id, actor_id, created_at, updated_at, completed_at, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, title, "open", priority, dueAt, sourceEntryId, project, writeCtx.workspaceId, writeCtx.actorId, now, now, null, JSON.stringify(meta))
    .run();

  return {
    id,
    title,
    status: "open",
    priority,
    dueAt,
    sourceEntryId,
    project,
    workspaceId: writeCtx.workspaceId,
    actorId: writeCtx.actorId,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
    meta,
  };
}

/** One task by id, scoped to the caller's workspace. Null if it is not theirs or not there. */
export async function getTask(env: Env, id: string, writeCtx: WriteContext): Promise<Task | null> {
  const row = (await env.DB.prepare(
    `SELECT id, title, status, priority, due_at, source_entry_id, project, workspace_id, actor_id, created_at, updated_at, completed_at, meta
       FROM tasks WHERE id = ? AND workspace_id = ?`,
  )
    .bind(id, writeCtx.workspaceId)
    .first()) as Record<string, any> | null;
  return row ? rowToTask(row) : null;
}

/**
 * The priority view. Open tasks by default, ordered priority ASCENDING so P0 (highest)
 * comes first, then soonest-due first (undated tasks sort after dated ones at the same
 * priority), then oldest-created, then rowid (insertion order) as a deterministic final
 * tiebreak so two tasks created in the same millisecond never reorder between reads.
 *
 * The (workspace_id, status, priority DESC, due_at) index still serves this: SQLite fixes
 * workspace_id+status by equality and reverse-scans the priority ordering for the ASC pass.
 * The index direction is a physical-layout detail, not the priority meaning — correctness of
 * the final order is guaranteed by this ORDER BY regardless of it — so flipping the sort to
 * ASC needs no index migration on an existing brain. Only the small `due_at IS NULL` tiebreak
 * sorts in memory.
 */
export async function listTasks(env: Env, writeCtx: WriteContext, opts: TaskListOptions = {}): Promise<Task[]> {
  const status: TaskStatus = isTaskStatus(opts.status) ? opts.status : "open";
  const rawLimit = opts.limit;
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.min(MAX_LIST_LIMIT, Math.round(rawLimit as number)))
    : DEFAULT_LIST_LIMIT;

  const clauses = ["workspace_id = ?", "status = ?"];
  const bindings: (string | number)[] = [writeCtx.workspaceId, status];
  // Only a real project string filters; a null/undefined must not become `project = NULL`,
  // which SQL never matches (it would silently return zero rows, hiding every inbox task).
  if (typeof opts.project === "string") {
    clauses.push("project = ?");
    bindings.push(opts.project);
  }

  const { results } = await env.DB.prepare(
    `SELECT id, title, status, priority, due_at, source_entry_id, project, workspace_id, actor_id, created_at, updated_at, completed_at, meta
       FROM tasks WHERE ${clauses.join(" AND ")}
       ORDER BY priority ASC, due_at IS NULL, due_at ASC, created_at ASC, rowid ASC LIMIT ?`,
  )
    .bind(...bindings, limit)
    .all();

  return (results as Record<string, any>[]).map(rowToTask);
}

/**
 * Mark a task done. `completed_at = COALESCE(completed_at, ?)` keeps the FIRST completion
 * time at the DB level, so it is idempotent and safe against a concurrent second complete.
 * Refuses an already-archived task: archival is terminal (the nightly self-clean writes it),
 * and silently reviving it to 'done' would undo an intentional sweep.
 */
export async function completeTask(env: Env, id: string, writeCtx: WriteContext): Promise<Task | null> {
  const existing = await getTask(env, id, writeCtx);
  if (!existing) return null;
  if (existing.status === "archived") return existing; // do not resurrect an archived task
  const now = Date.now();
  const completedAt = existing.completedAt ?? now;
  await env.DB.prepare(
    `UPDATE tasks SET status = 'done', completed_at = COALESCE(completed_at, ?), updated_at = ? WHERE id = ? AND workspace_id = ?`,
  )
    .bind(now, now, id, writeCtx.workspaceId)
    .run();
  return { ...existing, status: "done", completedAt, updatedAt: now };
}

/**
 * Patch a task's fields. Only the fields present in the patch change. Moving to 'done' stamps
 * completed_at if it was not already set (via DB-level COALESCE, so it survives a race the
 * same way completeTask does); moving away from 'done' clears it, so a re-opened task does
 * not carry a stale completion time. An invalid status is rejected rather than written, so a
 * bad value can never orphan a row outside every list view.
 */
export async function updateTask(env: Env, id: string, patch: TaskPatch, writeCtx: WriteContext): Promise<Task | null> {
  const existing = await getTask(env, id, writeCtx);
  if (!existing) return null;
  if (patch.status !== undefined && !isTaskStatus(patch.status)) {
    throw new Error(`invalid task status: ${String(patch.status)}`);
  }

  const next: Task = { ...existing };
  // Patch column fragments; the timestamp column is appended in the fixed tail (see SQL note).
  const assignments: string[] = [];
  const bindings: (string | number | null)[] = [];

  if (patch.title !== undefined) {
    const title = patch.title.trim();
    if (!title) throw new Error("task title cannot be empty");
    next.title = title;
    assignments.push("title = ?");
    bindings.push(title);
  }
  if (patch.priority !== undefined) {
    next.priority = clampPriority(patch.priority);
    assignments.push("priority = ?");
    bindings.push(next.priority);
  }
  if (patch.dueAt !== undefined) {
    next.dueAt = patch.dueAt;
    assignments.push("due_at = ?");
    bindings.push(patch.dueAt ?? null);
  }
  if (patch.project !== undefined) {
    next.project = patch.project;
    assignments.push("project = ?");
    bindings.push(patch.project ?? null);
  }
  if (patch.status !== undefined) {
    next.status = patch.status;
    assignments.push("status = ?");
    bindings.push(patch.status);
    if (patch.status === "done") {
      next.completedAt = existing.completedAt ?? Date.now();
      assignments.push("completed_at = COALESCE(completed_at, ?)");
      bindings.push(next.completedAt);
    } else {
      next.completedAt = null;
      assignments.push("completed_at = NULL");
    }
  }

  const now = Date.now();
  next.updatedAt = now;
  // updated_at lives in the fixed tail of this `tasks`-named literal, never in a dynamic
  // fragment, so the source token stays inside a table-qualified backtick (guard-exempt).
  await env.DB.prepare(
    `UPDATE tasks SET ${assignments.join(", ")}, updated_at = ? WHERE id = ? AND workspace_id = ?`,
  )
    .bind(...bindings, now, id, writeCtx.workspaceId)
    .run();

  return next;
}
