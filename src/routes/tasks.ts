import type { Env } from "../env";
import { json, intParam } from "../lib/http";
import { requireIdentity } from "../lib/identity";
import { scopeWrite, type WriteContext } from "../lib/scope";
import { createTask, listTasks } from "../tasks/store";
import { TASK_PRIORITY_MIN, TASK_PRIORITY_MAX, type TaskStatus } from "../tasks/types";

/**
 * REST twin of the MCP task tools, for clients that speak HTTP not MCP — the CNC
 * action-items dashboard (a static page) reads GET /tasks, and the Neo→brain
 * reminder importer writes POST /tasks. Both are the same task rows the MCP
 * add_task/list_tasks tools see.
 *
 * The load-bearing line is the write context. It MUST match src/mcp/server.ts
 * (`{ workspaceId: scopeWrite(identity), actorId: identity.userId }`) exactly:
 * scopeWrite(identity) with no target resolves to the caller's PERSONAL
 * workspace, which is where add_task writes. Resolve it any other way (e.g. via
 * capture.ts's writeContextFor, which honours default_share/org-default and can
 * land in a company workspace) and a task written over MCP would not appear here,
 * and vice versa. If server.ts's writeCtx construction changes, change this too.
 */
function taskWriteContext(identity: Parameters<typeof scopeWrite>[0]): WriteContext {
  return { workspaceId: scopeWrite(identity), actorId: identity.userId };
}

export async function handleTasksRoutes(
  request: Request,
  url: URL,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response | null> {
  // GET /tasks — the priority view, as JSON. Open tasks by default; ?status=,
  // ?project=, ?limit= mirror the list_tasks MCP tool. The dashboard reads this.
  if (url.pathname === "/tasks" && request.method === "GET") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;

    // Absent -> undefined (listTasks defaults status to "open"); a present bad
    // value is still forwarded and listTasks falls back to "open" rather than
    // 400ing, matching the tolerant read the MCP tool gives.
    const status = url.searchParams.get("status") ?? undefined;
    const project = url.searchParams.get("project") ?? undefined;
    const limit = intParam(url, "limit", { min: 1, max: 200 });
    if (limit instanceof Response) return limit;

    const tasks = await listTasks(env, taskWriteContext(identity), {
      // listTasks validates via isTaskStatus and defaults a bad value to "open".
      status: status as TaskStatus | undefined,
      // Only pass project when it is a real filter; an empty ?project= reads as absent.
      project: project && project.length ? project : undefined,
      limit,
    });
    return json({ ok: true, tasks });
  }

  // POST /tasks — create a task. Body mirrors the add_task MCP tool. Used by the
  // Neo→brain reminder importer to load Neo's extracted action items into the
  // surviving store without a live MCP client.
  if (url.pathname === "/tasks" && request.method === "POST") {
    const auth = await requireIdentity(request, env);
    if (auth instanceof Response) return auth;
    const identity = auth;

    let body: {
      title?: string;
      priority?: unknown;
      due_at?: unknown;
      project?: unknown;
      source_entry_id?: unknown;
    };
    try { body = await request.json(); } catch { return json({ ok: false, error: "Invalid JSON" }, 400); }

    if (typeof body.title !== "string" || !body.title.trim()) {
      return json({ ok: false, error: "title is required" }, 400);
    }
    if (body.title.includes("\0")) return json({ ok: false, error: "NUL is not allowed" }, 400);
    // priority is clamped by the store (clampPriority), but reject a non-number
    // outright so a typo becomes a 400 rather than silently clamping to 0.
    if (body.priority !== undefined && typeof body.priority !== "number") {
      return json({ ok: false, error: `priority must be a number ${TASK_PRIORITY_MIN}..${TASK_PRIORITY_MAX}` }, 400);
    }
    if (body.due_at !== undefined && body.due_at !== null && typeof body.due_at !== "number") {
      return json({ ok: false, error: "due_at must be Unix milliseconds (a number) or null" }, 400);
    }
    if (body.project !== undefined && body.project !== null && typeof body.project !== "string") {
      return json({ ok: false, error: "project must be a string or null" }, 400);
    }
    if (body.source_entry_id !== undefined && body.source_entry_id !== null && typeof body.source_entry_id !== "string") {
      return json({ ok: false, error: "source_entry_id must be a string or null" }, 400);
    }

    const task = await createTask(
      env,
      {
        title: body.title,
        priority: body.priority as number | undefined,
        dueAt: (body.due_at as number | null | undefined) ?? null,
        project: (body.project as string | null | undefined) ?? null,
        sourceEntryId: (body.source_entry_id as string | null | undefined) ?? null,
      },
      taskWriteContext(identity),
    );
    return json({ ok: true, id: task.id, task });
  }

  return null;
}
