# Brain upgrade plan — journaling + planning (2026-09-13)

Context: a 12 Sep research fanout recommended a set of AI-memory + planning levers. Auditing
THIS repo shows **most are already implemented.** So this plan is AUDIT-FIRST, not build-from-
scratch. (Evidence: `src/ARCHITECTURE.md`, `db/schema.sql`, module names — verified by reading,
not assumed. "Present in code" still needs an enabled/deployed check, Step 0.)

## Research levers -> what already exists here

| Lever (from research) | Status in this repo |
|---|---|
| Weighted recall (recency x importance x relevance) | BUILT — `recall/math.ts` (cosineSim, rerank, MMR) + `recall/rrf.ts` (RRF fusion); `entries.importance_score`, `recall_count` |
| Reflection (derive higher-order patterns) | BUILT — `insight/score.ts` + `insight_candidates` table + a weekly insight pass |
| Interlinking / relationship graph | BUILT — `edges` table (relates_to / supersedes / caused_by / about_person / part_of_project / follows) + `graph/traverse.ts` |
| Consolidation / dedup / contradiction | BUILT — `capture/duplicate.ts` + `contradiction_wins/losses` + `edges` type `supersedes` |
| Decay / volatility / staleness | BUILT — `memory/volatility.ts`, `staleness/` pass + classifier |
| Compression / distillation | BUILT — `compression/` nightly + digest |
| Nightly cron (sleep-time compute) | BUILT — `index.ts` `scheduled()` + `maintenance_cursor` rotation + `runtime/night-summary.ts` |
| Prompt capsules (portable context) | BUILT — `prompt-capsule/` |

## Genuine GAPS vs the research (the only real build candidates)

1. **RAPTOR-style hierarchical distillation tree** — for "load 4 months as one summary, drill
   down on demand." No recursive summary-tree module seen. Compression/digest exists but is not
   a bottom-up cluster-and-summarize tree. **This is the main gap for the loadable-4-months goal.**
2. **Bi-temporal history (valid_from / valid_to)** — supersession exists via `edges` +
   contradiction counters, but confirm the PRIOR value is RETAINED (not overwritten) so
   "what changed since last week" is answerable. Add valid_from/valid_to only if history is lost.
3. **Explicit episodic vs semantic split** — confirm timestamped events are queryable separately
   from timeless facts (needed for temporal "what changed" queries).

## STEP 0 — AUDIT what is ENABLED on his live instance (do this FIRST)

Code present != feature on. Before building anything, check the deployed instance:
- Is the insight/reflection pass actually firing? (check `insight_candidates` rows, `GET /stats/night`)
- Is weighted recall the default path, or is recall similarity-only in practice? (`config.ts` flags)
- Is the nightly cron running on his deployment? (`wrangler.jsonc` crons + night-summary in KV)
- Are edges being populated? (`edges` row count)
Most "upgrades" likely just need enabling/tuning, not writing.

## Then — tune for HIS journaling + planning use
- Recall weights: bias recency up for "what's current" queries.
- Reflection cadence: weekly, write pattern-memories back (matches the manual pass already run 12 Sep).
- **The PLANNING loop is a SEPARATE new layer, NOT this memory worker.** Nightly MIT gate +
  capacity-gate to measured velocity + LLM-Modulo deterministic "did it ship?" verify + weekly
  review belong in a small planner over Todoist + the brain. Scope + build separately.

## Deploy path
Fork: `Atishyy27/second-brain-cloudflare` (this clone at `masti/projects/second-brain-cloudflare`).
Changes -> `vitest` -> `wrangler deploy` to his Cloudflare (needs his creds). Verify against
LoCoMo-style temporal + multi-hop questions so upgrades are measured, not assumed.

---

# Researched verdict — adopt vs build, and the cliff (2026-09-15)

_From a 3-thread research pass (NeoRecall verify + NeoSapien official-coverage map + this
codebase audit), each briefed to prove-or-say-unconfirmed. Then red-teamed and smoke-tested._

