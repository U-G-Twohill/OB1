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
  const payload = {
    metadata: {
      sourceSlug: entry.sourceSlug,
      sourceFile: entry.path,
      type: entry.type,
      tags: entry.tags,
      strategy: entry.strategy,
      source: "brain-sync",
      syncedAt: new Date().toISOString(),
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
  // This only checks the two directories this repo can see paths into cleanly; the
  // Command Center + memory roots are read via an absolute path override below.
  const commandCenterRoot = process.env.COMMAND_CENTER_ROOT || "D:/Repos/Command Center Plan";
  const memoryRoot = process.env.CLAUDE_MEMORY_ROOT ||
    "C:/Users/ugtwo/.claude/projects/D--Repos-Command-Center-Plan/memory";

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

  console.log(`\nverify summary: ${missing} unlisted file(s), ${stale} stale manifest entr${stale === 1 ? "y" : "ies"}.`);
  if (missing === 0 && stale === 0) console.log("Manifest is complete against scope directories.");
}

if (flags.verify) {
  runVerify();
} else {
  runSync();
}
