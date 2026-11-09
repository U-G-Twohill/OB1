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
// A file matched by BOTH is left to the curated entry — the sync dedupes on path. If that
// entry's digest is older than its source, the sync serves the source file instead until
// the digest is re-authored (see withDigestFallback in scripts/brain-sync.mjs).
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
  /[\\/]build[\\/]/,
  /[\\/]__pycache__[\\/]/,
  // Python virtualenvs. Nelson BI's .venv holds a single 5.75 MB ATTRIBUTION.md —
  // 93% of that repo's markdown by weight, and none of it is Uriah's.
  /[\\/]\.venv[\\/]/,
  /[\\/]venv[\\/]/,
  /[\\/]site-packages[\\/]/,
  // Stale agent worktrees. Ben's Trees carries 531 .md inside .claude/worktrees —
  // three full checkouts left by March agent sessions. Indexing them would triple-
  // count that repo and surface superseded copies as if they were current.
  /[\\/]\.claude[\\/]worktrees[\\/]/,
  /[\\/]worktrees[\\/]/,
  /[\\/]\.next[\\/]/,
  /[\\/]vendor[\\/]/,
];

// Claude Code memory directories that must NOT be indexed, by project-dir name.
//
// Whetstone is excluded by decision (ADR 0007): it holds unfiltered personal political
// reasoning and must never surface into a session working on client work. It has no
// memory directory today — these are standing guards for when it gets one.
//
// Command Center's memory dir is deliberately NOT excluded, even though its 33 files
// have curated digests. The rule scans it too and the path-dedupe leaves those 33 to
// their digests, so the only thing the rule actually picks up is a NEW memory file
// nobody has written an entry for yet. That gap is not hypothetical: a concurrent
// session added `project_wordpress_local_dev_want.md` during this very sync, and
// --verify flagged it as UNLISTED. Covering it by rule means a new memory is indexed
// the moment it exists, and can be promoted to a curated digest later if it earns one.
export const MEMORY_DIR_EXCLUDES = new Set([
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
    depth: 1, // root files only; context/decisions/plans have their own rules below
    slugPrefix: "cc-root-",
    type: "reference",
    tags: ["command-center", "workspace"],
    note: "HARVEST.md, README.md, shell-aliases.md. CLAUDE.md / status.md / SESSION-SUMMARY.md are curated and dedupe out.",
  },
  // Plans, ADRs and context used to need a hand-written manifest entry each, and that
  // step stopped happening: by 2026-11-07, plans 0019-0031 and ADRs 0009-0010 were
  // unindexed. These rules pick up whatever has no curated entry, so a new file is
  // indexed on the next run. Slug prefixes differ from the curated cc-plan-* and
  // cc-decision-* conventions so the two can never collide.
  {
    id: "cc-context",
    label: "Command Center — context/",
    root: `${CC}/context`,
    slugPrefix: "cc-context-file-",
    type: "reference",
    tags: ["command-center", "context"],
  },
  {
    id: "cc-decisions",
    label: "Command Center — decisions/",
    root: `${CC}/decisions`,
    slugPrefix: "cc-decisions-",
    type: "decision",
    tags: ["command-center", "decision"],
  },
  {
    id: "cc-plans",
    label: "Command Center — plans/",
    root: `${CC}/plans`,
    slugPrefix: "cc-plans-",
    type: "status",
    tags: ["command-center", "plan"],
  },
  // --- Project repos ------------------------------------------------------
  //
  // Added 2026-08-27. Until then only each repo's CLAUDE.md was digested, so the
  // actual work — plans, STATE docs, harvest logs, design notes — was invisible from
  // the laptop and from claude.ai, which is precisely where it is needed, because
  // neither has a local checkout.
  //
  // Client repos were deferred in the original migration on two stated conditions:
  // that the sync tool had a track record, and that each repo's state had settled.
  // Both now hold. A privacy scan across all three (2026-08-27) found no live keys,
  // no customer records, and no third-party personal data — the only email address
  // in PSC's markdown is Uriah's own, and every `attendee` / `INSERT INTO` match was
  // a feature description ("Attendees — CSV + print door list"), not data. That is
  // the playbook's rule holding: describe the process, never the data.
  //
  // If a repo ever starts holding real customer records in markdown, remove it here.
  ...[
    { key: "psc", dir: "D:/Websites/Public Service Center", tags: ["psc", "client", "ticketing"] },
    { key: "bens-trees", dir: "D:/Websites/Ben's Trees", tags: ["bens-trees", "client"] },
    { key: "icumd", dir: "D:/Websites/ICUMD Clone Designer", tags: ["icumd", "portfolio", "track-a"] },
    { key: "field-shader", dir: "D:/Repos/Field-Shader", tags: ["field-shader", "webgl", "shader"] },
    { key: "tweaker", dir: "D:/Repos/Tweaker", tags: ["tweaker", "front-end", "tooling"] },
    { key: "nelson-bi", dir: "D:/Repos/Nelson BI", tags: ["nelson-bi", "data", "lead-pipeline"] },
    { key: "icu-tools", dir: "D:/Repos/icu-tools", tags: ["icu-tools", "delivery-suite"] },
    { key: "project-hub", dir: "D:/Repos/Integrations and Project Management", tags: ["project-hub", "agency"] },
    { key: "glenstoolkit", dir: "D:/Repos/GlensToolkit", tags: ["glenstoolkit", "toolkit"] },
    { key: "vps-infra", dir: "D:/Repos/vps-infra", tags: ["vps-infra", "hosting"] },
    { key: "permissible-lab", dir: "D:/Repos/permissible-lab", tags: ["permissible-lab", "audio", "dsp"] },
    { key: "drumgen", dir: "D:/Repos/DrumGen", tags: ["drumgen", "audio", "midi"] },
  ].map((r) => ({
    id: `repo-${r.key}`,
    label: `Repo — ${r.dir.split("/").pop()}`,
    root: r.dir,
    slugPrefix: `r-${r.key}-`,
    type: "reference",
    tags: ["repo-content", ...r.tags],
  })),

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
