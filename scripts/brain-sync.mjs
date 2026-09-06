#!/usr/bin/env node
// Open Brain content sync — Command Center Plan 0013
//
// Syncs manifest.mjs entries into the thoughts table by stable sourceSlug
// (delete-then-reinsert), NOT via the MCP capture_thought tool (which only
// accepts free text and auto-extracts metadata — no custom tagging, no safe
// re-sync). This script calls the same building blocks the deployed Edge
// Function calls (upsert_thought RPC + an embedding PATCH) but with full
// control over metadata, using the project's own service-role secret key.
//
// Usage:
//   node scripts/brain-sync.mjs                 sync everything
//   node scripts/brain-sync.mjs --batch=A        sync one batch (A|B|C, by sourceSlug prefix convention below)
//   node scripts/brain-sync.mjs --slug=user-profile   sync a single entry
//   node scripts/brain-sync.mjs --dry-run        compute + embed, print, write nothing
//   node scripts/brain-sync.mjs --verify      manifest completeness + digest drift + coverage report
//   node scripts/brain-sync.mjs --rule=cc-output   sync one sources.mjs rule
//   node scripts/brain-sync.mjs --curated-only     manifest digests only, skip file-backed rules
//   node scripts/brain-sync.mjs --force            re-embed everything, ignoring the unchanged-skip

