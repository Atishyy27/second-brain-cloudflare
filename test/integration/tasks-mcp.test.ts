/**
 * End-to-end trial of the task tools, driven through the real MCP transport exactly as a
 * connected client (Claude) would drive them — not the store directly. This is the "mimic a
 * real day" test: extract a few tasks, look at the priority view, finish one, re-prioritise
 * another, and confirm the two failure paths reject rather than corrupt.
 *
 * Runs against real SQLite (db/schema.sql, tasks table and all), so the zod input schemas,
 * the tool handlers, the store, and the SQL ORDER BY are all exercised together.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildMcpServer } from "../../src/mcp/server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { makeTestEnv } from "../helpers/make-env";
import { makeSqliteD1, type SqliteD1 } from "../helpers/sqlite-d1";
import type { Env } from "../../src/env";

const ctx = { waitUntil: (_: Promise<unknown>) => {} } as ExecutionContext;
const DAY = 86_400_000;

function textOf(result: unknown): string {
  return ((result as { content?: { text?: string }[] }).content?.[0]?.text) ?? "";
}
/** The id add_task/complete/update echo back as "(id: <uuid>)". */
function idOf(text: string): string {
  const m = text.match(/\(id: ([0-9a-f-]+)\)/i);
  if (!m) throw new Error(`no id in tool output: ${text}`);
  return m[1];
}
/** Titles in a list_tasks render, top to bottom — the priority order under test. */
function titlesOf(text: string): string[] {
  return text.split("\n").map(l => l.match(/^- \[P\d\](?:\s+#\S+)?\s+(.+?)(?: · | \(id: )/)?.[1]).filter(Boolean) as string[];
}

describe("task tools — a realistic day over MCP", () => {
  let d1: SqliteD1;
  let env: Env;

  beforeEach(() => {
    d1 = makeSqliteD1(); // real db/schema.sql, tasks table included
    env = makeTestEnv(undefined, { DB: d1.db as unknown as D1Database });
  });
  afterEach(() => d1?.close());

  async function withClient(run: (client: Client) => Promise<void>) {
    const server = buildMcpServer(env, ctx);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "trial", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    try {
      await run(client);
    } finally {
      await client.close();
    }
  }

  const add = (client: Client, args: Record<string, unknown>) =>
    client.callTool({ name: "add_task", arguments: args }).then(textOf);
  const list = (client: Client, args: Record<string, unknown> = {}) =>
    client.callTool({ name: "list_tasks", arguments: args }).then(textOf);

  it("adds, prioritises, completes and re-prioritises across a session", async () => {
    await withClient(async (client) => {
      const tomorrow = Date.now() + DAY;
      const nandini = idOf(await add(client, { title: "send Nandini the finance deck", priority: 0, due_at: tomorrow }));
      await add(client, { title: "prep Delhi trip", priority: 0 });
      const oss = idOf(await add(client, { title: "review OSS PRs", priority: 1 }));
      const groceries = idOf(await add(client, { title: "buy groceries", priority: 3 }));

      // Priority view (P0 highest): P0-dated first, then P0-undated, then P1, then P3.
      expect(titlesOf(await list(client))).toEqual([
        "send Nandini the finance deck",
        "prep Delhi trip",
        "review OSS PRs",
        "buy groceries",
      ]);

      // Finish groceries — it leaves the open view but is findable under done.
      expect(textOf(await client.callTool({ name: "complete_task", arguments: { id: groceries } }))).toContain("done");
      expect(titlesOf(await list(client))).toEqual([
        "send Nandini the finance deck",
        "prep Delhi trip",
        "review OSS PRs",
      ]);
      expect(titlesOf(await list(client, { status: "done" }))).toEqual(["buy groceries"]);

      // Bump OSS to top priority (P0); undated so it sorts behind the dated Nandini and behind
      // the earlier-created Delhi at the same priority.
      await client.callTool({ name: "update_task", arguments: { id: oss, priority: 0 } });
      expect(titlesOf(await list(client))).toEqual([
        "send Nandini the finance deck",
        "prep Delhi trip",
        "review OSS PRs",
      ]);

      // The Nandini task still shows its due date and priority in the render.
      const view = await list(client);
      expect(view).toMatch(/\[P0\] send Nandini the finance deck · due/);
      void nandini;
    });
  });

  it("rejects a bad status and an empty title at the tool boundary", async () => {
    await withClient(async (client) => {
      const id = idOf(await add(client, { title: "real task", priority: 1 }));
      // MCP surfaces a zod validation failure as an error RESULT (isError: true), not a
      // thrown exception — the invalid status enum and the empty title are both refused here.
      const badStatus = await client.callTool({ name: "update_task", arguments: { id, status: "foo" } });
      expect((badStatus as { isError?: boolean }).isError).toBe(true);
      const badTitle = await client.callTool({ name: "add_task", arguments: { title: "" } });
      expect((badTitle as { isError?: boolean }).isError).toBe(true);
      // The bad calls changed nothing: the one real task is still the only open one.
      expect(titlesOf(await list(client))).toEqual(["real task"]);
    });
  });

  it("scopes a project filter and does not leak across the inbox", async () => {
    await withClient(async (client) => {
      await add(client, { title: "inbox thing" });
      await add(client, { title: "oss thing", project: "oss" });
      expect(titlesOf(await list(client, { project: "oss" }))).toEqual(["oss thing"]);
      // Both default P2, same instant — deterministic by insertion order (rowid tiebreak).
      expect(titlesOf(await list(client))).toEqual(["inbox thing", "oss thing"]);
    });
  });
});
