#!/usr/bin/env node
// Open Brain keep-warm ping — last line of defence against free-tier auto-pause.
//
// Supabase pauses free-tier projects after ~7 days of inactivity. The scheduled
// sync (scripts/scheduled-sync.mjs) already generates activity as a side effect of
// doing real work, so this ping exists for the case where the sync itself is broken
// — a bad manifest entry, an expired OpenRouter key, a moved source repo. Those
// failures stop the sync running but say nothing to Supabase, and the project
// quietly pauses a week later. That is exactly how the 2026-07-03 to 2026-08-27 gap
// happened.
//
// So this script deliberately shares as little as possible with the sync path:
// no manifest import, no OpenRouter call, no write. One authenticated read.
// If the sync is broken, this still runs; if this is broken, it is loud.
//
// Usage:
//   node scripts/keep-warm.mjs           ping, log the result
//   node scripts/keep-warm.mjs --quiet   log only, no stdout (for scheduled runs)

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const LOG_DIR = join(REPO_ROOT, "logs");
const LOG_FILE = join(LOG_DIR, "keep-warm.log");

const quiet = process.argv.includes("--quiet");

function log(line) {
  const stamped = `${new Date().toISOString()}  ${line}`;
  if (!quiet) console.log(stamped);
  try {
    if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(LOG_FILE, stamped + "\n");
  } catch {
    // A failed log write must not mask the ping result — the exit code is what matters.
  }
}

function loadEnv() {
  const envPath = join(REPO_ROOT, ".env");
  if (!existsSync(envPath)) throw new Error(`Missing .env at ${envPath}`);
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) {
    throw new Error(".env is missing SUPABASE_URL or SUPABASE_SECRET_KEY");
  }
  return env;
}

async function main() {
  const env = loadEnv();
  const started = Date.now();

  // Cheapest possible authenticated read that still touches Postgres: one id, one row.
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/thoughts?select=id&limit=1`, {
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
    },
    signal: AbortSignal.timeout(30_000),
  });

  const ms = Date.now() - started;

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} in ${ms}ms — ${body.slice(0, 200)}`);
  }

  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    // Reachable but empty is not a healthy brain — surface it rather than pass.
    throw new Error(`reachable in ${ms}ms but returned no rows — the thoughts table looks empty`);
  }

  log(`OK    project awake, responded in ${ms}ms`);
}

main().catch((err) => {
  log(`FAIL  ${err.message}`);
  process.exitCode = 1;
});