import { readFileSync, existsSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "../manifest.mjs";
import { sources, GLOBAL_EXCLUDES, MEMORY_DIR_EXCLUDES } from "../sources.mjs";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// Source roots. Hoisted to module scope because both the sync path (to stamp each
// row with its source's mtime) and the verify path (to detect drift) need them.
const COMMAND_CENTER_ROOT = process.env.COMMAND_CENTER_ROOT || "D:/Repos/Command Center Plan";
const MEMORY_ROOT =
  process.env.CLAUDE_MEMORY_ROOT ||
  "C:/Users/ugtwo/.claude/projects/D--Repos-Command-Center-Plan/memory";

// A manifest entry's `path` is relative to Command Center, relative to the memory
// directory, or absolute (the cross-repo CLAUDE.md orientation digests).
function resolveSourcePath(entry) {
  const p = entry.path.replace(/\\/g, "/");
  if (p.startsWith("D:/") || p.startsWith("C:/")) return p;
  if (p.startsWith("memory/")) return join(MEMORY_ROOT, p.slice("memory/".length));
  return join(COMMAND_CENTER_ROOT, p);
}

// The mtime of the file a digest was written from, or null if it is unreadable.
function sourceMtime(entry) {
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
function digestedAtInstant(entry) {
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

function walkFiles(dir, base, out = [], depth = Infinity, level = 0) {
  if (!existsSync(dir)) return out;
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
function expandSources() {
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
      files = walkFiles(root, root, [], rule.depth ?? Infinity).map((full) => ({
        full,
        label: full.slice(root.length + 1),
      }));
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
function materialize(entry) {
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

function contentHash(text) {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function isDigestStale(entry) {
  const mtime = sourceMtime(entry);
  const authored = digestedAtInstant(entry);
  if (!mtime || !authored) return null; // unknowable, not false
  return mtime > authored;
}

function loadEnv() {
  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) {
    console.error(`Missing .env at ${envPath} — need SUPABASE_URL, SUPABASE_SECRET_KEY, OPENROUTER_API_KEY`);
    process.exit(1);
  }
  const lines = readFileSync(envPath, "utf8").split("\n");
  const env = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

const args = process.argv.slice(2);
const flags = {
  batch: (args.find((a) => a.startsWith("--batch=")) || "").split("=")[1],
  slug: (args.find((a) => a.startsWith("--slug=")) || "").split("=")[1],
  rule: (args.find((a) => a.startsWith("--rule=")) || "").split("=")[1],
  dryRun: args.includes("--dry-run"),
  verify: args.includes("--verify"),
  curatedOnly: args.includes("--curated-only"),
  force: args.includes("--force"),
};

const BATCH_PREFIX = { A: "memory-", B: "cc-", C: "repo-" };

async function getEmbedding(text, openrouterKey) {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${openrouterKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "openai/text-embedding-3-small",
      input: text,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter embedding failed (${res.status}): ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  return data.data[0].embedding;
}

// Delete by sourceGroup, not sourceSlug: a chunked file is many rows, and the chunk
// count changes as the file grows or shrinks. Deleting by group removes orphans that
// slug-matching would strand.
async function deleteByGroup(group, env) {
  const url = `${env.SUPABASE_URL}/rest/v1/thoughts?metadata->>sourceGroup=eq.${encodeURIComponent(group)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      Prefer: "return=minimal",
    },
  });
  if (!res.ok && res.status !== 404) {
    const body = await res.text();
    throw new Error(`Delete-by-group failed for ${group} (${res.status}): ${body.slice(0, 300)}`);
  }
}

async function upsertThought(entry, env) {
  // `syncedAt` says when this row was last written; it says NOTHING about whether the
  // digest still reflects its source, because the sync embeds entry.content and never
  // reads the file. Stamping only syncedAt made every row look freshly verified after
  // a scheduled run — which is how four orientation digests sat 56 days stale while
  // the index reported healthy. digestedAt + sourceMtime are the honest pair: if
  // sourceMtime is newer than digestedAt, the prose in the brain is out of date no
  // matter how recently it was synced.
  const mtime = sourceMtime(entry);
  const payload = {
    metadata: {
      sourceSlug: entry.sourceSlug,
      sourceFile: entry.path,
      type: entry.type,
      tags: entry.tags,
      strategy: entry.strategy,
      source: "brain-sync",
      syncedAt: new Date().toISOString(),
      digestedAt: entry.digestedAt || null,
      sourceMtime: mtime ? mtime.toISOString() : null,
      // A file-backed row is read from disk every run, so it cannot drift by
      // construction — false, never null, and never true.
      digestStale: entry.strategy === "file" ? false : isDigestStale(entry),
      sourceGroup: entry.sourceGroup || entry.sourceSlug,
      contentHash: entry.contentHash || null,
      chunk: entry.chunks > 1 ? `${entry.chunk}/${entry.chunks}` : null,
      rule: entry.ruleId || null,
    },
  };
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/upsert_thought`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ p_content: entry.content, p_payload: payload }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`upsert_thought failed for ${entry.sourceSlug} (${res.status}): ${body.slice(0, 300)}`);
  }
  return res.json();
}

async function patchEmbedding(id, embedding, env) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/thoughts?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ embedding }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Embedding patch failed for id ${id} (${res.status}): ${body.slice(0, 300)}`);
  }
}

function selectEntries() {
  // Curated digests first, then everything the sources.mjs rules expand to.
  let entries = [...manifest.map((e) => ({ ...e, ruleId: "curated" })), ...(flags.curatedOnly ? [] : expandSources())];
  if (flags.slug) entries = entries.filter((e) => e.sourceSlug === flags.slug);
  else if (flags.rule) entries = entries.filter((e) => e.ruleId === flags.rule);
  else if (flags.batch) {
    const prefix = BATCH_PREFIX[flags.batch.toUpperCase()];
    if (!prefix) {
      console.error(`Unknown batch "${flags.batch}" — use A, B, or C`);
      process.exit(1);
    }
    entries = entries.filter((e) => e.sourceSlug.startsWith(prefix));
  }
  return entries;
}

// One query for what is already indexed, so an unchanged entry costs nothing.
// Without this the daily task re-embeds every row every night — tolerable at 74
// entries, wasteful at 250+.
async function fetchIndexState(env) {
  const state = new Map(); // sourceGroup -> { hash, seen, ok }

  // PostgREST caps rows per response (the project's max-rows setting, 1000 by default),
  // and it does so SILENTLY — a plain `limit=5000` returns 1000 rows and no warning.
  // Unpaginated, every group past the cap looked absent and was needlessly re-embedded:
  // 209 sources re-synced when 2 had changed. Page explicitly via Range until short.
  const PAGE = 1000;
  for (let offset = 0; ; offset += PAGE) {
    const url =
      `${env.SUPABASE_URL}/rest/v1/thoughts` +
      `?select=metadata&metadata->>sourceSlug=not.is.null&order=id.asc`;
    const res = await fetch(url, {
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
        Range: `${offset}-${offset + PAGE - 1}`,
      },
    });
    if (!res.ok) {
      console.warn(`  (could not read index state: HTTP ${res.status} — syncing everything)`);
      return new Map();
    }
    const rows = await res.json();
    for (const row of rows) {
      const m = row.metadata || {};
      const group = m.sourceGroup || m.sourceSlug;
      if (!group) continue;
      const prev = state.get(group);
      // Only treat a group as unchanged if every one of its chunks carries the same hash.
      if (!prev) state.set(group, { hash: m.contentHash, seen: 1, ok: true });
      else {
        prev.seen++;
        if (prev.hash !== m.contentHash) prev.ok = false;
      }
    }
    if (rows.length < PAGE) break;
  }
  return state;
}

async function runSync() {
  const env = loadEnv();
  const entries = selectEntries();
  const curated = entries.filter((e) => e.ruleId === "curated").length;

  console.log(
    `brain-sync: ${entries.length} source${entries.length === 1 ? "" : "s"} selected ` +
      `(${curated} curated digest${curated === 1 ? "" : "s"}, ${entries.length - curated} file-backed)` +
      `${flags.dryRun ? " — DRY RUN" : ""}`
  );

  const indexState = flags.dryRun || flags.force ? new Map() : await fetchIndexState(env);

  let ok = 0, failed = 0, skipped = 0, rows = 0;
  for (const entry of entries) {
    try {
      // Materialize first: reading and chunking is local and cheap, and the resulting
      // hash is what decides whether the expensive part (embedding) runs at all.
      const parts = materialize(entry);
      const hash = contentHash(parts.map((p) => p.content).join(" "));
      const prior = indexState.get(entry.sourceSlug);

      if (!flags.force && prior?.ok && prior.hash === hash && prior.seen === parts.length) {
        skipped++;
        continue;
      }

      if (flags.dryRun) {
        console.log(`  [dry-run] ${entry.sourceSlug} — ${parts.length} chunk(s), ${parts.reduce((n, p) => n + p.content.length, 0)} chars`);
        ok++;
        rows += parts.length;
        continue;
      }

      await deleteByGroup(entry.sourceSlug, env);
      for (const part of parts) {
        const embedding = await getEmbedding(part.content, env.OPENROUTER_API_KEY);
        const upsertResult = await upsertThought({ ...part, contentHash: hash }, env);
        const id = Array.isArray(upsertResult) ? upsertResult[0]?.id : upsertResult?.id;
        if (!id) throw new Error(`No id returned from upsert_thought for ${part.sourceSlug}`);
        await patchEmbedding(id, embedding, env);
        rows++;
      }
      console.log(`  [synced] ${entry.sourceSlug}${parts.length > 1 ? ` (${parts.length} chunks)` : ""}`);
      ok++;
    } catch (err) {
      console.error(`  [FAILED] ${entry.sourceSlug}: ${err.message}`);
      failed++;
    }
  }

  console.log(
    `\nbrain-sync summary: ${ok} ok, ${failed} failed, ${skipped} unchanged (skipped), ` +
      `${entries.length} total — ${rows} row(s) written.`
  );
  if (failed > 0) process.exitCode = 1;
}

function walkMarkdown(dir, base = dir, results = []) {
  if (!existsSync(dir)) return results;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      if (name === "html" || name.startsWith(".")) continue;
      walkMarkdown(full, base, results);
    } else if (name.endsWith(".md")) {
      results.push(full.slice(base.length + 1).replace(/\\/g, "/"));
    }
  }
  return results;
}

function runVerify() {
  // Scope: Command Center's own context/plans/decisions dirs + the Claude Code memory dir.
  const commandCenterRoot = COMMAND_CENTER_ROOT;
  const memoryRoot = MEMORY_ROOT;

  const manifestPaths = new Set(manifest.map((e) => e.path.replace(/\\/g, "/")));

  // UNLISTED means "indexed by nothing" — not "absent from manifest.mjs". A file covered
  // by a sources.mjs rule is indexed, just without an authored digest, so reporting it
  // would be a false positive that trains the reader to skim past real findings.
  const ruleCoveredPaths = new Set(
    expandSources().map((e) => e.path.replace(/\\/g, "/").toLowerCase())
  );
  const isCovered = (relPath, absPath) =>
    manifestPaths.has(relPath) || ruleCoveredPaths.has(absPath.replace(/\\/g, "/").toLowerCase());

  const scopeDirs = [
    { label: "context/", dir: join(commandCenterRoot, "context") },
    { label: "decisions/", dir: join(commandCenterRoot, "decisions") },
    { label: "plans/", dir: join(commandCenterRoot, "plans") },
  ];

  console.log("brain-sync --verify\n");

  let missing = 0;
  for (const { label, dir } of scopeDirs) {
    for (const rel of walkMarkdown(dir)) {
      const f = `${label}${rel}`;
      if (!isCovered(f, join(dir, rel))) {
        console.log(`  UNLISTED: ${f} — on disk, indexed by neither manifest.mjs nor a sources.mjs rule`);
        missing++;
      }
    }
  }

  // memory/ is a flat dir with a special-cased index file (MEMORY.md) that is
  // NOT a migration source — it's the index, not a memory itself.
  if (existsSync(memoryRoot)) {
    for (const name of readdirSync(memoryRoot)) {
      if (name === "MEMORY.md" || !name.endsWith(".md")) continue;
      const relPath = `memory/${name}`;
      if (!isCovered(relPath, join(memoryRoot, name))) {
        console.log(`  UNLISTED: ${relPath} — on disk, indexed by neither manifest.mjs nor a sources.mjs rule`);
        missing++;
      }
    }
  }

  // Reverse check: manifest entries whose source file no longer exists (stale entries)
  let stale = 0;
  for (const entry of manifest) {
    if (entry.path.startsWith("D:/")) continue; // cross-repo orientation digests — not a 1:1 file check
    let full;
    if (entry.path.startsWith("memory/")) full = join(memoryRoot, entry.path.slice("memory/".length));
    else full = join(commandCenterRoot, entry.path);
    if (!existsSync(full)) {
      console.log(`  STALE: manifest entry "${entry.sourceSlug}" points at ${entry.path}, which no longer exists`);
      stale++;
    }
  }

  // Digest drift: the source file changed after its digest prose was written.
  //
  // This is the check the tool was missing for its whole life. brain-sync embeds
  // entry.content — a hand-authored digest — and never opens the source file, so
  // editing a source changes nothing about what is in the brain. A daily sync keeps
  // the database matching the MANIFEST; only this check keeps the manifest honest
  // against GIT. Found 12 drifted entries on 2026-08-27, four of them 56 days stale
  // and all four being the orientation docs a session reads first.
  let drifted = 0;
  const noStamp = [];
  for (const entry of manifest) {
    const mtime = sourceMtime(entry);
    if (!mtime) continue; // missing files are already reported as STALE above
    if (!entry.digestedAt) {
      noStamp.push(entry.sourceSlug);
      continue;
    }
    const authored = digestedAtInstant(entry);
    if (mtime > authored) {
      const days = Math.round((mtime - authored) / 86400000);
      console.log(
        `  DIGEST DRIFT (${String(days).padStart(3)}d): ${entry.sourceSlug} — ` +
          `${entry.path} edited ${mtime.toISOString().slice(0, 10)}, digest written ${entry.digestedAt}`
      );
      drifted++;
    }
  }
  if (noStamp.length) {
    console.log(`\n  ${noStamp.length} entr${noStamp.length === 1 ? "y has" : "ies have"} no digestedAt stamp — drift cannot be checked for: ${noStamp.join(", ")}`);
  }

  console.log(
    `\nverify summary: ${missing} unlisted file(s), ${stale} stale manifest entr${stale === 1 ? "y" : "ies"}, ${drifted} drifted digest(s).`
  );
  if (missing === 0 && stale === 0 && drifted === 0) {
    console.log("Manifest is complete and every digest is at least as new as its source.");
  }
  if (drifted > 0) {
    console.log(
      "\nA drifted digest means the brain is serving prose written before the source changed.\n" +
        "Re-running the sync will NOT fix it — rewrite the entry's `content` in manifest.mjs,\n" +
        "bump its `digestedAt`, then sync."
    );
  }

  // Report what the file-backed rules cover, and then say plainly what nothing covers.
  // A clean run must never be readable as "everything is indexed".
  const expanded = expandSources();
  const byRule = {};
  for (const e of expanded) byRule[e.ruleId] = (byRule[e.ruleId] || 0) + 1;

  console.log(`\nFile-backed coverage (sources.mjs — read from disk, cannot drift):`);
  for (const rule of sources) {
    const n = byRule[rule.id] || 0;
    console.log(`  ${String(n).padStart(4)}  ${rule.id.padEnd(16)} ${rule.label}`);
  }
  console.log(`  ${String(expanded.length).padStart(4)}  total, plus ${manifest.length} curated digests`);

  console.log(
    `\nStill NOT indexed, by decision:\n` +
      `  - Whetstone — permanently excluded (ADR 0007); guarded in MEMORY_DIR_EXCLUDES.\n` +
      `  - A client's customers' data — the hard NZ Privacy Act / IPP12 boundary.\n` +
      `  - Dormant repos (GlenTools, TradeApp, WillitsProto, Democratic Workshop) — add a rule if one reactivates.\n` +
      `  - Non-markdown (.html vision docs, proposals, PDFs, images) — the sync reads .md only.\n` +
      `  - Vendored/generated trees (node_modules, .venv, worktrees, dist) — not authored content.`
  );
}

if (flags.verify) {
  runVerify();
} else {
  runSync();
}
