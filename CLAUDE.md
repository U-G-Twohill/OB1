# CLAUDE.md — Agent Instructions for Open Brain

This file helps AI coding tools (Claude Code, Codex, Cursor, etc.) work effectively in this repo.

## What This Repo Is

Open Brain is a persistent AI memory system — one database (Supabase + pgvector), one MCP protocol, any AI client. This repo contains the extensions, recipes, schemas, dashboards, integrations, and skills that the community builds on top of the core Open Brain setup.

**License:** FSL-1.1-MIT. No commercial derivative works. Keep this in mind when generating code or suggesting dependencies.

## Repo Structure

```
extensions/     — Curated, ordered learning path (6 builds). Do NOT add without maintainer approval.
primitives/     — Reusable concept guides (must be referenced by 2+ extensions). Curated.
recipes/        — Standalone capability builds. Open for community contributions.
schemas/        — Database table extensions. Open.
dashboards/     — Frontend templates (Vercel/Netlify). Open.
integrations/   — MCP extensions, webhooks, capture sources. Open.
skills/         — Reusable AI client skills and prompt packs. Open.
docs/           — Setup guides, FAQ, companion prompts.
resources/      — Official companion files and packaged exports.
```

Every contribution lives in its own subfolder under the right category and must include `README.md` + `metadata.json`.

## Parallel Agent Worktrees

When multiple AI agents or assistant chats work on this repo, do not put them in the same checkout.

### Setup pattern

- Treat the main repo checkout as the canonical repo for pulling, inspection, and creating worktrees.
- Create one Git worktree per active agent, task, or PR-sized workstream.
- Give each worktree a descriptive folder name and a matching branch name.
- Start every agent task by naming the exact absolute worktree path it owns.
- The assigned worktree path is the boundary. The chat is not the boundary.

### Agent assignment template

Start each parallel-agent task with:

```text
Repository worktree:
/ABSOLUTE/PATH/TO/PROJECT-WORKTREE

Branch:
codex/SHORT-TASK-NAME

Task:
DESCRIBE THE EXACT WORK.
```

### Rules

- Do not switch branches in the canonical repo while another agent may be working.
- Do not edit sibling worktrees unless explicitly asked.
- Before staging or committing, run `git status --short` and stage only files that belong to the current task.
- If `main` or another branch changed underneath the worktree, pause before merging or rebasing unless the task explicitly says to finish the PR end to end.
- After a branch is merged and the worktree is clean, remove the finished worktree with `git worktree remove /ABSOLUTE/PATH/TO/PROJECT-WORKTREE`.

### Quick checks

- If another chat suddenly changed branches, both chats were probably in the same working directory.
- If `git worktree add` says a branch is already checked out, create a new branch name or remove the old clean worktree.
- If cleanup fails, inspect `git status --short` and preserve uncommitted work.

## Guard Rails

- **Never modify the core `thoughts` table structure.** Adding columns is fine; altering or dropping existing ones is not.
- **No credentials, API keys, or secrets in any file.** Use environment variables.
- **No binary blobs** over 1MB. No `.exe`, `.dmg`, `.zip`, `.tar.gz`.
- **No `DROP TABLE`, `DROP DATABASE`, `TRUNCATE`, or unqualified `DELETE FROM`** in SQL files.
- **Avoid profanity in all content.** Keep docs, examples, seed data, UI copy, prompts, walkthroughs, and generated assets clean and professional.
- **MCP servers must be remote (Supabase Edge Functions), not local.** Never use `claude_desktop_config.json`, `StdioServerTransport`, or local Node.js servers. All extensions deploy as Edge Functions and connect via Claude Desktop's custom connectors UI (Settings → Connectors → Add custom connector → paste URL). See `docs/01-getting-started.md` Step 7 for the pattern.

## PR Standards

- **Title format:** `[category] Short description` (e.g., `[recipes] Email history import via Gmail API`, `[skills] Panning for Gold standalone skill pack`)
- **Branch convention:** `contrib/<github-username>/<short-description>`
- **Commit prefixes:** `[category]` matching the contribution type
- Every PR must pass the automated review checks in `.github/workflows/ob1-gate-v2.yml` before human review
- See `CONTRIBUTING.md` for the full review process, metadata.json template, and README requirements

## Key Files

- `CONTRIBUTING.md` — Source of truth for contribution rules, metadata format, and the review process
- `.github/workflows/ob1-gate-v2.yml` — Automated PR gate
- `.github/workflows/claude-review.yml` — Maintainer-triggered Claude PR review
- `.github/metadata.schema.json` — JSON schema for metadata.json validation
- `.github/PULL_REQUEST_TEMPLATE.md` — PR description template
- `LICENSE.md` — FSL-1.1-MIT terms

## Local GSD Execution Layer

This repo also has a maintainer-local GSD layer in `.planning/`.

