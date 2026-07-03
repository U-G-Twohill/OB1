# Open Brain — Maintenance Playbook

> How to keep this alive without it becoming a second thing to maintain. Read `docs/architecture.md` first if you haven't — this assumes you understand the sync-path vs live-capture-path distinction.

---

## The core rule

**Git stays the source of truth. Open Brain is a synced index, not a second place to write to by hand.**

If you (or a future Claude session) start hand-capturing structured facts into Open Brain *and* updating `status.md`/plans separately, they will disagree within weeks. That's the exact failure mode the 2026-07-02 audit spent a whole session fixing workspace-wide — don't reintroduce it here. Concretely:

- **Structured content** (plans, decisions, status, context files, memory files, repo orientation) — edit the git file, then re-run `brain-sync.mjs` for that entry (or its batch). Never `capture_thought` a plan update by hand.
- **Unstructured content** (a passing remark, a quick idea with no home yet) — capture it directly via any client's `capture_thought` tool, any time, no ceremony. If it proves durable after a week or two, give it a real home in a git file and add it to the manifest — the sync script takes over from there. This mirrors the existing tooling-backlog Assess → Trial → Adopt pattern; don't invent a second discipline.

---

## When to re-sync

Folded into habits you already have, not a new ritual:

1. **As part of the end-of-session status.md update.** When you (or a session) update `status.md`'s current-state, that's the trigger to also run `node scripts/brain-sync.mjs --slug=cc-status-current`. One extra command in a step you already do every session.
2. **Whenever a plan, ADR, or context file changes meaningfully** — add/update its manifest entry, then `--slug=<that-entry>`. Small and cheap; do it in the same session as the edit if you can.
3. **Whenever a new plan/ADR/context file is created** — add a manifest entry for it (Batch B convention: `cc-plan-NNNN-...`, `cc-decision-adr-NNNN`, `cc-context-...`) and sync it. Run `--verify` afterward to confirm it's now listed.
4. **Weekly, regardless, as a backstop.** Run `--verify` to catch anything that slipped through 1–3, and pair it with Nate B Jones' own Weekly Review companion prompt (ask the connected AI what themes or forgotten action items surface across recent captures) — cross-check what it surfaces against what's actually in `status.md`. This is a natural fit for the existing Friday harvest-triage slot from Plan 0008, if you want to bolt it on there rather than invent a new weekly moment.
5. **After a full manifest rebuild or big edit round** — run the full `node scripts/brain-sync.mjs` (all batches), then `--verify`, then spot-check 2-3 golden queries.

**What NOT to do:** don't wire this into a silent automatic hook that runs on every git commit without you seeing it. Per Uriah's stated working style (surface reasoning, stay in the loop), sync stays a deliberate, visible action — a reminder is fine, a silent background sync is not.

---

## Ad hoc capture → promotion rule

1. Capture freely, any client, any time: "remember this," "capture this thought," etc.
2. If it comes up again, or you find yourself wanting to reference it a second time, that's the signal to give it a real home — a line in the relevant context file, a new memory file, a tooling-backlog entry, whatever fits.
3. Add it to `manifest.mjs` with a `sourceSlug`, sync it in.
4. The original ad hoc capture can stay (it's harmless, tagged `source: "mcp"` so it's distinguishable from synced content) or be cleaned up later during a quarterly sweep — not urgent either way.

---

## Growth sequencing — what's NOT in the brain yet, on purpose

