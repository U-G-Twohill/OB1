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
// Usage:
//   node scripts/scheduled-sync.mjs        run the sync, log + record status

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, appendFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const LOG_DIR = join(REPO_ROOT, "logs");
const LOG_FILE = join(LOG_DIR, "brain-sync.log");
const STATUS_FILE = join(LOG_DIR, "last-sync.json");

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

function runSync() {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(__dirname, "brain-sync.mjs")], {
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

logLine("---- scheduled sync starting ----");

const { code, out } = await runSync();
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

// Any per-entry failure lines, so the status file names what broke rather than just counting it.
const failures = out
  .split("\n")
  .filter((l) => l.includes("[FAILED]"))
  .map((l) => l.trim());

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

const healthy = code === 0 && failed === 0 && total !== null && total > 0;

writeStatus({
  status: healthy ? "ok" : "failed",
  startedAt,
  finishedAt: new Date().toISOString(),
  durationMs,
  exitCode: code,
  entries: { ok, failed, skipped, total, rowsWritten: rows },
  failures,
});

if (healthy) {
  logLine(
    `OK    ${total} source(s): ${ok} synced, ${skipped ?? 0} unchanged, ` +
      `${rows ?? 0} row(s) written in ${Math.round(durationMs / 1000)}s`
  );
} else {
  logLine(`FAIL  exit=${code} ok=${ok} failed=${failed} total=${total} — see ${STATUS_FILE}`);
  process.exitCode = 1;
}