- If `.planning/` exists, use it for local brownfield planning and phased execution.
- Start with `.planning/STATE.md`, then read `.planning/PROJECT.md`, `.planning/ROADMAP.md`, and the relevant `.planning/codebase/*.md` documents.
- Keep `.planning/` local. It is gitignored intentionally and is not part of the public contribution contract or upstream PR scope.
- Public contributor rules still come from `CLAUDE.md`, `AGENTS.md`, `CONTRIBUTING.md`, and the committed repo files.

## Fork-local: ICU Media Design deployment (not upstream scope)

This fork (`U-G-Twohill/OB1`, cloned to `D:\Repos\icu-brain`) runs a live personal instance. Fork-local operational docs live in `docs/architecture.md`, `docs/golden-queries.md`, and `docs/maintenance-playbook.md`. **These are not upstream contribution scope** — keep fork-local changes out of upstream PRs.

**⚠️ Open work as of 2026-08-27 — read `docs/maintenance-playbook.md` first.**

1. ~~**The index is stale.**~~ **Resolved 2026-08-27.** The index had fallen ~8 weeks behind (last write 2026-07-03) and the Supabase project auto-paused on the free tier. Caught up: 9 missing sources added to `manifest.mjs` (ADRs 0006–0008, plans 0015–0018, 2 memory files), all 74 entries synced, `--verify` clean. Staleness is now covered by two daily Windows scheduled tasks — `OpenBrain-Sync` (full sync, 09:00) and `OpenBrain-KeepWarm` (a ping that stops the free tier idling into a pause, 12:00). **This reverses the playbook's former "no silent automation" rule**; the reasoning and the health-check commands are in the playbook's Automation section. Desktop only — the laptop has no equivalent.
2. ~~**Digest drift was undetectable.**~~ **Resolved 2026-08-27.** The sync embeds each manifest entry's hand-authored `content` and **never reads the source file** — so editing a source changed nothing in the brain, and re-running the sync could not fix it. 12 of 74 digests had drifted; four were 56 days stale and were the orientation docs (`status.md`, `system-map.md`, `current-data.md`, the workspace `CLAUDE.md`). All 12 rewritten. Every entry now carries `digestedAt`, `--verify` reports `DIGEST DRIFT` against source mtime, and rows carry `digestedAt`/`sourceMtime`/`digestStale`. See the playbook's "the sync never reads your source files" section.
3. **`update_thought` still has no arbiter.** It selects by UUID (`integrations/update-thought-mcp/index.ts:75-229`), never checks `sourceSlug`, and its metadata shallow-merge lets a caller set or clear `sourceSlug` itself. A row edited through it is silently reverted by the next sync with nothing reporting it, and `--verify` still never queries the database for parity. Specified in Command Center `plans/0015-adr-0006-evidence-gate-fixes.md` Step 7.
4. ~~**Coverage is narrower than `--verify` implies.**~~ **Resolved 2026-08-27.** `sources.mjs` adds a second source model: declarative rules that read files from disk at sync time (so they cannot drift) and chunk anything too large to embed. Now indexed: all of Command Center (`outputs/`, `reference/`, `research/`, root docs), **67 memory files across 18 other project dirs**, and **12 project repos** (PSC, Ben's Trees, ICUMD, Field-Shader, Tweaker, Nelson BI, icu-tools, project-hub, GlensToolkit, vps-infra, permissible-lab, DrumGen) — **694 files / ~1,200 chunks** alongside the 74 curated digests. Syncs are incremental via `contentHash`, so unchanged files cost nothing and a no-op run takes under a second. Still deliberately out: **Whetstone** (ADR 0007, permanent), non-markdown, and vendored/generated trees. `--verify` prints coverage per rule and what nothing covers, every run.

   **If you add a source root, check its real file count first.** Nelson BI looked like 6.2 MB and was 93% a virtualenv `ATTRIBUTION.md`; Ben's Trees had 531 markdown files inside stale `.claude/worktrees` checkouts. The `GLOBAL_EXCLUDES` in `sources.mjs` are load-bearing, and so is the privacy scan documented in the playbook — read every hit, never clear it on counts.
5. **The check compares digests to sources; it cannot compare sources to reality.** A memory file last edited 2026-06-06 still asserts PSC's POS is "already solved, do not pitch" — its digest matches perfectly, so nothing flags it, while `status.md` says the opposite. That is ADR 0006 one level up: two writable places, no arbiter. **Correcting that file is the top open action.** Full write-up: Command Center `outputs/open-brain-digest-drift-2026-08-27.md`.

**Don't read a green `logs/last-sync.json` as "the index is correct."** It means the database matches the manifest, and no digest is older than its source. It does not mean the sources are true.

Governing decision: Command Center `decisions/0006-evidence-gating-keys-on-availability.md` — *where a fact lives in two writable places, name the arbiter explicitly and make every derived copy read-only or write-back.* Here git is the arbiter; the code should enforce that rather than trusting discipline.
