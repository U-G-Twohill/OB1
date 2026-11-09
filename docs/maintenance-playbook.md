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
3. **Whenever a new plan/ADR/context file is created** — nothing is required; a rule indexes it on the next sync. Add a manifest entry (Batch B convention: `cc-plan-NNNN-...`, `cc-decision-adr-NNNN`, `cc-context-...`) only if it deserves a hand-written digest.
4. **Weekly, regardless, as a backstop.** Run `--verify` to catch anything that slipped through 1–3, and pair it with Nate B Jones' own Weekly Review companion prompt (ask the connected AI what themes or forgotten action items surface across recent captures) — cross-check what it surfaces against what's actually in `status.md`. This is a natural fit for the existing Friday harvest-triage slot from Plan 0008, if you want to bolt it on there rather than invent a new weekly moment.
5. **After a full manifest rebuild or big edit round** — run the full `node scripts/brain-sync.mjs` (all batches), then `--verify`, then spot-check 2-3 golden queries.

### Automation (added 2026-08-27 — this reverses the previous rule)

**Superseded:** this playbook used to say *"don't wire this into a silent automatic hook… sync stays a deliberate, visible action — a reminder is fine, a silent background sync is not."* That rule was reversed on 2026-08-27, on evidence. The index sat **~8 weeks** behind git (last write 2026-07-03, discovered 2026-08-27) and the Supabase project auto-paused on the free tier in the meantime. Every trigger in the list above is a manual habit, and none of them fired. **A deliberate action nobody performs is not a safeguard.**

The replacement rule is narrower and keeps what the original was actually protecting: **silent when it works, loud when it doesn't.** The concern was never automation itself — it was losing visibility. So the automation records its own health where a session can check it, rather than assuming it ran.

Two Windows scheduled tasks, both registered under Uriah's user account on the desktop:

| Task | Runs | Does | Why separate |
|---|---|---|---|
| `OpenBrain-Sync` | daily 10:00 NZDT (09:00 NZST) | `node scripts/scheduled-sync.mjs` — full sync, then writes `logs/last-sync.json` | The primary defence. Keeping the project awake is a side effect of doing real work. |
| `OpenBrain-KeepWarm` | daily 13:00 NZDT (12:00 NZST) | `node scripts/keep-warm.mjs --quiet` — one authenticated read | The last line of defence, deliberately sharing almost nothing with the sync path |

**Why the ping is not redundant.** The sync generates activity only while it succeeds. A broken manifest entry, an expired OpenRouter key, or a moved source repo stops the sync running — and says nothing to Supabase, so the project quietly pauses about a week later. That is precisely the 2026-07-03 → 2026-08-27 failure. `keep-warm.mjs` therefore imports no manifest, calls no embedding API, and writes nothing: one authenticated `GET`. If the sync is broken, the ping still runs.

**Why time-based rather than a git hook.** None of the sync's sources live in this repo — they are in `Command Center Plan`, the Claude Code memory directory, and four other repos' `CLAUDE.md` files. A `post-commit` hook in `icu-brain` would never fire for the content that actually changes. A hook in Command Center would cover most of it, but not the memory directory (not a git repo) or the other four. Time-based covers everything.

**Checking on it:**

```bash
node scripts/keep-warm.mjs        # is the project awake right now?
cat logs/last-sync.json           # did the last sync succeed, and what failed if not?
```

`logs/last-sync.json` carries `status`, timestamps, per-entry counts, and the actual `[FAILED]` lines — so a failure names what broke rather than just counting it. `logs/` is gitignored.

| `status` | Meaning |
|---|---|
| `ok` | The run finished cleanly. |
| `failed` | The run finished badly. `failures` names failed entries and `error` holds the end of the output, so a crash keeps its reason. |
| `running` | A run has started and not finished. **If no sync process is alive, that run was killed.** The next run logs a `WARN` and records it in `interruptedPrevious`. |

`lastOkAt` is the time of the last clean run, whatever has happened since. That is the field to read for "how stale could this be?".