## The one lens: your NeoSapien access ends ~end-September. Sort everything by "survives the cliff?"
- **Official NeoSapien MCP** (search_memories, get_daily_summary, get_reminders) — DIES at the cliff (needs the account). Confirmed live from the MCP schema.
- **NeoRecall** = `github.com/mayankbohradev/neo-recall` (MIT; real; exact feature match: weekly_brief/daily_brief/people_digest/decision_log/follow_ups_due/compare_periods/quote_search). DIES at the cliff too — it is a thin synthesis wrapper reading NeoSapien's Firestore via your Google login; refresh token stops the day access ends. Also unmaintained (1 star, 0 forks, silent since 2026-07-18).
- **Your Cloudflare brain** (a fork of the MIT `rahilp/second-brain-cloudflare`) + the Neo->brain sync worker — SURVIVES. It is an independent copy in your own Cloudflare account, fed with no Claude session running.

## So the real priority is not architecture, it's a DEADLINE
After the cliff there is nothing to fetch or export from (data is cloud-hosted; `export_memories` is per-ID, no one-click full export). The single decisive action: **backfill all ~234 active Neo memories into your Cloudflare brain before end-September.** The throttled sync worker drains them in ~2 hourly runs. Everything else below is secondary to this.

## Adopt vs build (settled by the research)
- **ADOPT / do not rebuild:** capture (Neo), semantic recall (official MCP + your fork's `recall/`), daily brief + task/action extraction (official `get_daily_summary` / `get_reminders`), and the entire memory core — it IS the upstream MIT fork (recall, insight, graph, dedup, compression, capsules, tenancy). Keep pulling upstream; duplicating it is wasted effort.
- **The synthesis gap** (weekly brief, standalone decision log, people digest): no official feature exists; NeoRecall has all of it but dies at the cliff and is unmaintained. Verdict: **do not adopt NeoRecall live. Mine it as a free MIT spec + liftable code, re-pointed at YOUR brain** (which survives), or just extend your brain's existing insight/compression layer.
- **BUILD (narrow, genuinely yours):** the task layer (state + priority — nothing else does it; `extract_tasks` stays Claude-driven over your brain, no new server AI), plus the Neo/Google sync glue. Finish and stop, per the PRD kill-criterion.

## Smoke-test (does it work end-to-end?)
- Pre-cliff: sync backfills 234 -> your brain. PASS **iff** the 4 secrets are set and it runs to completion (log shows "0 pending").
- Post-cliff: your brain serves recall/tasks over MCP to any client (Claude/Codex/Cursor); Neo + NeoRecall go dark, your copy stays. PASS **iff** the backfill finished in time.
- **Red-team / failure mode:** the elegant architecture is worthless if two boring setup steps slip past end-September: (1) set the sync secrets + run the backfill to completion, (2) deploy the task layer. The risk here is execution against a deadline, not design. Secondary: your fork may have drifted from upstream (future `git pull` pain) — reconcile before adding more; and confirm the live deploy actually has these features enabled ("code present != feature on").

## Things you will be asked, and the answers
- "Why not just use NeoRecall?" -> it dies with your account (Firestore wrapper) and is unmaintained; it is a reference, not a foundation.
- "Isn't your own brain redundant with Neo?" -> only until end-September; after the cliff it is the only thing left holding your memories.
- "Why build a task layer when `get_reminders` exists?" -> get_reminders extracts from Neo (dies) and has no done/priority state; your task layer has state and lives on the surviving store.

## Still open — your decisions
1. **The one architecture decision:** do you want the synthesis tools (weekly brief / decision log / people digest) at all? If yes, I lift NeoRecall's MIT code and re-point it at your brain (small, durable). If no, skip and rely on the daily brief.
2. **The deadline action (yours to run):** set the 4 sync secrets + run the throttled backfill to "0 pending" before end-September.
3. **Deploy the task layer** (your Cloudflare auth).
