// Source expansion and materialisation, shared by brain-sync.mjs and brain-report.mjs.
// Moved here unchanged from brain-sync.mjs so the report computes exactly what a sync
// would write, instead of re-implementing it and drifting from it.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { manifest } from "../../manifest.mjs";
import { sources, GLOBAL_EXCLUDES, MEMORY_DIR_EXCLUDES } from "../../sources.mjs";

// Source roots. Hoisted to module scope because both the sync path (to stamp each
// row with its source's mtime) and the verify path (to detect drift) need them.
export const COMMAND_CENTER_ROOT = process.env.COMMAND_CENTER_ROOT || "D:/Repos/Command Center Plan";
export const MEMORY_ROOT =
  process.env.CLAUDE_MEMORY_ROOT ||
  "C:/Users/ugtwo/.claude/projects/D--Repos-Command-Center-Plan/memory";

// A manifest entry's `path` is relative to Command Center, relative to the memory
// directory, or absolute (the cross-repo CLAUDE.md orientation digests).
export function resolveSourcePath(entry) {
  const p = entry.path.replace(/\\/g, "/");
  if (p.startsWith("D:/") || p.startsWith("C:/")) return p;
  if (p.startsWith("memory/")) return join(MEMORY_ROOT, p.slice("memory/".length));
  return join(COMMAND_CENTER_ROOT, p);
}

// The mtime of the file a digest was written from, or null if it is unreadable.
export function sourceMtime(entry) {
  try {
    return statSync(resolveSourcePath(entry)).mtime;
  } catch {
    return null;
  }
}

// When a digest's prose was authored, as a comparable instant.
//
// Two accepted forms, deliberately. A bare "YYYY-MM-DD" is what a human types and is
// read as END of that day — lenient, so it cannot cry wolf, but it therefore cannot
// see a same-day edit. A full ISO timestamp is exact. Prefer the timestamp when a
// tool writes the stamp; a same-day edit is not hypothetical, one happened on
// 2026-08-27 when a concurrent session committed to Command Center mid-sync.
export function digestedAtInstant(entry) {
  if (!entry.digestedAt) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(entry.digestedAt)
    ? new Date(`${entry.digestedAt}T23:59:59.999Z`)
    : new Date(entry.digestedAt);
}

// ---------------------------------------------------------------------------
// File-backed sources (sources.mjs) — expanded at scan time, read from disk.
// ---------------------------------------------------------------------------

// text-embedding-3-small accepts 8191 tokens. Markdown with tables and code runs
// denser than prose, so budget conservatively at ~3k tokens per chunk and overlap a
// little so a paragraph split across a boundary is still findable from either side.
const CHUNK_CHARS = 12000;
const CHUNK_OVERLAP = 400;

function slugify(s) {
  return s
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
}

function excluded(fullPath) {
  const p = fullPath.replace(/\\/g, "/");
  return GLOBAL_EXCLUDES.some((re) => re.test(p));
}

// JS strings are UTF-16, so slicing at an arbitrary index can cut an astral character
// (any emoji) in half and leave a lone surrogate. JSON.stringify emits it happily, but
// it is invalid JSON and PostgREST rejects the whole request with PGRST102 "Empty or
// invalid json". A 🔸 in a PSC legal doc is exactly how this was found.
function safeBoundary(text, idx) {
  const c = text.charCodeAt(idx - 1);
  return c >= 0xd800 && c <= 0xdbff ? idx - 1 : idx; // don't end on a high surrogate
}

// Last line of defence for anything Postgres will refuse to store as text.
// Two distinct hazards, both found the same way — by a nightly sync failing:
//
//   1. Unpaired surrogates, produced by slicing a chunk mid-astral-character.
//      A 🔸 in a PSC legal doc is how that one was found.
//   2. NUL (U+0000). Postgres rejects it outright — `22P05: unsupported
//      Unicode escape sequence` — and unlike a lone surrogate it is present in
//      the SOURCE FILE, not introduced by chunking. Found 2026-09-07: three
//      Field-Shader verify outputs each carry one NUL, because WebGL's
//      getShaderInfoLog() returns a NUL-TERMINATED string and the harness wrote
//      it into the report verbatim. That failed the scheduled sync every night
//      from 2026-08-31 to 2026-09-06 with nothing surfacing it.
//
// Strip rather than reject: one bad byte in a 40 KB report should cost the byte,
// not the document. Both return paths of chunkText() pass through here, so this
// is the single choke point.
function stripLoneSurrogates(s) {
  return s
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/\u0000/g, "");
}

// Split on paragraph boundaries where possible so chunks stay semantically whole.
function chunkText(text) {
  if (text.length <= CHUNK_CHARS) return [stripLoneSurrogates(text)];
  const chunks = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + CHUNK_CHARS, text.length);
    if (end < text.length) {
      const window = text.slice(i, end);
      const br = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n## "));
      if (br > CHUNK_CHARS * 0.5) end = i + br;
      end = safeBoundary(text, end);
    }
    chunks.push(stripLoneSurrogates(text.slice(i, end).trim()));
    if (end >= text.length) break;
    i = safeBoundary(text, Math.max(end - CHUNK_OVERLAP, i + 1));
  }
  return chunks.filter((c) => c.length > 0);
}