**Network failures (added 2026-11-07).** `StartWhenAvailable` runs a missed task the moment the machine wakes, often before DNS works, and that was the cause of the wake-time `ENOTFOUND` failures. Both scripts now wait up to 5 minutes for DNS. The sync also retries up to 3 attempts, but only on network-shaped failures, because a bad entry would just fail the same way again. `attempts` and `waitedMs` show when this happened. A task killed by Windows or a closed console is still lost until the next day's run, but it is now reported.

**Manage the tasks:**

```powershell
Get-ScheduledTask -TaskName "OpenBrain-*"                    # state
Get-ScheduledTaskInfo -TaskName "OpenBrain-Sync"             # last run + result code
Start-ScheduledTask -TaskName "OpenBrain-Sync"               # run now
Disable-ScheduledTask -TaskName "OpenBrain-Sync"             # pause it
```

Both use `-StartWhenAvailable`, so a missed run (machine off at 09:00) fires when the machine next wakes rather than being skipped.

**Still true, and the reason this is safe to automate:** the automation only ever runs *git → brain*. It never writes back to git and never invents content, so the worst a bad automated run can do is leave the index stale — the failure it is there to prevent — not corrupt a source. That asymmetry is what makes silent operation acceptable here and would not make it acceptable in the other direction.

**One caveat worth knowing.** The tasks are registered on the desktop only — the laptop has no equivalent, so don't assume a sync happened because you were working on the laptop. Sources are read from the desktop's own disk, so work pushed from the laptop reaches the brain only after the desktop checkout pulls it.

---

## ⚠️ Open work — the core rule above is documented but NOT enforced in code

The 2026-07-18 ADR 0006 sweep (Command Center, finding **S3**) found that "git is the source of truth, the brain is a synced index" is currently **discipline only**. Nothing stops it being violated, and nothing detects when it has been.

**Status as of 2026-11-07:** gap 2 is closed. `--verify` now compares every synced row's content with what a sync would write, and reports `DB DRIFT`, `DB MISSING`, `DB EXTRA CHUNK` and `DB ORPHAN`, with the newest write time. It downloads about 20 MB, so it is not part of the scheduled run, which means a row edited through `update_thought` is still reverted without notice unless `--verify` ran first. Gap 1 and the `capture_thought` question below are still open. Gap 2's text is kept as the record of why this exists.

**Two concrete gaps:**

1. **`update_thought` will silently clobber git-sourced rows.** `integrations/update-thought-mcp/index.ts:75-229` selects purely by UUID `id` and never checks `sourceSlug`. Edit a git-sourced row through it and the next `brain-sync.mjs` run — which does delete-then-reinsert by `metadata->>sourceSlug` — reverts it to the stale git version with no warning. Worse, the metadata shallow-merge at :172-177 means a caller can even set or clear `sourceSlug` itself.
2. **`--verify` cannot detect drift.** `runVerify()` never queries Supabase at all — it only diffs the filesystem against `manifest.mjs` (UNLISTED / STALE). So database-vs-source divergence is invisible. **This is not theoretical: the index sat 14 days behind git as of 2026-07-18, and then ~8 weeks behind by 2026-08-27, with nothing surfacing either.**

> **Do not let a green `last-sync.json` be read as "the index is correct".** It means the database matches its sources. It says nothing about whether those sources are true.

**The fix (decided, ready to implement):**

- **The git-owned test is `metadata->>'sourceSlug'` being present.** No schema change needed — `brain-sync.mjs` is the only writer that sets it, and `capture_thought` (`server/index.ts:439-506`) never does, so absent = ad-hoc = freely editable.
- `update_thought` refuses when `existing.metadata?.sourceSlug` is present, returning the repo's existing error shape — `{ content: [{ type: 'text' as const, text: ... }], isError: true }` — with a message naming `metadata.sourceFile` and telling the caller to edit the file and re-sync. Also guard `sourceSlug` against `metadata_patch`.
- **Open question to resolve first:** read the `upsert_thought` SQL function and determine whether its `content_fingerprint` dedup lets `capture_thought` *update* an existing git-owned row on exact content match. If it can, apply the same refusal there.

