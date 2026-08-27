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
//   node scripts/brain-sync.mjs --verify         diff manifest paths against files actually on disk in scope dirs

import { readFileSync, existsSync } from "node:fs";
import { readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "../manifest.mjs";

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
  dryRun: args.includes("--dry-run"),
  verify: args.includes("--verify"),
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

async function deleteBySlug(slug, env) {
  const url = `${env.SUPABASE_URL}/rest/v1/thoughts?metadata->>sourceSlug=eq.${encodeURIComponent(slug)}`;
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
    throw new Error(`Delete-by-slug failed for ${slug} (${res.status}): ${body.slice(0, 300)}`);
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
      digestStale: isDigestStale(entry),
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
  let entries = manifest;
  if (flags.slug) entries = entries.filter((e) => e.sourceSlug === flags.slug);
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

async function runSync() {
  const env = loadEnv();
  const entries = selectEntries();
  console.log(`brain-sync: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} selected${flags.dryRun ? " (DRY RUN)" : ""}`);

  let ok = 0, failed = 0;
  for (const entry of entries) {
    try {
      const preview = entry.content.slice(0, 90).replace(/\s+/g, " ");
      if (flags.dryRun) {
        // still hit the embedding API in dry-run so cost/latency is visible, but no Supabase writes
        await getEmbedding(entry.content, env.OPENROUTER_API_KEY);
        console.log(`  [dry-run OK] ${entry.sourceSlug} — "${preview}..."`);
        ok++;
        continue;
      }
      await deleteBySlug(entry.sourceSlug, env);
      const embedding = await getEmbedding(entry.content, env.OPENROUTER_API_KEY);
      const upsertResult = await upsertThought(entry, env);
      const id = Array.isArray(upsertResult) ? upsertResult[0]?.id : upsertResult?.id;
      if (!id) throw new Error(`No id returned from upsert_thought for ${entry.sourceSlug}`);
      await patchEmbedding(id, embedding, env);
      console.log(`  [synced] ${entry.sourceSlug} (id=${id})`);
      ok++;
    } catch (err) {
      console.error(`  [FAILED] ${entry.sourceSlug}: ${err.message}`);
      failed++;
    }
  }
  console.log(`\nbrain-sync summary: ${ok} ok, ${failed} failed, ${entries.length} total.`);
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

  const scopeDirs = [
    { label: "context/", dir: join(commandCenterRoot, "context") },
    { label: "decisions/", dir: join(commandCenterRoot, "decisions") },
    { label: "plans/", dir: join(commandCenterRoot, "plans") },
  ];

  console.log("brain-sync --verify\n");

  let missing = 0;
  for (const { label, dir } of scopeDirs) {
    const files = walkMarkdown(dir).map((f) => `${label}${f}`);
    for (const f of files) {
      if (!manifestPaths.has(f)) {
        console.log(`  UNLISTED: ${f} — on disk, not in manifest.mjs`);
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
      if (!manifestPaths.has(relPath)) {
        console.log(`  UNLISTED: ${relPath} — on disk, not in manifest.mjs`);
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

  // Say plainly what this check does not look at, so a clean run is not read as
  // "everything is indexed". These directories hold real content that is deliberately
  // (or accidentally) out of scope; silence about them reads as coverage.
  const unscanned = ["outputs", "reference", "research"]
    .map((d) => ({ d, n: walkMarkdown(join(commandCenterRoot, d)).length }))
    .filter((x) => x.n > 0);
  if (unscanned.length) {
    console.log(
      `\nNot examined by this check: ${unscanned.map((x) => `${x.d}/ (${x.n} .md)`).join(", ")}` +
        `, Command Center root files, and every Claude Code memory directory except\n` +
        `${memoryRoot}. Coverage there is a scope decision, not something this command verifies.`
    );
  }
}

if (flags.verify) {
  runVerify();
} else {
  runSync();
}
