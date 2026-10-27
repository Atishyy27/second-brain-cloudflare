/**
 * The task layer's vocabulary, kept apart from the memory types on purpose: a task is a
 * commitment with mutable state, not a note. `entries` records what was said; `tasks`
 * records what is still owed and whether it is done.
 */

/**
 * open   — owed, shows in the priority view.
 * done   — completed; keeps completed_at, drops out of the default view.
 * dropped— deliberately abandoned (kept, not deleted, so nothing looks lost).
 * archived— auto-swept by the nightly self-clean (v1.5), provenance retained.
 */
export const TASK_STATUS_VALUES = ["open", "done", "dropped", "archived"] as const;
export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

/**
 * Priority follows the industry P0..P3 convention: 0 = P0 (highest, do-now/critical),
 * 3 = P3 (lowest). LOWER number = higher priority, the same as Todoist, incident SEV
 * levels, and how the user thinks — never the reverse. The view sorts by priority
 * ASCENDING so P0 comes first. It deliberately does not decay on recency the way memory
 * recall does: a P0 long-lead task must not sink just because it was created weeks ago.
 *
 * A task created without an explicit priority defaults to P2 — the ordinary-workflow
 * bucket most tasks belong in. Defaulting to P0 would make every unlabelled task critical;
 * defaulting to P3 would bury real work. P2 is the safe middle, matching the convention
 * that the majority of tasks sit at P2 and are elevated only when they need to be.
 */
export const TASK_PRIORITY_MIN = 0;      // P0, highest
export const TASK_PRIORITY_MAX = 3;      // P3, lowest
export const TASK_PRIORITY_DEFAULT = 2;  // P2, the bucket an unspecified task lands in

/** A task row as it lives in D1, with meta parsed back into an object. */
export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: number;
  dueAt: number | null;       // Unix ms
  sourceEntryId: string | null;
  project: string | null;
  workspaceId: string;
  actorId: string;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  meta: Record<string, unknown>;
}

/** What a caller supplies to create a task; everything else is defaulted by the store. */
export interface NewTask {
  title: string;
  priority?: number;
  dueAt?: number | null;
  project?: string | null;
  sourceEntryId?: string | null;
  meta?: Record<string, unknown>;
}

/** A partial edit. Only the named fields change; omitted fields are left alone. */
export interface TaskPatch {
  title?: string;
  priority?: number;
  dueAt?: number | null;
  project?: string | null;
  status?: TaskStatus;
}

/** Filters for the priority view. Defaults to open tasks across the caller's workspace. */
export interface TaskListOptions {
  status?: TaskStatus;
  project?: string;
  limit?: number;
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && (TASK_STATUS_VALUES as readonly string[]).includes(value);
}

/**
 * Clamp any number to the valid P0..P3 band. A non-number (including an omitted priority)
 * falls to the P2 default, never to P0 — a missing or garbled value must not silently become
 * critical, which is exactly the trap of a scale where the lowest integer is the top priority.
 */
export function clampPriority(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : TASK_PRIORITY_DEFAULT;
  return Math.max(TASK_PRIORITY_MIN, Math.min(TASK_PRIORITY_MAX, n));
}
