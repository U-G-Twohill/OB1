#!/usr/bin/env node
// Scheduled wrapper around brain-sync.mjs — the primary defence against a stale index.
//
// Runs the full sync unattended and records what happened. The maintenance playbook
// used to forbid automating this on the grounds that sync should stay a deliberate,
// visible action. That rule was reversed on 2026-08-27 after the index sat ~8 weeks
// behind git and nothing surfaced it: a deliberate action nobody performs is not a
// safeguard. The revised rule is narrower and better — silent when it works, loud
// when it does not.
//
// "Loud" is what logs/last-sync.json is for. It is the machine-readable answer to
// "is the automation actually healthy?", so a session can check the automation's own
// state without trusting that it ran.
//
// The status is written as "running" BEFORE any work starts. A killed process cannot
// report on itself, so without this a killed run leaves the previous run's "ok" in
// place, and that file then says the opposite of what happened. The next run reads a
// leftover "running" and reports the interruption.
//
// Before syncing it pulls each indexed repo that has no local changes (scripts/lib/repo-pull.mjs),
// so work pushed from the laptop reaches the brain. After syncing it rebuilds the brain
// report (scripts/brain-report.mjs). A failure in either is logged and does not fail the sync.
//
// Usage:
//   node scripts/scheduled-sync.mjs        pull, sync, report; log + record status

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { waitForDns, isNetworkFailure } from "./lib/network.mjs";
import { pullRepos } from "./lib/repo-pull.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const LOG_DIR = join(REPO_ROOT, "logs");
const LOG_FILE = join(LOG_DIR, "brain-sync.log");
const STATUS_FILE = join(LOG_DIR, "last-sync.json");

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 60_000;
const ERROR_TAIL_LINES = 15;

function ensureLogDir() {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
}

function logLine(line) {
  const stamped = `${new Date().toISOString()}  ${line}`;
  console.log(stamped);
  try {
    ensureLogDir();
    appendFileSync(LOG_FILE, stamped + "\n");
  } catch {
    // Never let a logging failure change the run's outcome.
  }
}

function writeStatus(status) {
  try {
    ensureLogDir();
    writeFileSync(STATUS_FILE, JSON.stringify(status, null, 2) + "\n");
  } catch (err) {
    logLine(`WARN  could not write ${STATUS_FILE}: ${err.message}`);
  }
}

function readPreviousStatus() {
  try {
    return JSON.parse(readFileSync(STATUS_FILE, "utf8"));
  } catch {
    return null;
  }
}

function supabaseHost() {
  try {
    const match = readFileSync(join(REPO_ROOT, ".env"), "utf8").match(/^SUPABASE_URL=(.+)$/m);
    return match ? new URL(match[1].trim()).hostname : null;
  } catch {
    return null;
  }
}

function logChildOutput(out) {
  // Indent the child's own output under the run header so the log stays readable.
  try {
    ensureLogDir();
    const body = out
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => `    ${l}\n`)
      .join("");
    appendFileSync(LOG_FILE, body);
  } catch {
    // Never let a logging failure change the run's outcome.
  }
}

function runScript(name) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(__dirname, name)], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    child.on("error", (err) => resolve({ code: -1, out: `spawn failed: ${err.message}` }));
    child.on("close", (code) => resolve({ code, out }));
  });
}

const startedAt = new Date().toISOString();
const started = Date.now();

const previous = readPreviousStatus();
const interruptedPrevious = previous?.status === "running" ? previous.startedAt ?? "unknown" : null;
// Older status files predate lastOkAt, so fall back to their own finish time if they were healthy.
const lastOkAt = previous?.lastOkAt ?? (previous?.status === "ok" ? previous.finishedAt : null);

writeStatus({ status: "running", startedAt, pid: process.pid, lastOkAt, interruptedPrevious });

logLine("---- scheduled sync starting ----");
if (interruptedPrevious) {
  logLine(`WARN  the run started ${interruptedPrevious} never finished — it was interrupted`);
}

const host = supabaseHost();
let waitedMs = 0;
if (host) {
  const network = await waitForDns(host);
  waitedMs = network.waitedMs;
  if (waitedMs > 5000) logLine(`INFO  waited ${Math.round(waitedMs / 1000)}s for the network`);
  if (!network.ok) logLine(`WARN  still no DNS for ${host} (${network.error}); trying anyway`);
}

let repos = [];
try {
  repos = pullRepos();
  for (const r of repos.filter((r) => r.result !== "current" && !(r.result === "dirty" && !r.behind))) {
    logLine(`PULL  ${r.repo}: ${r.result}${r.behind ? ` (${r.behind} commit(s) behind)` : ""}${r.detail ? ` — ${r.detail}` : ""}`);
  }
} catch (err) {
  logLine(`WARN  repo pull step failed: ${err.message}`);
}

let attempts = 0;
let code;
let out;
for (;;) {
  attempts++;
  ({ code, out } = await runScript("brain-sync.mjs"));
  logChildOutput(out);
  if (code === 0 || attempts >= MAX_ATTEMPTS || !isNetworkFailure(out)) break;
  logLine(`WARN  attempt ${attempts} hit a network failure; retrying in ${RETRY_DELAY_MS / 1000}s`);
  await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
}

const durationMs = Date.now() - started;

// brain-sync's summary line, e.g.
//   "brain-sync summary: 1 ok, 0 failed, 223 unchanged (skipped), 224 total — 3 row(s) written."
// The skipped/rows fields are optional so this keeps parsing older output. Parsed
// loosely on purpose: a format change should not be able to report a healthy run.
const num = (re) => { const m = out.match(re); return m ? Number(m[1]) : null; };
const ok = num(/brain-sync summary: (\d+) ok/);
const failed = num(/brain-sync summary: \d+ ok, (\d+) failed/);
const skipped = num(/(\d+) unchanged \(skipped\)/);
const total = num(/(\d+) total/);
const rows = num(/(\d+) row\(s\) written/);
const pruned = num(/(\d+) orphaned source\(s\) removed/) ?? 0;

// Any per-entry failure lines, so the status file names what broke rather than just counting it.
const failures = out
  .split("\n")
  .filter((l) => l.includes("[FAILED]"))
  .map((l) => l.trim());

const healthy = code === 0 && failed === 0 && total !== null && total > 0;
const finishedAt = new Date().toISOString();

writeStatus({
  status: healthy ? "ok" : "failed",
  startedAt,
  finishedAt,
  durationMs,
  exitCode: code,
  attempts,
  waitedMs,
  lastOkAt: healthy ? finishedAt : lastOkAt,
  interruptedPrevious,
  entries: { ok, failed, skipped, total, rowsWritten: rows, pruned },
  repos,
  failures,
  // A crash before the summary line has no [FAILED] entries, so keep the end of its
  // output. Without this, the reason survived only in the log.
  ...(healthy ? {} : { error: out.trim().split("\n").slice(-ERROR_TAIL_LINES).join("\n") }),
});

if (healthy) {
  logLine(
    `OK    ${total} source(s): ${ok} synced, ${skipped ?? 0} unchanged, ` +
      `${rows ?? 0} row(s) written in ${Math.round(durationMs / 1000)}s` +
      (attempts > 1 ? ` (attempt ${attempts})` : "")
  );
} else {
  logLine(`FAIL  exit=${code} ok=${ok} failed=${failed} total=${total} after ${attempts} attempt(s) — see ${STATUS_FILE}`);
  process.exitCode = 1;
}

const report = await runScript("brain-report.mjs");
logChildOutput(report.out);
if (report.code !== 0) logLine(`WARN  brain report failed (exit ${report.code}); the sync result above stands`);