> **Compare content, not `content_fingerprint`.** The fingerprint is a SHA-256 computed *inside* the `upsert_thought` SQL function over normalised content. Reimplementing that normalisation client-side is a silent-divergence bug: a mismatch would report drift that isn't there and train you to ignore the signal. Comparing content costs more bandwidth and cannot drift.

**Consider homing the recurring staleness check in Command Center's `plans/0011-coordination-layer-tooling.md` `/repo-health` tool** rather than building a scheduler here — that plan already owns cross-repo drift detection.

**Full specification:** `D:\Repos\Command Center Plan\decisions\0006-evidence-gating-keys-on-availability.md` (finding S3) and `plans/0015-adr-0006-evidence-gate-fixes.md` Step 7.

---

## Digests go stale, so a drifted digest is replaced by its source

**Since 2026-11-07, a curated entry whose source file is newer than its `digestedAt` is served from the source file instead.** Editing a source reaches the brain on the next sync, with no manual step. The row keeps its `sourceSlug`, is chunked if large, and carries `digestSuperseded: true`. Bumping `digestedAt` after rewriting the digest restores it automatically.

Why: detection alone did not work. After all 12 drifted digests were fixed on 2026-08-27, 12 had drifted again by 2026-11-07, and the strategy digest was 75 days behind while `--verify` reported it daily.

**The cost is retrieval quality, and it is real.** Raw prose embeds less cleanly than a digest, so a superseded entry can rank lower. Re-authoring a digest is still worth doing for documents people ask about often. It is now an improvement to retrieval, not a correctness fix. To list them:

```bash
curl -s "$SUPABASE_URL/rest/v1/thoughts?select=metadata->>sourceSlug&metadata->>digestSuperseded=eq.true" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
```

**Every curated source can now reach the brain as raw text.** Treat them like rule sources under the privacy boundary below: never point a manifest entry at a file holding a client's customers' data, even if the digest would leave that data out.

### How this was found

Originally, `brain-sync.mjs` embedded only the hand-authored digest and opened the source file just to check that it existed. So editing a source changed nothing, and re-running the sync re-embedded the same stale prose.

This was discovered on 2026-08-27 and it had been true since the tool was written. **12 of 74 entries had a source edited after the digest was authored. Four were 56 days stale — and they were `status.md`, `system-map.md`, `current-data.md` and the workspace `CLAUDE.md`: exactly the orientation documents a session reads first.**

The concrete cost, live in the index at the time: the brain told you PSC's POS was *"already solved — do not pitch"* and the opening was *"August 2026"*. Both had been reversed. Bepoz is now a genuine integration block with its own fork plan, and the opening moved to September and was published on a verified GBP profile. A session acting on that would have steered away from the exact integration work that was blocking.

### What now guards it

**`digestedAt` on every manifest entry** — the date (or exact ISO timestamp) that entry's prose was authored. **`--verify` compares it against the source's mtime** and reports `DIGEST DRIFT` with the age. Two accepted forms, deliberately:

| Form | Read as | Use when |
|---|---|---|
| `"2026-08-27"` | end of that day | hand-typing a digest; lenient, so it never cries wolf |
| `"2026-08-27T02:05:00.000Z"` | exact | a tool stamps it — catches same-day edits |

Same-day edits are not hypothetical: while this was being fixed, a concurrent Command Center session committed the Friday triage and invalidated four digests that had been written **an hour earlier**. Bare dates cannot see that; timestamps can.

Every synced row now also carries `digestedAt`, `sourceMtime` and `digestStale` in its metadata, so drift is queryable from the database, not just from the CLI:

```bash
curl -s "$SUPABASE_URL/rest/v1/thoughts?select=metadata&metadata->>digestStale=eq.true" \
  -H "apikey: $SUPABASE_SECRET_KEY" -H "Authorization: Bearer $SUPABASE_SECRET_KEY"
```

**Restoring a drifted digest:** rewrite its `content` in `manifest.mjs`, bump `digestedAt`, then sync.

### Why `syncedAt` alone was actively harmful

