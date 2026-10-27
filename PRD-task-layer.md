# PRD — Task Layer on the Second-Brain

_2026-09-14. From Atishay's 13-Sep admin-memory spec, pressure-tested by a red/blue/planner pass.
Build on this fork; deploy to his Cloudflare. Fork: `Atishyy27/second-brain-cloudflare`._

## Goal
Turn his Neo voice capture into deduped, priority-visible action items, on infra he already owns
(this worker), that Claude reads+writes via MCP. Replace what Todoist-free caps him on (projects,
AI task creation) WITHOUT a third-party or a paid tier. Framed by him as a possible next-startup seed.

## Verdict (why this shape)
- **Build here, do NOT adopt Plane** — Plane = self-host ops (fights his no-ops + adopt-then-abandon
  pattern) or Plane-cloud = third-party (killed mem0 for that). Building is right ONLY if scoped tiny.
- **3 of the 4 spec tiers already exist here:** Extraction = `remember`; Normalization = the
  Workers-AI judge in `capture/duplicate.ts`; Correlation = `edges` + `insight`; compression exists.
  The only genuinely-new work: a **task store with state** (done/due/priority) + a **priority view**
  + (v2) outbound calendar. Small, concentrated.

## Hard constraints (found in the code, non-negotiable)
- **5/5 cron triggers used** (`wrangler.jsonc`: "last the free plan allows") → v1 extraction is an
  **on-demand MCP tool**, never a new cron. Autonomy (v1.5) rides the EXISTING hourly integration sync.
- **Calendar integration is read-only iCal, token-only, no OAuth2 write path** (`integrations/calendar.ts`,
  `framework.ts`) → outbound calendar is a **v2** build (+ publish the OAuth app so refresh tokens don't
  expire in ~7 days, which would force weekly re-auth = abandonment).
- **Do NOT push tasks into Vectorize** → they'd pollute memory `recall`. Dedup open tasks with one
  LLM-judge pass over the small open-task set instead.
- **Tenancy already exists** (`lib/scope.ts` writeCtx, `workspaces`) → reuse it, do NOT extend it.
  Personal-first delivery; the `owner_id`/`workspace_id` columns are the entire "product bones."
- **Priority view uses its OWN ranker** (priority DESC, due_at) — NOT `recall/math.ts`, which decays
  `tags:task` on recency and would sink important long-lead tasks (the deepest flaw caught).

## The retention core (or it dies — his abandon-pattern)
- **Self-cleaning:** nightly auto-archive of stale tasks (extracted-but-never-acted, past-due-untouched),
  provenance kept so nothing looks lost. A list the AI prunes survives; one he must prune dies.
- **Zero-action daily digest:** pushed to a channel he already reads (Neo readout / one message),
  priority-ordered, requiring no triage to be useful. (v1.5)

## Dedup safety (tasks carry state — asymmetric cost)
Never hard-delete or overwrite a task on merge (unlike memories). Below a high-confidence bar,
soft-merge via a `related` link; keep both source refs + the judge's reason; "no answer = keep
separate". Bad silent merge deletes a real commitment; a visible dup is trivial.

## v1 scope
- `tasks` table (additive, mirrored in `db/init.ts` like `edges` — no ALTER on `entries`).
- 5 MCP tools: `add_task`, `list_tasks` (the priority view), `complete_task`, `update_task`,
  `extract_tasks` (on-demand: scan recent entries → extract → normalize → write tasks).
- Read-only **calendar correlation**: priority view reads existing `calendar`-tagged entries; extraction
  sets `due_at` from dates. No write-back, no OAuth.
- **Todoist stays running in parallel.** v1 adds, does not migrate.

## Schema (v1)
```sql
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',      -- open | done | dropped | archived
  priority INTEGER NOT NULL DEFAULT 0,      -- 0..3, VISIBILITY not schedule
  due_at INTEGER, source_entry_id TEXT, project TEXT,
  workspace_id TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER,
  meta TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_tasks_view ON tasks(workspace_id, status, priority DESC, due_at);
```

## Phases
- **v1:** table + 5 tools + on-demand extract/normalize + priority view + read-only calendar correlation. Todoist untouched.
- **v1.5 (~1 sitting):** extraction rides the existing hourly sync (no new cron) + nightly self-clean + the zero-action daily digest.
- **v2:** Correlation-to-projects (`edges` `part_of_project` + insight keyword auto-comment) + Admin-memory tier (isolated, 6-7 retries, overwrites standard via `supersedes`) + two-way Google Calendar (OAuth2 + published app).
- **v3:** mobile/PWA priority view, expose tenancy as real multi-user, Todoist cutover.

## Build sequence (v1) + creds
1. schema → `db/schema.sql` + `db/init.ts`; `wrangler d1 execute --local` then `--remote` (**his wrangler auth**).
2. `src/tasks/{types,store}.ts` (CRUD, writeCtx-scoped). no creds.
3. register `add_task`/`list_tasks`/`complete_task`/`update_task`. test on `wrangler dev`. no creds.
4. `src/tasks/{extract,normalize}.ts` + `extract_tasks` (Workers-AI; bounded/incremental batch). no external creds.
5. priority-view renderer.
6. calendar correlation (his iCal URL in the existing connect flow; no OAuth).
7. `wrangler deploy` (**his Cloudflare**).

## Risks + kill-criterion
- Workers-AI free neuron cap: bound the first extraction (recent only, batch cap), measure one run before autonomy.
- **Kill-criterion:** if after 2 weeks v1 isn't visibly better than Todoist at the one thing Todoist can't do —
  voice → deduped → priority-visible, auto-populated, self-cleaning — stop. Don't push good money after a graveyard.

## First sitting (ships)
Steps 1-3: schema (local) + store + 3 CRUD tools tested on `wrangler dev` = a priority task list Claude
writes/reads over MCP. De-risks the schema before any LLM work. Remote migrate + deploy need his Cloudflare auth.
