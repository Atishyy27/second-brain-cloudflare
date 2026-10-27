import { describe, it, expect, beforeEach } from "vitest";
import worker from "../../src/index";
import { makeTestEnv, makeTestDb } from "../helpers/make-env";
import { req } from "../helpers/make-request";
import type { Env } from "../../src/env";
import { D1Mock } from "../helpers/d1-mock";

/**
 * HTTP contract for the REST task routes (src/routes/tasks.ts). The dashboard
 * reads GET /tasks and the reminder importer writes POST /tasks.
 *
 * Scope note: this asserts the request-contract paths that resolve BEFORE the
 * task store is touched — auth and input validation — because D1Mock models the
 * tasks table only in its schema probe, not as real row storage (that is why the
 * store + MCP data paths are exercised against real SQLite in
 * test/unit/tasks-store.test.ts and test/integration/tasks-mcp.test.ts). The
 * route's own data path is a thin pass-through to listTasks/createTask with the
 * same write context the MCP tools use (src/mcp/server.ts).
 */
const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;

describe("REST /tasks route contract", () => {
  let env: Env;
  let db: D1Mock;

  beforeEach(() => {
    db = makeTestDb();
    env = makeTestEnv(db);
  });

  it("GET /tasks rejects a missing auth token → 401", async () => {
    const res = await worker.fetch(req("GET", "/tasks", { token: null }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("POST /tasks rejects a missing auth token → 401", async () => {
    const res = await worker.fetch(req("POST", "/tasks", { token: null, body: { title: "x" } }), env, ctx);
    expect(res.status).toBe(401);
  });

  it("GET /tasks rejects a non-integer ?limit= → 400", async () => {
    const res = await worker.fetch(req("GET", "/tasks?limit=abc"), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/limit/);
  });

  it("POST /tasks rejects a missing title → 400", async () => {
    const res = await worker.fetch(req("POST", "/tasks", { body: { priority: 3 } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as { ok: boolean; error: string };
    expect(data.ok).toBe(false);
    expect(data.error).toMatch(/title/);
  });

  it("POST /tasks rejects invalid JSON → 400", async () => {
    const bad = new Request("http://localhost/tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
      body: "{not json",
    });
    const res = await worker.fetch(bad, env, ctx);
    expect(res.status).toBe(400);
  });

  it("POST /tasks rejects a non-number priority → 400", async () => {
    const res = await worker.fetch(req("POST", "/tasks", { body: { title: "x", priority: "high" } }), env, ctx);
    expect(res.status).toBe(400);
    const data = await res.json() as { ok: boolean; error: string };
    expect(data.error).toMatch(/priority/);
  });
});