Before this, a row carried only `syncedAt`. Once the daily task existed, **every row was stamped with today's date on every run regardless of whether its content had changed** — so 56-day-old prose arrived wearing a fresh timestamp, and `last-sync.json` read `74/74 ok`. The one signal that might have revealed the problem (rows frozen at 2026-07-03) was destroyed by the automation built to help. `digestedAt` + `sourceMtime` are the honest pair; `syncedAt` only ever meant "when this row was last written".

### What this check still cannot see

**It compares the digest to its source. It cannot compare the source to reality.**

A memory file last edited 2026-06-06 still asserts PSC's POS is solved, and its digest matches it perfectly — so `--verify` is silent, correctly. `status.md` and `current-data.md` contradict it. That is the same ADR 0006 fault one level up: **the same fact in two writable places (a memory file and a context file) with no arbiter**, and no tool here can arbitrate it. Keeping sources true to reality is what the Friday triage and the re-derivation sessions are for; the brain can only ever be as accurate as what git says.

---

## Ad hoc capture → promotion rule

1. Capture freely, any client, any time: "remember this," "capture this thought," etc.
2. If it comes up again, or you find yourself wanting to reference it a second time, that's the signal to give it a real home — a line in the relevant context file, a new memory file, a tooling-backlog entry, whatever fits.
3. Add it to `manifest.mjs` with a `sourceSlug`, sync it in.
4. The original ad hoc capture can stay (it's harmless, tagged `source: "mcp"` so it's distinguishable from synced content) or be cleaned up later during a quarterly sweep — not urgent either way.

---

## Two source models: curated digests and file-backed rules

Coverage was measured on 2026-08-27 and was far narrower than a clean `--verify` implied — `outputs/` (73 real files), `reference/`, `research/`, three root files and **67 memory files across 18 other projects** were all unindexed. That is finding **F-03** from plan 0017. It is now closed, by adding a second source model rather than by hand-writing 150 more digests.

| | **Curated** (`manifest.mjs`) | **File-backed** (`sources.mjs`) |
|---|---|---|
| Content | a human-authored digest | the file itself, read at sync time |
| Count | 74 entries | 1,110 files as of 2026-11-07 (`--verify` prints the current count) |
| Retrieval | better — dense, deliberate prose | good; raw prose embeds less cleanly |
| Drift | **replaced by the source file** when the source is newer | **impossible by construction** |
| Adding a file | hand-write an entry | nothing; it is picked up next run |

**Use curated for what carries the most weight** — status, system map, ADRs, plans, memory. **Rules cover the long tail**, where the cost of hand-authoring exceeds the retrieval gain. A file matched by both is left to the curated entry; the sync dedupes on path. Command Center's `context/`, `decisions/` and `plans/` have rules too, so a new plan or ADR is indexed on the next run and can be promoted to a digest later.

**Rows are never removed when a source disappears.** `--verify` lists them as `DB ORPHAN`, and removing them is a deliberate manual step.

### How the rules work

`sources.mjs` declares roots, slug prefixes, tags and excludes. `--verify` prints coverage per rule and, importantly, prints **what nothing covers**, so a clean run can never be misread as total.

- **Chunking:** anything over 12,000 chars is split on paragraph boundaries with a 400-char overlap, one row per chunk, each prefixed with `Source: <path> (part N of M)` so a retrieved fragment can say where it came from. Chunks share a `sourceGroup`, and re-sync deletes by group so a shrinking file leaves no orphans.
- **Incremental:** every row carries a `contentHash`. Unchanged entries are skipped, so the daily task re-embeds only what actually changed — the first full run wrote 363 rows, the next wrote 0. `--force` overrides.
- **Surrogate safety:** slicing UTF-16 at an arbitrary index can cut an emoji in half and leave a lone surrogate, which `JSON.stringify` emits and PostgREST rejects with `PGRST102`. Boundaries are surrogate-aware and a final pass strips any that survive. Found via a `🔸` in a PSC legal doc.

### Project repos are in, as of 2026-08-27

