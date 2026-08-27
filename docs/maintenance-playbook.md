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

### Automation (added 2026-08-27 — this reverses the previous rule)

**Superseded:** this playbook used to say *"don't wire this into a silent automatic hook… sync stays a deliberate, visible action — a reminder is fine, a silent background sync is not."* That rule was reversed on 2026-08-27, on evidence. The index sat **~8 weeks** behind git (last write 2026-07-03, discovered 2026-08-27) and the Supabase project auto-paused on the free tier in the meantime. Every trigger in the list above is a manual habit, and none of them fired. **A deliberate action nobody performs is not a safeguard.**

The replacement rule is narrower and keeps what the original was actually protecting: **silent when it works, loud when it doesn't.** The concern was never automation itself — it was losing visibility. So the automation records its own health where a session can check it, rather than assuming it ran.

Two Windows scheduled tasks, both registered under Uriah's user account on the desktop:

| Task | Runs | Does | Why separate |
|---|---|---|---|
| `OpenBrain-Sync` | daily 09:00 | `node scripts/scheduled-sync.mjs` — full sync, then writes `logs/last-sync.json` | The primary defence. Keeping the project awake is a side effect of doing real work. |
| `OpenBrain-KeepWarm` | daily 12:00 | `node scripts/keep-warm.mjs --quiet` — one authenticated read | The last line of defence, deliberately sharing almost nothing with the sync path |

**Why the ping is not redundant.** The sync generates activity only while it succeeds. A broken manifest entry, an expired OpenRouter key, or a moved source repo stops the sync running — and says nothing to Supabase, so the project quietly pauses about a week later. That is precisely the 2026-07-03 → 2026-08-27 failure. `keep-warm.mjs` therefore imports no manifest, calls no embedding API, and writes nothing: one authenticated `GET`. If the sync is broken, the ping still runs.

**Why time-based rather than a git hook.** None of the sync's sources live in this repo — they are in `Command Center Plan`, the Claude Code memory directory, and four other repos' `CLAUDE.md` files. A `post-commit` hook in `icu-brain` would never fire for the content that actually changes. A hook in Command Center would cover most of it, but not the memory directory (not a git repo) or the other four. Time-based covers everything.

**Checking on it:**

```bash
node scripts/keep-warm.mjs        # is the project awake right now?
cat logs/last-sync.json           # did the last sync succeed, and what failed if not?
```

`logs/last-sync.json` carries `status`, timestamps, per-entry counts, and the actual `[FAILED]` lines — so a failure names what broke rather than just counting it. `logs/` is gitignored.

**Manage the tasks:**

```powershell
Get-ScheduledTask -TaskName "OpenBrain-*"                    # state
Get-ScheduledTaskInfo -TaskName "OpenBrain-Sync"             # last run + result code
Start-ScheduledTask -TaskName "OpenBrain-Sync"               # run now
Disable-ScheduledTask -TaskName "OpenBrain-Sync"             # pause it
```

Both use `-StartWhenAvailable`, so a missed run (machine off at 09:00) fires when the machine next wakes rather than being skipped.

**Still true, and the reason this is safe to automate:** the automation only ever runs *git → brain*. It never writes back to git and never invents content, so the worst a bad automated run can do is leave the index stale — the failure it is there to prevent — not corrupt a source. That asymmetry is what makes silent operation acceptable here and would not make it acceptable in the other direction.

**Two caveats worth knowing.** The tasks are registered on the desktop only — the laptop has no equivalent, so don't assume a sync happened because you were working on the laptop. And the sync currently re-embeds and rewrites all 74 entries every run whether or not anything changed (~60s, negligible OpenRouter cost at this corpus size); if the manifest grows substantially, add change detection rather than reaching for a longer interval.

---

## ⚠️ Open work — the core rule above is documented but NOT enforced in code

The 2026-07-18 ADR 0006 sweep (Command Center, finding **S3**) found that "git is the source of truth, the brain is a synced index" is currently **discipline only**. Nothing stops it being violated, and nothing detects when it has been.

**Status as of 2026-08-27:** the *staleness* half of this is now addressed operationally by the scheduled tasks above — but only operationally. The code-level gaps below are unchanged and still open.

**Two concrete gaps:**

1. **`update_thought` will silently clobber git-sourced rows.** `integrations/update-thought-mcp/index.ts:75-229` selects purely by UUID `id` and never checks `sourceSlug`. Edit a git-sourced row through it and the next `brain-sync.mjs` run — which does delete-then-reinsert by `metadata->>sourceSlug` — reverts it to the stale git version with no warning. Worse, the metadata shallow-merge at :172-177 means a caller can even set or clear `sourceSlug` itself.
2. **`--verify` cannot detect drift.** `runVerify()` never queries Supabase at all — it only diffs the filesystem against `manifest.mjs` (UNLISTED / STALE). So database-vs-source divergence is invisible. **This is not theoretical: the index sat 14 days behind git as of 2026-07-18, and then ~8 weeks behind by 2026-08-27, with nothing surfacing either.**

> **The scheduled sync makes staleness less likely; it does not make drift detectable.** A daily sync narrows the window in which the index can be wrong, but `--verify` still cannot answer "does the database match the source?" — it only answers "is every source file listed in the manifest?". If a row is edited through `update_thought`, the daily sync silently reverts it and nothing reports that it happened. Gap 1 and the parity check in gap 2 are the actual fix; the automation is a floor, not a substitute. Do not let a green `last-sync.json` be read as "the index is correct".

**The fix (decided, ready to implement):**

- **The git-owned test is `metadata->>'sourceSlug'` being present.** No schema change needed — `brain-sync.mjs` is the only writer that sets it, and `capture_thought` (`server/index.ts:439-506`) never does, so absent = ad-hoc = freely editable.
- `update_thought` refuses when `existing.metadata?.sourceSlug` is present, returning the repo's existing error shape — `{ content: [{ type: 'text' as const, text: ... }], isError: true }` — with a message naming `metadata.sourceFile` and telling the caller to edit the file and re-sync. Also guard `sourceSlug` against `metadata_patch`.
- **Open question to resolve first:** read the `upsert_thought` SQL function and determine whether its `content_fingerprint` dedup lets `capture_thought` *update* an existing git-owned row on exact content match. If it can, apply the same refusal there.
- Add a real parity check to `--verify`: fetch rows carrying a `sourceSlug` and compare against the manifest entry.
- Add a staleness line: newest `updated_at` among git-owned rows vs the newest mtime among manifest sources.

> **Compare content, not `content_fingerprint`.** The fingerprint is a SHA-256 computed *inside* the `upsert_thought` SQL function over normalised content. Reimplementing that normalisation client-side is a silent-divergence bug: a mismatch would report drift that isn't there and train you to ignore the signal. Comparing content costs more bandwidth and cannot drift.

**Consider homing the recurring staleness check in Command Center's `plans/0011-coordination-layer-tooling.md` `/repo-health` tool** rather than building a scheduler here — that plan already owns cross-repo drift detection.

**Full specification:** `D:\Repos\Command Center Plan\decisions\0006-evidence-gating-keys-on-availability.md` (finding S3) and `plans/0015-adr-0006-evidence-gate-fixes.md` Step 7.

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