**Client repos (Public Service Center, Ben's Trees, ICUMD) are deliberately excluded from this first migration.** They're the fastest-changing content in the whole stack right now (PSC especially, mid production-cutover) — migrating them before the sync tool had a track record would mean learning the tool's rough edges on the highest-stakes content. Extend the manifest to them once:
- The sync tool has survived a few real re-syncs on the stable content here without surprises, and
- Each client repo's own state has settled enough that a digest won't be stale within days of being written.

**Dormant/reference repos** (GlenTools, TradeApp, WillitsProto, Democratic Workshop, etc.) — likely skip entirely. They're already flagged out-of-scope in `context/system-map.md`; no reason to index them until they become active again.

**When ready to extend:** add new manifest entries following the same `sourceSlug` naming convention (a new prefix, e.g. `psc-` or `bt-`), pointing at each client repo's own `STATE.md`/status doc, and sync as a new batch. The `--batch=` flag in the sync script already supports arbitrary prefixes — no code change needed, just extend `BATCH_PREFIX` in `scripts/brain-sync.mjs` if you want a shortcut flag for it.

---

## The NZ Privacy Act / IPP12 boundary — a hard rule, not a guideline

- **Fine to sync:** your own business strategy, project state, decisions, pricing, and your clients' own engagement facts (names, scope, what was agreed, pricing discussed).
- **Never sync:** a client's *customers'* personal data — no PSC ticket-buyer records, no attendee lists, no order/customer database exports. The manifest only ever points at planning/orientation docs (STATE.md, vision docs, plans), never at operational databases. If a future manifest entry for a client repo is tempted to include "recent orders" or "customer list" data for richer context, don't — summarize the *process* (how orders work, what the schema looks like), not the *data* (who bought what).
- This mirrors the exact boundary already established in `context/second-brain-design.md` and the 2026-06-18 infrastructure research (the "client-data LLM boundary" finding) — nothing new here, just restated in this system's specific context.

---

## Credential hygiene

- `.env` (in `D:\Repos\icu-brain\`) holds `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `OPENROUTER_API_KEY` — stays local, already gitignored. Never commit it.
- The **Supabase Personal Access Token** used for the one-time deploy (Plan 0003) is NOT needed by the ongoing sync script (which only uses the project secret key) — revoke it at supabase.com/dashboard/account/tokens if you haven't already.
- The MCP access key (the one embedded in Claude Code's `-H "x-brain-key: ..."` config and in Claude.ai's connector URL) is the single key for all of Open Brain, core and every future extension — if it's ever rotated, update it in three places: Supabase secrets (`supabase secrets set MCP_ACCESS_KEY=...`), Claude Code's `claude mcp` config (remove + re-add) on both machines, and the Claude.ai custom connector URL.

---

## Troubleshooting

- **401 errors from a client:** the access key in the URL/header doesn't match what's stored in Supabase secrets — check both sides.
- **"Permission denied for table thoughts":** the `service_role` grant is missing (shouldn't happen — it was applied in Plan 0003's schema — but if the table is ever recreated, re-run the `GRANT` statement from that plan).
- **Sync script errors on one entry but not others:** it's designed to continue past failures and report a summary at the end (`N ok, N failed`) — check the specific error message, usually an OpenRouter rate limit or a malformed manifest entry, not a systemic issue.
- **Search returns nothing for a query that should have an answer:** try rephrasing toward the source content's own vocabulary before assuming the content is missing — semantic search still rewards word overlap, not just meaning overlap (see golden-query #10 in `docs/golden-queries.md` for a worked example).
- **General OB1 issues** (deploy failures, Edge Function errors unrelated to this sync tooling): check the upstream `NateBJones-Projects/OB1` repo's own FAQ/troubleshooting doc first — this playbook only covers what's specific to Uriah's setup and the sync tooling built on top of it.
- **"No thoughts found" on a query you're sure should hit something:** fixed 2026-07-03 (the deployed `search_thoughts`/`search` tools' default similarity threshold was 0.5, too strict for this corpus where good matches often land 24–48%; both were lowered to 0.3 and redeployed — real-world multi-surface testing caught this, not the original verification pass). If it resurfaces after a future redeploy of `open-brain-mcp/index.ts` from a fresh clone of the upstream OB1 repo, re-check both threshold defaults (`search_thoughts`'s Zod schema default and the ChatGPT-compat `search` tool's hardcoded `match_threshold`) haven't reverted to `0.5`.

---

## What's genuinely a future toolkit candidate (not now)

The manifest + sync-script pattern (a source list with stable slugs, delete-then-reinsert re-sync, a verify mode) is generic enough to be reusable for any future repo or client that wants the same "keep an AI-searchable index in sync with git" property. Per the existing harvest discipline's own rule of three: don't generalize it into `icu-tools` until it's proven itself across a few more real re-syncs and, ideally, a second use case (e.g. a client repo once Phase 2.5 happens). Log it in `outputs/tooling-backlog.md` at that point, not before.