Twelve repos are now indexed by rule — PSC, Ben's Trees, ICUMD, Field-Shader, Tweaker, Nelson BI, icu-tools, project-hub, GlensToolkit, vps-infra, permissible-lab, DrumGen. Before this, only each repo's `CLAUDE.md` was digested, so the actual work (plans, `STATE.md`, harvest logs, design notes) was invisible from the laptop and browser — exactly the surfaces with no local checkout.

**Client repos were deferred on two stated conditions** in the original migration: that the sync tool had a track record, and that each repo's state had settled. Both now hold, and the privacy scan below is what discharged the remaining risk.

**The excludes did most of the work here.** Two would have quietly wrecked the index:

- **Nelson BI** looked like 6.2 MB of markdown. **5.75 MB of that was a single `ATTRIBUTION.md` inside `.venv`** — 93% of the repo's markdown by weight, none of it Uriah's. Excluding virtualenvs took it to 39 real files.
- **Ben's Trees** carries **531 markdown files inside `.claude/worktrees`**: three full checkouts left by March agent sessions. Indexing them would have triple-counted the repo and surfaced superseded copies as if current. Excluded, it is 13 files.

Anything indexing a repo tree needs these excludes. Check a new root's real file count before adding it — the raw number is usually wrong.

### The privacy boundary is enforced in `sources.mjs`, not by care

The excludes are load-bearing: `node_modules` (38 files that would otherwise have been indexed), browser dumps, the copyrighted textbook extract, and `MEMORY_DIR_EXCLUDES` — which names Whetstone as a standing guard **for when it gets a memory directory**, not because it has one now. A scan before the first run confirmed no customer data in scope; the only matches were the workspace *describing* this very boundary.

**Any new rule must be checked the same way.** Point rules at planning, research and orientation material — never at anything holding a client's *customers'* data.

The scan run before adding the twelve repos, worth repeating verbatim when adding another:

```bash
# live credentials — any hit is disqualifying
grep -rohE 'sk_live_[A-Za-z0-9]{6,}|pk_live_[A-Za-z0-9]{6,}|whsec_[A-Za-z0-9]{6,}' <root> --include='*.md'
# third-party personal email addresses
grep -rohEi '[a-z0-9._%+-]+@(gmail|hotmail|outlook|yahoo)\.[a-z]{2,}' <root> --include='*.md'
# customer-data shapes — read every hit, do not count them
grep -rlEi 'INSERT INTO|customer_email|buyer_email|attendee|ticket_holder' <root> --include='*.md'
```

**The third one always hits on PSC and is meant to.** Every match was a feature description — *"Attendees — CSV + print door list by surname"* — describing an admin screen, not containing a door list. **Read the hits; never clear the scan on counts alone.** The distinction between "documents the schema" and "contains the rows" is the whole boundary.

---

## Growth sequencing — what's in, what's out, and why

**Client repos are now IN, as of 2026-08-27.** This reverses the original deferral, which was conditional rather than permanent: it asked that the sync tool survive real re-syncs without surprises, and that each repo's state settle. Both held — and the surprises the deferral was protecting against turned out to be in the *tooling* (digest drift, lone surrogates, virtualenv bloat), all found and fixed on the stable content first, exactly as intended.

**Still out, and why:**

| Excluded | Reason | Permanent? |
|---|---|---|
| **Whetstone** | ADR 0007 — unfiltered personal political reasoning; must never surface in a session doing client work | **Yes** |
| A client's *customers'* data | NZ Privacy Act / IPP12 — see the boundary section below | **Yes** |
| Dormant repos (GlenTools, TradeApp, WillitsProto, Democratic Workshop) | Flagged out-of-scope in `context/system-map.md`; nothing to gain until they reactivate | No — add a rule if one wakes up |
| Non-markdown (`.html` vision docs, proposals, PDFs, images) | The sync only reads `.md`. Several HTML docs have markdown twins that *are* indexed | No — would need a converter |
| Vendored and generated trees | `GLOBAL_EXCLUDES` — not authored content | Yes |

**To extend:** add a rule to `sources.mjs`. No manifest entries, no `BATCH_PREFIX` edit, no digest to write — a rule is a root, a slug prefix and some tags. Run the privacy scan above first, and check the root's *real* file count after excludes before trusting its size.

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
