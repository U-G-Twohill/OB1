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
//   node scripts/brain-sync.mjs --verify      manifest completeness + digest drift + database parity + coverage report
//   node scripts/brain-sync.mjs --rule=cc-output   sync one sources.mjs rule
//   node scripts/brain-sync.mjs --curated-only     manifest digests only, skip file-backed rules
//   node scripts/brain-sync.mjs --force            re-embed everything, ignoring the unchanged-skip
//   node scripts/brain-sync.mjs --prune-limit=200  allow a reviewed cleanup of more than 50 orphaned sources


import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { manifest } from "../manifest.mjs";
import { sources } from "../sources.mjs";
import {
  COMMAND_CENTER_ROOT, MEMORY_ROOT, sourceMtime, digestedAtInstant, isDigestStale,
  expandSources, materialize, contentHash, curatedEntries,
} from "./lib/entries.mjs";

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
      // construction. A superseded digest is also served from disk, but its digest
      // really is stale, so it stays true to keep the re-authoring queue queryable.
      digestStale: entry.strategy === "file" && !entry.digestSuperseded ? false : isDigestStale(entry),
      digestSuperseded: Boolean(entry.digestSuperseded),
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
  let entries = [...curatedEntries(), ...(flags.curatedOnly ? [] : expandSources())];
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
  const state = new Map(); // sourceGroup -> { hash, seen, ok, rule, file }

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
      if (!prev) state.set(group, { hash: m.contentHash, seen: 1, ok: true, rule: m.rule, file: m.sourceFile });
      else {
        prev.seen++;
        if (prev.hash !== m.contentHash) prev.ok = false;
      }
    }
    if (rows.length < PAGE) break;
  }
  return state;
}

// Remove rows whose source is no longer in scope: a deleted or renamed file, a dropped
// manifest entry, a new exclude, or a folder that graduated to its own repo. Until
// 2026-11-10 the sync never did this, so every one of those left a stale copy in search
// until someone deleted it by hand.
//
// Two guards, because a wrong delete loses rows that only a full re-embed restores:
//   1. A rule whose root folder is missing (a repo moved, a drive not mounted) keeps its
//      rows. Its files vanished from the scan, but they were not taken out of scope.
//   2. More than MAX_PRUNE orphaned sources at once prunes nothing. That many at once
//      looks like a mistake, not housekeeping. After reviewing them with --verify, run the
//      sync once with --prune-limit=N to allow a deliberate larger cleanup.
const MAX_PRUNE = Number((args.find((a) => a.startsWith("--prune-limit=")) || "=50").split("=")[1]);

async function pruneOrphans(indexState, entries, env) {
  const inScope = new Set(entries.map((e) => e.sourceSlug));
  const roots = new Map(sources.map((r) => [r.id, r.root ?? r.memoryScan]));
  const orphans = [];
  for (const [group, info] of indexState) {
    if (inScope.has(group)) continue;
    const root = roots.get(info.rule);
    if (root && !existsSync(root)) {
      console.log(`  [kept] ${group} — its rule's root ${root} is missing, so it was not pruned`);
      continue;
    }
    orphans.push([group, info]);
  }
  if (orphans.length > MAX_PRUNE) {
    console.log(
      `
${orphans.length} orphaned sources found, over the limit of ${MAX_PRUNE}: none pruned. ` +
        `Review them with --verify, then run once with --prune-limit=${orphans.length} if they should go.`
    );
    return 0;
  }
  let pruned = 0;
  for (const [group, info] of orphans) {
    try {
      await deleteByGroup(group, env);
      console.log(`  [pruned] ${group} (${info.seen} row(s)) — ${info.file ?? "no source file recorded"}`);
      pruned++;
    } catch (err) {
      console.error(`  [FAILED] prune ${group}: ${err.message}`);
    }
  }
  return pruned;
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
      const hash = contentHash(parts.map((p) => p.content).join("\u0000"));
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
  // Only a full run knows the whole scope; a --rule or --slug run would see everything
  // else as orphaned.
  const fullRun = !flags.slug && !flags.rule && !flags.batch && !flags.curatedOnly;
  if (fullRun && !flags.dryRun && indexState.size > 0) {
    const pruned = await pruneOrphans(indexState, entries, env);
    if (pruned > 0) console.log(`${pruned} orphaned source(s) removed.`);
  }
  const superseded = entries.filter((e) => e.digestSuperseded).length;
  if (superseded > 0) console.log(`${superseded} drifted digest(s) served from their source file.`);
  if (failed > 0) process.exitCode = 1;
}

