import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import { makeTestEnv } from "../helpers/make-env";
import type { Env } from "../../src/env";
import { OWNER_WRITE_CONTEXT, type WriteContext } from "../../src/lib/scope";
import { createTask, getTask, listTasks, completeTask, updateTask } from "../../src/tasks/store";

describe("task store", () => {
  let d1: SqliteD1;
  let env: Env;
  const owner: WriteContext = OWNER_WRITE_CONTEXT;

  beforeEach(() => {
    d1 = makeSqliteD1(); // real db/schema.sql, so this also proves the tasks table shipped in it
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database });
  });
  afterEach(() => d1?.close());

  it("creates a task with sane defaults", async () => {
    const t = await createTask(env, { title: "  send finance deck  " }, owner);
    expect(t.title).toBe("send finance deck"); // trimmed
    expect(t.status).toBe("open");
    expect(t.priority).toBe(2); // unspecified defaults to P2, not P0-critical
    expect(t.dueAt).toBeNull();
    expect(t.completedAt).toBeNull();
    const back = await getTask(env, t.id, owner);
    expect(back).toEqual(t);
  });

  it("rejects an empty title", async () => {
    await expect(createTask(env, { title: "   " }, owner)).rejects.toThrow(/title/);
  });

  it("clamps priority into 0..3", async () => {
    const hi = await createTask(env, { title: "a", priority: 9 }, owner);
    const lo = await createTask(env, { title: "b", priority: -4 }, owner);
    expect(hi.priority).toBe(3);
    expect(lo.priority).toBe(0);
  });

  it("orders the priority view by priority ASC (P0 first), then soonest-due, dated before undated", async () => {
    const now = Date.now();
    await createTask(env, { title: "p3-someday", priority: 3 }, owner);
    await createTask(env, { title: "p0-later-due", priority: 0, dueAt: now + 2 * 86_400_000 }, owner);
    await createTask(env, { title: "p0-soon-due", priority: 0, dueAt: now + 86_400_000 }, owner);
    await createTask(env, { title: "p0-no-date", priority: 0 }, owner);

    const list = await listTasks(env, owner);
    expect(list.map(t => t.title)).toEqual(["p0-soon-due", "p0-later-due", "p0-no-date", "p3-someday"]);
  });

  it("filters by status and project", async () => {
    await createTask(env, { title: "inbox task" }, owner);
    await createTask(env, { title: "oss task", project: "oss" }, owner);
    const oss = await listTasks(env, owner, { project: "oss" });
    expect(oss.map(t => t.title)).toEqual(["oss task"]);
    expect(await listTasks(env, owner, { status: "done" })).toEqual([]);
  });

  it("completes a task, stamping completed_at and dropping it from the open view", async () => {
    const t = await createTask(env, { title: "ship it" }, owner);
    const done = await completeTask(env, t.id, owner);
    expect(done?.status).toBe("done");
    expect(done?.completedAt).toBeGreaterThan(0);
    expect(await listTasks(env, owner)).toEqual([]); // open view
    expect((await listTasks(env, owner, { status: "done" })).map(x => x.id)).toEqual([t.id]);
  });

  it("re-opening a completed task clears its completion time", async () => {
    const t = await createTask(env, { title: "ship it" }, owner);
    await completeTask(env, t.id, owner);
    const reopened = await updateTask(env, t.id, { status: "open" }, owner);
    expect(reopened?.status).toBe("open");
    expect(reopened?.completedAt).toBeNull();
  });

  it("patches only the named fields and can clear the due date", async () => {
    const t = await createTask(env, { title: "x", priority: 1, dueAt: Date.now(), project: "oss" }, owner);
    const patched = await updateTask(env, t.id, { priority: 3, dueAt: null }, owner);
    expect(patched?.priority).toBe(3);
    expect(patched?.dueAt).toBeNull();
    expect(patched?.project).toBe("oss"); // untouched
    expect(patched?.title).toBe("x"); // untouched
  });

  it("scopes reads to the caller's workspace", async () => {
    const w1: WriteContext = { workspaceId: "w1", actorId: "a1" };
    const w2: WriteContext = { workspaceId: "w2", actorId: "a2" };
    const t = await createTask(env, { title: "w1 only" }, w1);
    expect(await getTask(env, t.id, w2)).toBeNull();
    expect(await completeTask(env, t.id, w2)).toBeNull();
    expect(await updateTask(env, t.id, { priority: 3 }, w2)).toBeNull();
    expect(await listTasks(env, w2)).toEqual([]);
    expect((await listTasks(env, w1)).map(x => x.id)).toEqual([t.id]);
  });
});
