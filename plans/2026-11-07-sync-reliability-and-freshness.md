# Plan: Open Brain sync reliability and freshness

**Created:** 2026-11-07
**Status:** Implemented
**Request:** Make the scheduled sync survive wake-time network failures, make interrupted runs visible, index new plans and ADRs automatically, and stop stale digests being served.

---

## Overview

### What This Plan Accomplishes

The scheduled sync waits for the network and retries, and every run leaves an honest record, including runs killed part-way. New Command Center plans, decisions and context files are indexed with no manual step. A curated digest older than its source is replaced in the index by the source file, until someone re-authors the digest.

### Why This Matters

Git is the source of truth and the brain is a derived copy, so anything that lets the copy lag without saying so undermines every client that reads it. Measured on 2026-11-07: all 1,169 sources match their database rows, but 12 digests are older than their sources (strategy and status among them) and 15 plans/ADRs are not indexed at all.

---

## Current State

### Relevant Existing Structure

- `scripts/brain-sync.mjs`: the sync, `--verify`, chunking, and the incremental hash skip.
- `scripts/scheduled-sync.mjs`: scheduled wrapper; writes `logs/last-sync.json` when a run ends.
- `scripts/keep-warm.mjs`: free-tier ping, deliberately independent of the sync path.
- `manifest.mjs`: 74 curated digests. `sources.mjs`: file-backed rules.
- Scheduled tasks `OpenBrain-Sync` (10:00 NZDT) and `OpenBrain-KeepWarm` (13:00 NZDT). The playbook says 09:00 and 12:00.

### Gaps or Problems Being Addressed