// Does the database match what a sync would write right now?
//
// Compares content, not contentHash: editing a row through update_thought changes its
// content and leaves its contentHash alone, so a hash comparison cannot see that. It
// downloads every synced row's text, which is why --verify does this and the scheduled
// sync does not.
async function checkDatabaseParity() {
  const env = loadEnv();
  const rows = [];
  const PAGE = 1000;
  try {
    for (let offset = 0; ; offset += PAGE) {
      const res = await fetch(
        `${env.SUPABASE_URL}/rest/v1/thoughts?select=content,metadata&metadata->>sourceSlug=not.is.null&order=id.asc`,
        {
          headers: {
            apikey: env.SUPABASE_SECRET_KEY,
            Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
            Range: `${offset}-${offset + PAGE - 1}`,
          },
        }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const page = await res.json();
      rows.push(...page);
      if (page.length < PAGE) break;
    }
  } catch (err) {
    console.log(`\nDatabase parity: NOT CHECKED — could not read the database (${err.message}).`);
    return;
  }

  const expected = new Map();
  const groups = new Set();
  for (const entry of [...curatedEntries(), ...expandSources()]) {
    groups.add(entry.sourceSlug);
    try {
      for (const part of materialize(entry)) expected.set(part.sourceSlug, part.content);
    } catch (err) {
      console.log(`  UNREADABLE: ${entry.sourceSlug} — ${err.message}`);
    }
  }

  const seen = new Set();
  const drift = [];
  const extra = [];
  const orphanGroups = new Map();
  let newestSync = "";
  for (const { content, metadata: m } of rows) {
    if (m.syncedAt > newestSync) newestSync = m.syncedAt;
    const group = m.sourceGroup || m.sourceSlug;
    if (!groups.has(group)) {
      const orphan = orphanGroups.get(group) || { rows: 0, file: m.sourceFile };
      orphan.rows++;
      orphanGroups.set(group, orphan);
    } else if (!expected.has(m.sourceSlug)) {
      extra.push(m.sourceSlug);
    } else {
      seen.add(m.sourceSlug);
      if (expected.get(m.sourceSlug) !== content) drift.push(m.sourceSlug);
    }
  }
  const missing = [...expected.keys()].filter((slug) => !seen.has(slug));

  const report = (label, items) => {
    for (const item of items.slice(0, 25)) console.log(`  ${label}: ${item}`);
    if (items.length > 25) console.log(`  ... and ${items.length - 25} more ${label}`);
  };
  console.log("");
  report("DB DRIFT", drift);
  report("DB MISSING", missing);
  report("DB EXTRA CHUNK", extra);
  report("DB ORPHAN", [...orphanGroups].map(([g, o]) => `${g} (${o.rows} row(s)) — ${o.file}`));
  console.log(
    `Database parity: ${rows.length} synced row(s) checked against ${expected.size} expected — ` +
      `${drift.length} differ, ${missing.length} missing, ${extra.length} extra, ` +
      `${orphanGroups.size} orphaned source(s). Newest write: ${newestSync || "none"}.`
  );
  if (drift.length || missing.length || extra.length) {
    console.log("Differences mean the next sync has work to do, or a row was edited outside the sync.");
  }
  if (orphanGroups.size) {
    console.log("Orphans are rows whose source is no longer in scope. A full sync removes them (up to 50 at once).");
  }
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

async function runVerify() {
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
      "\nA drifted digest is older than its source, so the sync serves the source file in its\n" +
        "place. To restore the digest, rewrite the entry's `content` in manifest.mjs, bump its\n" +
        "`digestedAt`, then sync."
    );
  }

  await checkDatabaseParity();

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
  await runVerify();
} else {
  runSync();
}
