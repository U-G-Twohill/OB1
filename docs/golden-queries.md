# Golden Queries — Open Brain Retrieval Acceptance Test

> Run these after every migration/re-sync to prove retrieval actually works, not just that data exists. For each: ask any connected client (or hit `search_thoughts` directly), confirm the expected source appears in the top 3 results with similarity ≥ ~0.35 (this corpus is short/dense enough that strong matches often land 40-70%). Record pass/fail below.

| # | Question | Expected source (sourceSlug) | Result (2026-07-03) |
| --- | --- | --- | --- |
| 1 | Why is Ben's Trees paused? | `memory-project-real-client-sequencing-2026-05` or `cc-status-current` (+2026-11-10: `cc-context-current-data`, `r-bens-trees-claude`) | ✅ PASS (41.9%, correct source top-1) |
| 2 | What's the deploy target for the ICUMD portfolio site? | `cc-status-current` / `cc-plan-0001-track-a` (+2026-11-10: `mem-d-websites-icumd-clone-designer-hosting-target`, `repo-vps-infra`, `cc-output-icumd-handoff-prompt`) | ✅ PASS (53.6%) |
| 3 | What's the harvest discipline / 15-minute rule? | `memory-project-hybrid-delivery-methodology` | ✅ PASS (47.8%) |
| 4 | Why did we build Open Brain instead of buying Basic Memory Cloud? | `cc-context-second-brain-design` / `cc-decision-adr-0003` | ✅ PASS (65.7%) |
| 5 | What's the change-propagation checklist and when does it apply? | `memory-feedback-change-propagation` | ✅ PASS (63.1%) |
| 6 | What state is project-hub in? | `repo-project-hub` / `cc-context-current-data` | ✅ PASS (50.4%) |
| 7 | Why does Uriah dislike "ship ugly" framing? | `memory-feedback-ship-minimal-not-ugly` | ✅ PASS (53.4%) |
| 8 | What are the three maintenance categories? | `memory-project-maintenance-3-categories` | ✅ PASS (67.6%) |
| 9 | What's the status of Public Service Center's ticketing engine? | `memory-project-psc-ticketing-stack` / `memory-project-public-service-centre` | ✅ PASS (68.8%) |
| 10 | What went wrong with the deep-research workflow on 2026-07-02? | `memory-feedback-usage-budget-no-fanout` | ⚠️ MISS on first phrasing (top-5 didn't surface it, all ~42-44%) — **retried with vocabulary closer to the source** ("usage budget Fable fan-out burned session limits") → 65.3%, correct source. Content is fine; the abstract phrasing just doesn't share vocabulary with the digest. See note below. |
| 11 | Why is Command Center a separate workspace from project-hub? | `cc-decision-adr-0001` / `memory-project-command-center-purpose` | ✅ PASS (71.0%) |
| 12 | What's the Improvement Engagement pricing tier? | `memory-project-improvement-engagement-tier` | ✅ PASS (77.7%) |
| 13 | What is icu-tools and what phase is it in? | `repo-icu-tools` / `memory-project-track-d-delivery-suite` | ✅ PASS (59.7%) |
| 14 | What's Cal.com used for and why was it chosen over Calendly? | `memory-reference-calcom-booking` | ✅ PASS (67.4%) |
| 15 | What coordination-layer tooling gaps did the 2026-07-02 audit find? | `cc-plan-0011-coordination-tooling` (+2026-11-10: `cc-output-full-audit-2026-07-02`) | ✅ PASS (52.6%) |

**Run log (2026-07-03):** all 15 queries executed via direct `search_thoughts` calls against the deployed Edge Function immediately after the full migration (58 entries, verified complete via `--verify`). 14/15 hit their expected source in the top result on first phrasing; #10 needed a re-phrase closer to the source's own vocabulary to surface — genuinely useful signal, not a failure to paper over (see below). Idempotency and freshness (edit → re-sync → old content replaced, not duplicated) were separately verified during the sync run itself: count held at 58 across a no-op re-sync and a content-edit re-sync.

**Lesson from #10 — semantic search still rewards vocabulary overlap.** "What went wrong with X" is abstract; the source talks concretely about "usage budget," "Fable," "fan-out," "session limits." When a query returns nothing convincing, try re-phrasing toward the domain's own words before concluding the content is missing — this is now noted in the maintenance playbook.

---

## Update 2026-07-03 — default search threshold was too strict, now fixed

**Real-world multi-surface testing found a genuine defect this initial verification pass missed.** My own golden-query run above used an explicit `threshold: 0.3` in the test script — I never actually exercised the *default* a client gets when it calls `search_thoughts` with no threshold argument, which was `0.5`. Uriah's live test across Claude.ai browser and laptop Claude Code (both calling with no explicit threshold) surfaced this immediately: 2 of 3 test questions returned "no thoughts found" on the laptop, and Claude.ai only got 3/3 after manually retrying at threshold 0.05. The best matches for this corpus routinely land in the 24–48% band (short, dense digests rather than long documents), well under the 0.5 default cutoff — so out-of-the-box search felt broken even though the content was all there and correct.

**Fix applied 2026-07-03:** changed both hardcoded thresholds in the deployed Edge Function (`search_thoughts`'s default, and the ChatGPT-compat `search` tool's hardcoded value) from `0.5` to `0.3`, redeployed. Re-verified with no explicit threshold: all three previously-failing/inconsistent questions now return the correct top result on the first call (Ben's Trees ~42%, harvest rule ~48%, PSC ticketing ~69%). No client-side workaround needed anymore.

**Lesson for future digest-writing:** this corpus's embeddings score lower on average than a typical "well-written prose article" corpus OB1 was probably tuned against, likely because the digests are dense/list-like rather than narrative. If future entries keep landing under 30% even for clearly-relevant matches, consider whether digests need more natural-language framing (full sentences over compressed fact-lists) rather than lowering the threshold further.

**How to re-run:** `curl` or any connected client, `search_thoughts` tool, query = the question text verbatim, default threshold (0.5) or lower to 0.3 if nothing returns. Update the Result column and the run-log date each time.

---

## Expanded 2026-11-10 — questions about current work, run automatically

The fifteen questions above date from the July migration and mostly ask about May–July
decisions. These seventeen cover the portfolio as it stands in November: PSC live, the repos
added since, and the rules a session elsewhere most needs.

**How the expected sources were chosen.** By searching the source files for the answer, not by
looking at search results, and listing every source that states it. A question passes when any
of them ranks in the top 3. Three of the original rows gained sources the same way (marked
+2026-11-10): the brain had grown documents that answer them correctly, and counting those as
misses measured the test, not the brain.

**These run every day.** `scripts/brain-report.mjs` asks all of them after each scheduled sync,
through the same search the MCP tools use, and shows ranks and rank changes in
`logs/brain-report.html`. Results are no longer recorded by hand in this file.

**This file is not indexed** (`sources.mjs`, repo-icu-brain rule): it contains the questions
verbatim, so indexing it made every question match this file.

| # | Question | Expected source (sourceSlug) |
| --- | --- | --- |
| 16 | When did Public Service Center open and go live? | `r-psc-docs-state` / `r-psc-claude` / `memory-project-public-service-centre` / `memory-project-psc-ticketing-stack` / `cc-context-current-data` / `cc-context-strategy` / `cc-status-current` / `mem-d-websites-public-service-center-psc-site-live-door-only` |
| 17 | Is PSC selling tickets through EzeTix or its own engine right now? | `r-psc-docs-state` / `r-psc-claude` / `r-psc-docs-launch-decision-card` / `memory-project-psc-ticketing-stack` / `memory-project-public-service-centre` |
| 18 | What is the next piece of work on PSC? | `r-psc-plans-2026-11-03-after-ticketing-goes-live` / `r-psc-docs-state` / `r-psc-claude` / `memory-project-psc-ticketing-stack` / `memory-project-public-service-centre` |
| 19 | What is Tweaker and how is it installed? | `r-tweaker-readme` / `r-tweaker-claude` / `r-tweaker-docs-state` / `cc-decision-adr-0008` / `cc-context-system-map` |
| 20 | What is icu-relay for? | `r-icu-relay-claude` / `r-icu-relay-docs-state` / `r-icu-relay-decisions-0001-dedicated-repo-and-cli-subprocess` / `cc-context-system-map` |
| 21 | What does the Folio app do? | `r-folio-readme` / `r-folio-docs-state` / `r-folio-claude` |
| 22 | What is icu-platform and what is the chassis? | `r-icu-platform-readme` / `r-icu-platform-docs-state` / `r-icu-platform-docs-00-chassis` / `cc-decisions-0010-chassis-ownership-and-module-library` |
| 23 | What is the main caveat with Nelson BI business rankings? | `r-nelson-bi-claude` / `r-nelson-bi-docs-icp` / `r-nelson-bi-readme` |
| 24 | Why is Whetstone kept out of Open Brain? | `cc-decision-adr-0007` / `cc-plan-0016-whetstone-pointer` / `cc-context-system-map` |
| 25 | What should happen when the same fact is written in two places? | `cc-decision-adr-0006` / `memory-decision-evidence-gating-availability` / `cc-output-tooling-backlog` |
| 26 | How do I retire a Command Center planning folder once the project has its own repo? | `cc-reference-graduation` / `cc-context-system-map` |
| 27 | What went wrong with the PSC two-factor login? | `r-psc-docs-2fa-gate-loop-diagnostics` / `r-psc-docs-build-history` |
| 28 | What is the rule before changing anything on PSC production? | `mem-d-websites-public-service-center-staging-first-uriah-tests-before-live` / `r-psc-docs-state` / `r-psc-claude` / `r-psc-docs-session-protocols` / `memory-project-public-service-centre` |
| 29 | Can I trust project-hub health scores and statuses? | `cc-decisions-0009-project-hub-disposition` / `cc-context-system-map` / `r-project-hub-project-hub-docs-state` / `repo-project-hub` / `memory-project-hub-state-tracking` |
| 30 | When should I spend Fable on a problem? | `memory-feedback-frontier-playbook-pattern` / `memory-feedback-usage-budget-no-fanout` |
| 31 | How is the Open Brain sync kept healthy? | `r-icu-brain-docs-maintenance-playbook` / `r-icu-brain-claude` / `memory-project-open-brain-migration` / `cc-plan-0013-brain-migration` |
| 32 | Where is the ICUMD site hosted? | `mem-d-websites-icumd-clone-designer-hosting-target` / `repo-vps-infra` / `cc-output-icumd-handoff-prompt` / `cc-output-full-audit-2026-07-02` / `cc-status-current` |