// A folder holding this file has graduated: its project moved to its own repo, which is now
// the current copy, and this folder is kept as history. Skipping it keeps the brain to one
// current version of each document. The workflow is Command Center reference/graduation.md.
export const GRADUATED_MARKER = "GRADUATED.md";

export function walkFiles(dir, base, out = [], depth = Infinity, level = 0) {
  if (!existsSync(dir)) return out;
  if (existsSync(join(dir, GRADUATED_MARKER))) return out;
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const full = join(dir, name);
    if (excluded(full)) continue;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      if (name.startsWith(".") || level + 1 >= depth) continue;
      walkFiles(full, base, out, depth, level + 1);
    } else if (name.endsWith(".md")) {
      out.push(full.replace(/\\/g, "/"));
    }
  }
  return out;
}

// Expand every rule in sources.mjs into concrete file entries, minus anything a
// curated manifest entry already covers (curated prose wins — it is better retrieval).
export function expandSources() {
  const curatedPaths = new Set(manifest.map((e) => resolveSourcePath(e).replace(/\\/g, "/").toLowerCase()));
  const entries = [];
  const seen = new Set();

  for (const rule of sources) {
    let files = [];
    if (rule.memoryScan) {
      if (!existsSync(rule.memoryScan)) continue;
      for (const proj of readdirSync(rule.memoryScan)) {
        if (MEMORY_DIR_EXCLUDES.has(proj)) continue;
        const memDir = join(rule.memoryScan, proj, "memory");
        if (!existsSync(memDir)) continue;
        for (const f of walkFiles(memDir, memDir, [], 1)) {
          if (f.endsWith("/MEMORY.md")) continue; // the index, not a memory
          files.push({ full: f, label: `${proj}/${f.split("/").pop()}` });
        }
      }
    } else {
      const root = rule.root.replace(/\\/g, "/");
      files = walkFiles(root, root, [], rule.depth ?? Infinity)
        .map((full) => ({ full, label: full.slice(root.length + 1) }))
        // A rule's own excludes match the path relative to its root.
        .filter(({ label }) => !(rule.exclude ?? []).some((re) => re.test(label)));
    }

    for (const { full, label } of files) {
      if (curatedPaths.has(full.toLowerCase())) continue; // curated entry wins
      const slug = rule.slugPrefix + slugify(label);
      if (seen.has(slug)) continue;
      seen.add(slug);
      entries.push({
        sourceSlug: slug,
        path: full,
        type: rule.type,
        tags: rule.tags,
        strategy: "file",
        ruleId: rule.id,
      });
    }
  }
  return entries;
}

// Read a file-backed entry and turn it into one row per chunk. Chunks share a
// sourceGroup so re-sync can delete the whole set even when the chunk count changes.
export function materialize(entry) {
  if (entry.strategy !== "file") {
    return [{ ...entry, sourceGroup: entry.sourceSlug, content: entry.content, chunk: 1, chunks: 1 }];
  }
  const raw = readFileSync(entry.path, "utf8");
  const rel = entry.path.split("/").slice(-2).join("/");
  const parts = chunkText(raw);
  return parts.map((text, i) => ({
    ...entry,
    sourceGroup: entry.sourceSlug,
    sourceSlug: parts.length === 1 ? entry.sourceSlug : `${entry.sourceSlug}#${i + 1}`,
    chunk: i + 1,
    chunks: parts.length,
    // A header so a retrieved chunk can say what it is and where it came from —
    // without it, chunk 7 of a research doc arrives as context-free prose.
    content:
      parts.length === 1
        ? `Source: ${rel}\n\n${text}`
        : `Source: ${rel} (part ${i + 1} of ${parts.length})\n\n${text}`,
  }));
}

export function contentHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function isDigestStale(entry) {
  const mtime = sourceMtime(entry);
  const authored = digestedAtInstant(entry);
  if (!mtime || !authored) return null; // unknowable, not false
  return mtime > authored;
}

// A digest older than its source is a claim the source has since moved past, so serve
// the source itself until someone re-authors the digest. --verify reported this drift
// for months and nothing acted on it: 12 of 74 digests had drifted again by 2026-11-07,
// the strategy digest among them, 75 days behind. Bumping digestedAt restores the digest.
function withDigestFallback(entry) {
  if (!isDigestStale(entry)) return entry;
  const path = resolveSourcePath(entry).replace(/\\/g, "/");
  try {
    if (!statSync(path).isFile()) return entry;
  } catch {
    return entry;
  }
  return { ...entry, path, strategy: "file", digestSuperseded: true };
}

export function curatedEntries() {
  return manifest.map((e) => withDigestFallback({ ...e, ruleId: "curated" }));
}
