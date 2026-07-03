# Golden Queries — Open Brain Retrieval Acceptance Test

> Run these after every migration/re-sync to prove retrieval actually works, not just that data exists. For each: ask any connected client (or hit `search_thoughts` directly), confirm the expected source appears in the top 3 results with similarity ≥ ~0.35 (this corpus is short/dense enough that strong matches often land 40-70%). Record pass/fail below.

| # | Question | Expected source (sourceSlug) | Result (2026-07-03) |
| --- | --- | --- | --- |
| 1 | Why is Ben's Trees paused? | `memory-project-real-client-sequencing-2026-05` or `cc-status-current` | ✅ PASS (41.9%, correct source top-1) |
| 2 | What's the deploy target for the ICUMD portfolio site? | `cc-status-current` / `cc-plan-0001-track-a` | ✅ PASS (53.6%) |
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
| 15 | What coordination-layer tooling gaps did the 2026-07-02 audit find? | `cc-plan-0011-coordination-tooling` | ✅ PASS (52.6%) |

**Run log (2026-07-03):** all 15 queries executed via direct `search_thoughts` calls against the deployed Edge Function immediately after the full migration (58 entries, verified complete via `--verify`). 14/15 hit their expected source in the top result on first phrasing; #10 needed a re-phrase closer to the source's own vocabulary to surface — genuinely useful signal, not a failure to paper over (see below). Idempotency and freshness (edit → re-sync → old content replaced, not duplicated) were separately verified during the sync run itself: count held at 58 across a no-op re-sync and a content-edit re-sync.

**Lesson from #10 — semantic search still rewards vocabulary overlap.** "What went wrong with X" is abstract; the source talks concretely about "usage budget," "Fable," "fan-out," "session limits." When a query returns nothing convincing, try re-phrasing toward the domain's own words before concluding the content is missing — this is now noted in the maintenance playbook.

---

## Update 2026-07-03 — default search threshold was too strict, now fixed

**Real-world multi-surface testing found a genuine defect this initial verification pass missed.** My own golden-query run above used an explicit `threshold: 0.3` in the test script — I never actually exercised the *default* a client gets when it calls `search_thoughts` with no threshold argument, which was `0.5`. Uriah's live test across Claude.ai browser and laptop Claude Code (both calling with no explicit threshold) surfaced this immediately: 2 of 3 test questions returned "no thoughts found" on the laptop, and Claude.ai only got 3/3 after manually retrying at threshold 0.05. The best matches for this corpus routinely land in the 24–48% band (short, dense digests rather than long documents), well under the 0.5 default cutoff — so out-of-the-box search felt broken even though the content was all there and correct.

**Fix applied 2026-07-03:** changed both hardcoded thresholds in the deployed Edge Function (`search_thoughts`'s default, and the ChatGPT-compat `search` tool's hardcoded value) from `0.5` to `0.3`, redeployed. Re-verified with no explicit threshold: all three previously-failing/inconsistent questions now return the correct top result on the first call (Ben's Trees ~42%, harvest rule ~48%, PSC ticketing ~69%). No client-side workaround needed anymore.

**Lesson for future digest-writing:** this corpus's embeddings score lower on average than a typical "well-written prose article" corpus OB1 was probably tuned against, likely because the digests are dense/list-like rather than narrative. If future entries keep landing under 30% even for clearly-relevant matches, consider whether digests need more natural-language framing (full sentences over compressed fact-lists) rather than lowering the threshold further.

**How to re-run:** `curl` or any connected client, `search_thoughts` tool, query = the question text verbatim, default threshold (0.5) or lower to 0.3 if nothing returns. Update the Result column and the run-log date each time.
