// Bulk source rules — the second half of the sync model.
//
// manifest.mjs holds CURATED entries: a human wrote a digest, and the sync embeds that
// prose. Excellent retrieval, but it does not scale and it rots (see the 2026-08-27
// digest-drift finding — four orientation digests sat 56 days stale).
//
// This file holds DECLARATIVE rules instead. The sync expands them at scan time, reads
// each file's real content, and chunks anything too large to embed in one call. Two
// consequences that matter:
//
//   1. **Drift is structurally impossible here.** The content is read from disk on every
//      run, so a file-backed entry can never disagree with its source. There is no digest
//      to go stale, so there is nothing to re-author by hand.
//   2. **Coverage costs nothing to maintain.** A new file under a listed root is indexed
//      on the next run without anyone adding an entry.
//
// The trade is retrieval quality: raw prose embeds less cleanly than an authored digest,
// which is exactly why the curated layer still exists for the documents that carry the
// most weight (status, system map, ADRs, plans, memory). Curated wins where it is worth
// the hand-work; rules cover the long tail.
//
// A file matched by BOTH is left to the curated entry — the sync dedupes on path.
//
// PRIVACY BOUNDARY (hard rule, see docs/maintenance-playbook.md): these roots may only
// ever point at planning, research and orientation material. A client's *customers'*
// personal data — ticket-buyer records, attendee lists, order or customer exports —
// must never be indexed. The excludes below are load-bearing, not tidiness.

const CC = process.env.COMMAND_CENTER_ROOT || "D:/Repos/Command Center Plan";
const CLAUDE_PROJECTS = process.env.CLAUDE_PROJECTS_ROOT || "C:/Users/ugtwo/.claude/projects";

// Never walk into these, anywhere. Dependency trees and browser dumps are not content;
// the textbook extract is third-party copyrighted material that has no business in a
// personal index.
export const GLOBAL_EXCLUDES = [
  /[\\/]node_modules[\\/]/,
  /[\\/]\.playwright-mcp[\\/]/,
  /[\\/]html[\\/]/,
  /[\\/]textbook-extract[\\/]/,
  /[\\/]\.git[\\/]/,
  /[\\/]dist[\\/]/,
  /[\\/]__pycache__[\\/]/,
];

// Claude Code memory directories that must NOT be indexed, by project-dir name.
//   - Command Center's is already covered by curated `memory-*` entries in manifest.mjs.
//   - Whetstone is excluded by decision (ADR 0007): it holds unfiltered personal
//     political reasoning and must never surface into a session working on client work.
//     It has no memory dir today; this entry is a standing guard for when it does.
export const MEMORY_DIR_EXCLUDES = new Set([
  "D--Repos-Command-Center-Plan",
  "D--Repos-Whetstone",
  "D--Websites-Whetstone",
]);

export const sources = [
  {
    id: "cc-output",
    label: "Command Center — outputs/",
    root: `${CC}/outputs`,
    slugPrefix: "cc-output-",
    type: "reference",
    tags: ["command-center", "outputs"],
    note: "Research, audits, vision docs, the Fable portfolio run, Friday-triage logs, the tooling backlog.",
  },
  {
    id: "cc-reference",
    label: "Command Center — reference/",
    root: `${CC}/reference`,
    slugPrefix: "cc-reference-",
    type: "reference",
    tags: ["command-center", "reference", "process"],
    note: "The change-propagation checklist, data-structure map, Friday-triage runbook, QA protocols.",
  },
  {
    id: "cc-research",
    label: "Command Center — research/",
    root: `${CC}/research`,
    slugPrefix: "cc-research-",
    type: "reference",
    tags: ["command-center", "research"],
  },
  {
    id: "cc-root",
    label: "Command Center — root docs",
    root: CC,
    depth: 1, // root files only; context/decisions/plans are curated in manifest.mjs
    slugPrefix: "cc-root-",
    type: "reference",
    tags: ["command-center", "workspace"],
    note: "HARVEST.md, README.md, shell-aliases.md. CLAUDE.md / status.md / SESSION-SUMMARY.md are curated and dedupe out.",
  },
  {
    id: "project-memory",
    label: "Claude Code memory — all other project dirs",
    memoryScan: CLAUDE_PROJECTS,
    slugPrefix: "mem-",
    type: "reference",
    tags: ["claude-memory", "project-context"],
    note: "67 files across 18 projects (ICUMD, Field-Shader, PSC, REAPER, DrumGen and more) — the context that is least reachable from the laptop or browser, because those machines have no local checkout.",
  },
];