1. **Wake-time failures.** The three failed runs inspected (10-19, 10-30, 11-04) were `getaddrinfo ENOTFOUND`. Nine keep-warm pings failed with `fetch failed`. `StartWhenAvailable` runs tasks on wake, and nothing waits for DNS.
2. **Invisible interruptions.** Status is only written at the end of a run, so a killed run (11-03, 11-05, today's `0xC000013A`) leaves `last-sync.json` saying `ok`. A top-level crash also records `ok=null` with no reason.
3. **Coverage needs a manual step.** Plans and decisions need a hand-written manifest entry, so 15 are unindexed.
4. **Digests rot.** `--verify` reports drift but nobody acts on it. 12 of 74 have drifted again since being fixed on 2026-08-27.
5. **`--verify` never queries the database,** so it cannot tell whether rows match sources. Reported as open in `CLAUDE.md` item 3.

---

## Proposed Changes

### Summary of Changes

- Add a small network-wait helper, used by both scheduled scripts.
- Retry the sync on network-shaped failures.
- Write `running` status at the start of a run, detect interrupted predecessors, keep `lastOkAt`, and record the crash reason.
- Add rules for Command Center `context/`, `decisions/` and `plans/`. Curated entries still win.
- Serve the source file in place of a drifted digest.
- Add a database parity check to `--verify`, including orphan reporting. Report only.
- Update the docs.

### New Files to Create

| File Path | Purpose |
| --- | --- |
| `scripts/lib/network.mjs` | `waitForDns(host, opts)` and `isNetworkFailure(text)` |
| `plans/2026-11-07-sync-reliability-and-freshness.md` | This plan |

### Files to Modify

| File Path | Changes |
| --- | --- |
| `scripts/scheduled-sync.mjs` | Network wait, retry, `running` status, interruption detection, crash reason, `lastOkAt` |
| `scripts/keep-warm.mjs` | Network wait before the ping |
| `scripts/brain-sync.mjs` | Drifted-digest fallback; async `--verify` with parity check |
| `sources.mjs` | Three new rules; updated header comment |
| `docs/maintenance-playbook.md` | Corrected schedule, new behaviour, stale claims |
| `CLAUDE.md` | Open-work list brought up to date |

### Files to Delete (if any)

None.

---

## Design Decisions

### Key Decisions Made

1. **Wait for DNS, then retry the whole sync.** A network wait covers the observed cause, and a retry covers a drop mid-run. Sync is incremental, so a retry only redoes unfinished work.
2. **Retry only network-shaped failures.** A bad manifest entry would fail identically each time, so retrying it just hides it.
3. **Bound the total time.** Up to 5 minutes of waiting and 3 attempts, inside the task's 30-minute limit. If the network never arrives the run fails loudly.
4. **Detect interruption from the next run.** A killed process cannot report on itself, so `running` is written first and the next run reads it. This covers every kind of kill, where signal handlers would not.
5. **A drifted digest is replaced, not kept alongside.** Keeping both would still surface the wrong claim. The row keeps its slug, and re-authoring the digest and bumping `digestedAt` restores it automatically. Rows are marked `digestSuperseded: true`.
6. **Accept the retrieval trade-off.** Raw prose embeds less cleanly than a digest, and `status.md` becomes about 14 chunks. A correct answer found less neatly beats a neat wrong one.
7. **New rule slugs use distinct prefixes** (`cc-context-file-`, `cc-decisions-`, `cc-plans-`) so they cannot collide with curated slugs such as `cc-plan-0001-track-a`.
8. **Parity compares content, not hashes alone.** Editing a row through `update_thought` changes its content but not its `contentHash`, so only a content comparison can catch that. This follows the playbook's rule against reimplementing `content_fingerprint`. It costs about 20 MB per `--verify`, and the scheduled sync does not run it.
9. **Orphan rows are reported, not deleted.** Deleting them removes the only remaining copy of those files' text, and the user has not asked for that.

### Alternatives Considered

- **Task setting `RunOnlyIfNetworkAvailable`:** rejected. It does not guarantee DNS, and it can skip a run outright.
- **Changing the task to S4U logon so it survives logoff:** rejected. It needs elevation, and the cause of the kills is not established.
- **Generating digests with an LLM:** rejected. It adds cost and a new way to be wrong, and raw source cannot disagree with itself.

### Open Questions (if any)

None block implementation. Two go back to the user afterwards:

1. Delete the 2 orphan rows?
2. Add rules for the uncovered active repos: icu-relay (29 md), Folio (40), image-visualizer (386), icu-platform (22), relay-sandbox (2)? Each needs the privacy scan and a real file count. `psc-plan` and `psc-rollback` are PSC worktrees and should stay out.

---

## Step-by-Step Tasks

### Step 1: Network helper

**Actions:**

- Create `scripts/lib/network.mjs`. `waitForDns(host, { timeoutMs = 300000, intervalMs = 15000 })` loops on `dns.promises.lookup` and returns `{ ok, waitedMs, error }`. It never throws.
- `isNetworkFailure(text)` matches `ENOTFOUND`, `EAI_AGAIN`, `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `UND_ERR_`, and `fetch failed`.

**Files affected:** `scripts/lib/network.mjs`

### Step 2: Keep-warm waits for the network

**Actions:**

- Before the ping, wait for the Supabase host. Log the wait if it was over a few seconds.
- If DNS never resolves, keep the existing `FAIL` path with a clear message. No manifest or embedding imports are added.

**Files affected:** `scripts/keep-warm.mjs`

### Step 3: Scheduled sync records honestly and retries

**Actions:**

- On start, read the previous status. If it says `running`, log `WARN previous run ... was interrupted` and set `interruptedPrevious` on the new status.
- Write `{ status: "running", startedAt, pid, lastOkAt }` before anything else can fail.
- Read `SUPABASE_URL` from `.env` for the host, and wait for DNS.
- Run the sync up to 3 times, retrying only when `isNetworkFailure(out)` is true, with 60 seconds between attempts.
- Final status adds `attempts`, `waitedMs`, `lastOkAt`, `interruptedPrevious`, and on failure `error`: the last 15 lines of output.
- Log each attempt's output, not just the last.

**Files affected:** `scripts/scheduled-sync.mjs`

### Step 4: New coverage rules

**Actions:**

- Add `cc-context`, `cc-decisions` and `cc-plans` to `sources.mjs`, following the existing shape. Curated paths already dedupe out.
- The privacy scan of the 15 new files and 74 curated sources was run on 2026-11-07: no live credentials, no third-party emails, no token shapes, and every customer-shape hit was a feature or boundary description.

**Files affected:** `sources.mjs`

### Step 5: Drifted-digest fallback

**Actions:**

- In `selectEntries()`, convert a manifest entry where `isDigestStale(entry)` is true to `{ ...entry, path: <resolved>, strategy: "file", digestSuperseded: true }`.
- Keep `sourceSlug`, `tags`, `type` and `digestedAt`. Fall back only when the source is a readable file.
- In `upsertThought`, add `digestSuperseded` to metadata. Keep `digestStale` truthful for these rows rather than the blanket `false` used for file-backed rows.
- Log the number of digests served from source in the summary.

**Files affected:** `scripts/brain-sync.mjs`

### Step 6: Database parity in `--verify`

**Actions:**

- Make `runVerify` async. Keep the existing checks and reword the drift message to say the source is being served.
- Fetch all `sourceSlug` rows, paginated, with `content`. Compare each expected part by slug and report `DB DRIFT`, `DB MISSING` and `DB ORPHAN`, with a summary line.
- Report the newest sync time.
- If the database is unreachable, say parity was not checked. Never report it as clean.
- Share the fallback logic with the sync, so parity compares what a sync would actually write.

**Files affected:** `scripts/brain-sync.mjs`

### Step 7: Test before syncing

**Actions:**

- `waitForDns` against a real host and an unresolvable one with a short timeout.
- Start `scheduled-sync.mjs`, confirm `running` is written, kill it, and confirm the next run reports the interruption.
- `--dry-run` to confirm the expected new sources and fallback digests appear and nothing else does.

### Step 8: Run the real sync and verify

**Actions:**

- Run `node scripts/scheduled-sync.mjs`, then `--verify`.
- Search the brain for PSC status and strategy, and confirm stale claims have been replaced.
- Spot-check 2-3 queries from `docs/golden-queries.md`.
- Trigger the real scheduled task with `Start-ScheduledTask` and confirm `last-sync.json` updates.

### Step 9: Docs

**Actions:**

- Playbook: correct the schedule, describe wait/retry and the new status fields, describe the fallback, and replace stale claims (re-embeds all 74 entries, 694 files, `--verify` cannot detect drift).
- `CLAUDE.md`: update the open-work list. `update_thought` guard stays open. Note the POS memory is still wrong.

**Files affected:** `docs/maintenance-playbook.md`, `CLAUDE.md`

---

## Connections & Dependencies

### Files That Reference This Area

`docs/architecture.md` describes the sync path; `docs/golden-queries.md` is used for spot checks; Command Center `plans/0015-adr-0006-evidence-gate-fixes.md` Step 7 specifies parity at `scripts/lib/parity.mjs`.

### Updates Needed for Consistency

Playbook and `CLAUDE.md` as in Step 9. Plan 0015 lives in another repo and is left alone; report that its parity item is done and its `update_thought` guard is not.

### Impact on Existing Workflows

Hand-authoring a digest still works and still wins once `digestedAt` is bumped. The scheduled tasks keep the same commands. `--verify` gets slower and needs network access.

---

## Validation Checklist

- [ ] Unresolvable host fails within its timeout and does not throw
- [ ] A killed run leaves `running`, and the next run reports the interruption
- [ ] A failed run records a readable `error`
- [ ] `--verify` shows 0 unlisted and 0 `DB DRIFT` / `DB MISSING`
- [ ] Drifted digests appear as `digestSuperseded` rows from the source file
- [ ] Brain search no longer returns the old strategy digest's August opening
- [ ] `Start-ScheduledTask` run succeeds and updates `last-sync.json`
- [ ] No orphan rows deleted

---

## Success Criteria

1. A sync started with no DNS waits and then succeeds, or fails with a stated reason.
2. No interrupted run can leave `last-sync.json` reading `ok`.
3. A new plan or ADR is indexed on the next sync with no manual step.
4. An edited digest source reaches the brain on the next sync with no manual step.
5. `--verify` answers whether the database matches its sources.

---

## Notes

- **The brain can only be as true as its sources.** `status.md` (2026-09-12) predates PSC going live, and the POS memory is still wrong. Both are Command Center content fixes outside this plan.
- **Still open:** the `update_thought` guard, and the laptop having no scheduled sync.
- This repo has no earlier `plans/` directory. The file is fork-local and should stay out of upstream PRs.

---

## Implementation Notes

**Implemented:** 2026-11-07

### Summary

All nine steps done. The sync wrote 27 sources and 75 rows, exactly what parity predicted beforehand. `--verify` now reports 0 unlisted, 0 differ, 0 missing, 0 extra, and 2 orphaned sources. Both scheduled tasks returned 0 when triggered.

### Deviations from Plan

- The literal NUL byte in the hash expression was replaced with the equivalent `"\u0000"` escape. It produces the same hashes, and the literal made grep and `file` treat the script as binary.
- `DB EXTRA CHUNK` was added as a fourth parity label, for rows left over when a source's chunk layout changes.
- `scripts/lib/parity.mjs` from plan 0015 Step 7 was not created. Parity needs the sync's internal helpers, so it lives in `brain-sync.mjs`.

### Issues Encountered

- The first parity probe reported 391 sources behind. That was a bug in the probe, not the index: its hash used a typed space where the sync uses a NUL separator.
- **Retrieval got worse for some queries, as Design Decision 6 expected.** Ranks after the change, for four golden queries (top 8):
  - "What state is project-hub in?": `repo-project-hub` is 3rd at 44.3%, and `cc-context-current-data` is out of the top 8.
  - "Deploy target for the ICUMD site?": neither expected source (`cc-status-current`, `cc-plan-0001-track-a`) is in the top 8.
  - "PSC ticketing engine status?": the expected memory is 2nd at 53.3%, but it is the file holding the stale claims. The current `psc-site-live-door-only` memory is 4th.
  - "Why is Ben's Trees paused?": the expected memory is 4th, behind two March run logs. The curated digest is unchanged, so the fallback is not the cause.
- **Validation item not fully met:** search still returns the August opening and the POS claim from `memory-project-public-service-centre`. That digest has not drifted, because its source (last edited 2026-06-06) still says this. It needs a content fix in Command Center. `context/strategy.md` also still says "Aug 2026" in its priority list.
