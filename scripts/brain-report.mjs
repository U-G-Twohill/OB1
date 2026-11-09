#!/usr/bin/env node
// Brain report: one self-contained HTML page answering "can I trust what the brain says
// today, and what does it know?"
//
// The brain's job is consistent context on any machine or AI without re-explaining. So
// the page leads with trust (did the sync work, do known questions still find the right
// answer, which repos are behind) and follows with shape (what it knows, what changed,
// which documents exist twice).
//
// It runs after each scheduled sync and writes logs/brain-report.html (gitignored). It
// uses the same local .env as the sync, needs no server, and sends nothing anywhere but
// Supabase and the embedding API, both of which the sync already talks to.
//
// Cost: embeddings are cached in logs/report-cache.json by row id, so a daily run
// downloads only the rows that changed. The 15 golden queries cost 15 small embedding calls.
//
// Usage:
//   node scripts/brain-report.mjs              build logs/brain-report.html
//   node scripts/brain-report.mjs --no-golden  skip the search checks (no embedding calls)

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { manifest } from "../manifest.mjs";
import { sources } from "../sources.mjs";
import {
  COMMAND_CENTER_ROOT, GRADUATED_MARKER, curatedEntries, expandSources, materialize,
  sourceMtime, isDigestStale, digestedAtInstant,
} from "./lib/entries.mjs";
import { indexedRepos } from "./lib/repo-pull.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const LOG_DIR = join(REPO_ROOT, "logs");
const OUT_FILE = join(LOG_DIR, "brain-report.html");
const CACHE_FILE = join(LOG_DIR, "report-cache.json");
const GOLDEN_HISTORY = join(LOG_DIR, "golden-history.jsonl");
const GOLDEN_DOC = join(REPO_ROOT, "docs", "golden-queries.md");

const COPY_THRESHOLD = 0.92; // cosine similarity at which two documents are near-copies
const ACTIVE_DAYS = 60; // a repo with a commit this recent counts as active
const WEEK_MS = 7 * 86400000;
const now = new Date();

// Repos left out of the index on purpose, with the reason (from sources.mjs and ADR 0007).
const NOT_INDEXED_ON_PURPOSE = {
  Whetstone: "Excluded permanently (ADR 0007)",
  "image-visualizer": "386 files would swamp search",
  "relay-sandbox": "A test copy of icu-relay",
  "icu-brain": "This repo; mostly upstream Open Brain content",
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(REPO_ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    env[t.slice(0, t.indexOf("=")).trim()] = t.slice(t.indexOf("=") + 1).trim();
  }
  return env;
}

const env = loadEnv();
const headers = { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` };
const skipGolden = process.argv.includes("--no-golden");

async function getJson(path, extra = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { headers: { ...headers, ...extra } });
  if (!res.ok) throw new Error(`${path.split("?")[0]}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const days = (a, b = now) => Math.floor((b - a) / 86400000);
const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

// ---------------------------------------------------------------------------
// Projects: one name per repo, with Command Center and memory folded in
// ---------------------------------------------------------------------------

const repoRules = sources.filter((r) => r.id.startsWith("repo-"));
const PROJECT_NAME = { "command-center": "Command Center", "other-memory": "Other Claude memory" };
for (const r of repoRules) PROJECT_NAME[r.id.slice(5)] = r.label.replace(/^Repo — /, "");

// Claude Code names a project's memory folder after its path: "D:/Websites/Public Service
// Center" becomes "D--Websites-Public-Service-Center". Matching that back means a memory
// file counts towards the project it is about.
const encodeDir = (dir) => dir.replace(/[:\\/ ]/g, "-");
const MEMORY_DIR_PROJECT = new Map(repoRules.map((r) => [encodeDir(r.root).toLowerCase(), r.id.slice(5)]));
MEMORY_DIR_PROJECT.set(encodeDir(COMMAND_CENTER_ROOT).toLowerCase(), "command-center");
const CURATED_REPO = { "repo-icu-tools": "icu-tools", "repo-glenstoolkit": "glenstoolkit", "repo-project-hub": "project-hub", "repo-vps-infra": "vps-infra" };

function projectOf(ruleId, slug, file) {
  if (ruleId?.startsWith("repo-")) return ruleId.slice(5);
  if (ruleId?.startsWith("cc-")) return "command-center";
  if (ruleId === "project-memory") {
    const dir = (file || "").replace(/\\/g, "/").split("/").slice(-3, -2)[0] || "";
    return MEMORY_DIR_PROJECT.get(dir.toLowerCase()) || "other-memory";
  }
  if (CURATED_REPO[slug]) return CURATED_REPO[slug];
  return "command-center"; // curated memory-* and cc-* digests
}

// The folder a source sits in, for the drill-down: its first path segment under the rule root.
function folderOf(entry) {
  if (entry.ruleId === "curated") return "curated digests";
  if (entry.ruleId === "project-memory") return "Claude memory";
  const rule = sources.find((r) => r.id === entry.ruleId);
  const rel = entry.path.slice(rule.root.replace(/\\/g, "/").length + 1);
  return rel.includes("/") ? rel.split("/")[0] + "/" : "(root files)";
}

function relLabel(entry) {
  if (entry.ruleId === "curated") return entry.path;
  if (entry.ruleId === "project-memory") return entry.path.split("/").slice(-3).join("/");
  const rule = sources.find((r) => r.id === entry.ruleId);
  return entry.path.slice(rule.root.replace(/\\/g, "/").length + 1);
}

// ---------------------------------------------------------------------------
// Data gathering
// ---------------------------------------------------------------------------

function loadLocal() {
  const entries = [...curatedEntries(), ...expandSources()];
  return entries.map((e) => {
    let chars = 0, chunks = 0;
    try {
      const parts = materialize(e);
      chunks = parts.length;
      chars = parts.reduce((n, p) => n + p.content.length, 0);
    } catch { /* unreadable: counted as zero, and the sync reports it */ }
    const mtime = e.strategy === "file" && e.ruleId !== "curated" ? statSync(e.path).mtime : sourceMtime(e);
    return {
      slug: e.sourceSlug, ruleId: e.ruleId, path: e.path.replace(/\\/g, "/"),
      project: projectOf(e.ruleId, e.sourceSlug, e.path), folder: folderOf(e), label: relLabel(e),
      chars, chunks, mtime, superseded: Boolean(e.digestSuperseded),
    };
  });
}

async function loadRows() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const page = await getJson("thoughts?select=id,metadata&order=id.asc", { Range: `${from}-${from + 999}` });
    rows.push(...page);
    if (page.length < 1000) break;
  }
  return rows;
}

// Embeddings by row id. A synced row is deleted and re-inserted when its source changes, so
// an unchanged id means an unchanged embedding and the cache never needs invalidating.
async function loadEmbeddings(rows) {
  let cache = {};
  try { cache = JSON.parse(readFileSync(CACHE_FILE, "utf8")); } catch { /* first run */ }
  const ids = rows.map((r) => r.id);
  const missing = ids.filter((id) => !cache[id]);
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const page = await getJson(`thoughts?select=id,embedding&id=in.(${batch.join(",")})`);
    for (const r of page) {
      if (!r.embedding) continue;
      const v = Float32Array.from(JSON.parse(r.embedding));
      cache[r.id] = Buffer.from(v.buffer).toString("base64");
    }
  }
  const kept = {};
  for (const id of ids) if (cache[id]) kept[id] = cache[id];
  writeFileSync(CACHE_FILE, JSON.stringify(kept));
  const out = new Map();
  for (const [id, b64] of Object.entries(kept)) {
    const buf = Buffer.from(b64, "base64");
    const v = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
    let n = 0;
    for (const x of v) n += x * x;
    n = Math.sqrt(n) || 1;
    out.set(id, v.map((x) => x / n));
  }
  return { vectors: out, fetched: missing.length };
}

function readStatus() {
  try { return JSON.parse(readFileSync(join(LOG_DIR, "last-sync.json"), "utf8")); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Analyses
// ---------------------------------------------------------------------------

function parity(local, rows) {
  const expected = new Set(local.map((e) => e.slug));
  const inDb = new Map();
  for (const r of rows) {
    const m = r.metadata || {};
    if (!m.sourceSlug) continue;
    const g = m.sourceGroup || m.sourceSlug;
    inDb.set(g, m.sourceFile || "");
  }
  return {
    orphans: [...inDb].filter(([g]) => !expected.has(g)).map(([g, f]) => ({ slug: g, file: f })),
    missing: local.filter((e) => !inDb.has(e.slug)),
    adhoc: rows.filter((r) => !r.metadata?.sourceSlug).length,
    newestSync: rows.reduce((max, r) => (r.metadata?.syncedAt > max ? r.metadata.syncedAt : max), ""),
  };
}

function digestDrift() {
  return manifest
    .filter((e) => isDigestStale(e))
    .map((e) => ({ slug: e.sourceSlug, path: e.path, behind: days(digestedAtInstant(e), sourceMtime(e)) }))
    .sort((a, b) => b.behind - a.behind);
}

// Pairs of documents in different projects whose embeddings are near-identical.
function findCopies(rows, vectors, local) {
  const bySlug = new Map(local.map((e) => [e.slug, e]));
  const items = [];
  for (const r of rows) {
    const m = r.metadata || {};
    const v = vectors.get(r.id);
    const group = m.sourceGroup || m.sourceSlug;
    if (!v || !group || !bySlug.has(group)) continue;
    items.push({ v, group, project: bySlug.get(group).project });
  }
  const best = new Map(); // "groupA|groupB" -> similarity
  for (let i = 0; i < items.length; i++) {
    const a = items[i];
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j];
      if (a.project === b.project) continue;
      let s = 0;
      const va = a.v, vb = b.v;
      for (let k = 0; k < va.length; k++) s += va[k] * vb[k];
      if (s < COPY_THRESHOLD) continue;
      const key = [a.group, b.group].sort().join("|");
      if (!(best.get(key) >= s)) best.set(key, s);
    }
  }
  // A file name found in three or more projects is template boilerplate, not a graduation.
  const namesByProject = new Map();
  for (const e of local) {
    const n = basename(e.path).toLowerCase();
    if (!namesByProject.has(n)) namesByProject.set(n, new Set());
    namesByProject.get(n).add(e.project);
  }
  return [...best].map(([key, sim]) => {
    const [x, y] = key.split("|").map((g) => bySlug.get(g));
    const [older, newer] = x.mtime <= y.mtime ? [x, y] : [y, x];
    const name = basename(x.path).toLowerCase();
    let kind = "Near copy";
    if (name === basename(y.path).toLowerCase() && namesByProject.get(name).size >= 3) kind = "Template copy";
    else if (older.project === "command-center") kind = "Graduation candidate";
    return { sim, older, newer, kind, gap: days(older.mtime, newer.mtime) };
  }).sort((a, b) => b.sim - a.sim || b.gap - a.gap);
}

function graduatedFolders() {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    let names;
    try { names = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    if (names.some((n) => n.name === GRADUATED_MARKER)) {
      const text = readFileSync(join(dir, GRADUATED_MARKER), "utf8");
      const current = (text.match(/\*\*Current version:\*\*\s*(.+)/)?.[1] ?? "").replace(/`/g, "");
      const when = text.match(/\*\*Graduated:\*\*\s*(\S+)/)?.[1] ?? "";
      found.push({ folder: dir.replace(/\\/g, "/").slice(COMMAND_CENTER_ROOT.length + 1) + "/", current, when });
      return;
    }
    for (const n of names) if (n.isDirectory() && !n.name.startsWith(".") && n.name !== "node_modules") walk(join(dir, n.name), depth + 1);
  };
  walk(COMMAND_CENTER_ROOT, 0);
  return found;
}

function gitOut(cwd, args) {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15000 }).trim();
  } catch { return null; }
}

// Repos that have had commits recently but that no rule indexes.
function coverageGaps() {
  const indexed = new Set(indexedRepos().map((p) => p.toLowerCase()));
  const gaps = [];
  for (const parent of ["D:/Repos", "D:/Websites"]) {
    let names = [];
    try { names = readdirSync(parent, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
    for (const name of names) {
      const dir = `${parent}/${name}`;
      if (!existsSync(`${dir}/.git`) || indexed.has(dir.toLowerCase())) continue;
      const last = gitOut(dir, ["log", "-1", "--format=%cI"]);
      if (!last || days(new Date(last)) > ACTIVE_DAYS) continue;
      // A worktree's .git is a file pointing at its main repo; if that repo is indexed, so is its work.
      let reason = NOT_INDEXED_ON_PURPOSE[name] ?? null;
      if (!reason && statSync(`${dir}/.git`).isFile()) {
        const main = dirname(gitOut(dir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) || "").replace(/\\/g, "/");
        if (indexed.has(main.toLowerCase())) reason = `A worktree of ${basename(main)}, which is indexed`;
      }
      gaps.push({ name, dir, last: new Date(last), reason });
    }
  }
  return gaps.sort((a, b) => b.last - a.last);
}

// Read the golden queries table: question in column 2, expected slugs in backticks in column 3.
function goldenQueries() {
  const out = [];
  for (const line of readFileSync(GOLDEN_DOC, "utf8").split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells.length < 5 || !/^\d+$/.test(cells[1])) continue;
    const expected = [...cells[3].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (expected.length) out.push({ n: Number(cells[1]), question: cells[2], expected });
  }
  return out;
}

async function embed(text) {
  const res = await fetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "openai/text-embedding-3-small", input: text }),
  });
  if (!res.ok) throw new Error(`embedding: HTTP ${res.status}`);
  return (await res.json()).data[0].embedding;
}

// Ask each golden question the way search_thoughts does, and record where the expected
// source ranked. A pass is a top-3 hit, the bar docs/golden-queries.md sets.
async function runGolden() {
  const results = [];
  for (const q of goldenQueries()) {
    try {
      const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_thoughts`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ query_embedding: await embed(q.question), match_threshold: 0, match_count: 10, filter: {} }),
      });
      if (!res.ok) throw new Error(`match_thoughts: HTTP ${res.status}`);
      const hits = (await res.json()).map((h) => ({ group: h.metadata?.sourceGroup || h.metadata?.sourceSlug || "(ad hoc note)", sim: h.similarity }));
      const idx = hits.findIndex((h) => q.expected.includes(h.group));
      results.push({ ...q, rank: idx < 0 ? null : idx + 1, sim: idx < 0 ? null : hits[idx].sim, top: hits[0] });
    } catch (err) {
      results.push({ ...q, rank: null, error: err.message });
    }
  }
  let previous = null;
  try {
    const lines = readFileSync(GOLDEN_HISTORY, "utf8").trim().split("\n");
    previous = JSON.parse(lines[lines.length - 1]);
  } catch { /* first run */ }
  appendFileSync(GOLDEN_HISTORY, JSON.stringify({ at: now.toISOString(), ranks: Object.fromEntries(results.map((r) => [r.n, r.rank])) }) + "\n");
  return { results, previous };
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (n) => Number(n).toLocaleString("en-NZ");
const STATUS = {
  good: { icon: "✓", label: "OK" },
  warning: { icon: "!", label: "Check" },
  critical: { icon: "✕", label: "Problem" },
};
const badge = (level, text) => `<span class="badge ${level}"><span aria-hidden="true">${STATUS[level].icon}</span> ${esc(text ?? STATUS[level].label)}</span>`;

function tile(label, value, note, level) {
  return `<div class="tile"><div class="tile-label">${esc(label)}</div><div class="tile-value">${value}</div>` +
    `<div class="tile-note">${level ? badge(level, note) : esc(note)}</div></div>`;
}

function section(id, title, intro, body) {
  return `<section id="${id}"><h2>${esc(title)}</h2>${intro ? `<p class="intro">${intro}</p>` : ""}${body}</section>`;
}

function table(head, rows, cls = "") {
  return `<div class="table-wrap"><table class="${cls}"><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>` +
    `<tbody>${rows.join("") || `<tr><td colspan="${head.length}" class="muted">Nothing to show.</td></tr>`}</tbody></table></div>`;
}

function render(d) {
  const { status, local, rows, par, drift, golden, copies, grads, gaps, embedInfo } = d;
  const totalChars = local.reduce((n, e) => n + e.chars, 0);

  // --- Health ---------------------------------------------------------------
  const syncAge = status?.finishedAt ? (now - new Date(status.finishedAt)) / 3600000 : null;
  const syncLevel = !status ? "warning" : status.status === "ok" ? (syncAge < 26 ? "good" : "warning") : "critical";
  const syncNote = !status ? "No status recorded" : status.status === "running" ? "Running, or interrupted"
    : status.status === "ok" ? `${syncAge < 1 ? "under an hour" : `${Math.round(syncAge)}h`} ago` : "Last run failed";
  const goldenPass = golden ? golden.results.filter((r) => r.rank && r.rank <= 3).length : null;
  const repos = status?.repos ?? [];
  const behind = repos.filter((r) => r.result === "dirty" && r.behind > 0);
  const repoFailed = repos.filter((r) => r.result === "failed");

  const tiles = [
    tile("Last scheduled sync", status?.finishedAt ? isoDay(status.finishedAt) : "—", syncNote, syncLevel),
    tile("Sources indexed", fmt(local.length), `${fmt(rows.length)} rows · ${(totalChars / 1e6).toFixed(1)}M characters`),
    golden
      ? tile("Search checks", `${goldenPass}/${golden.results.length}`, goldenPass === golden.results.length ? "All found in the top 3" : "Some answers slipped",
        goldenPass === golden.results.length ? "good" : "warning")
      : tile("Search checks", "—", "Skipped this run"),
    tile("Out of date in the brain", fmt(par.missing.length + par.orphans.length),
      par.missing.length + par.orphans.length === 0 ? "Database matches sources" : "The next sync fixes these",
      par.missing.length + par.orphans.length === 0 ? "good" : "warning"),
    tile("Repos behind", fmt(behind.length + repoFailed.length),
      repos.length === 0 ? "Recorded from the next scheduled sync" : behind.length + repoFailed.length === 0 ? "All pulled" : "Not pulled: local changes",
      repos.length === 0 ? null : behind.length + repoFailed.length === 0 ? "good" : "warning"),
    tile("Copies", fmt(copies.length), `Near-identical pairs across projects`),
  ].join("");

  const healthRows = [];
  if (status) {
    healthRows.push(`<tr><td>Scheduled sync</td><td>${badge(syncLevel, syncNote)}</td><td>${esc(
      status.entries ? `${fmt(status.entries.total ?? 0)} sources: ${fmt(status.entries.ok ?? 0)} re-embedded, ${fmt(status.entries.skipped ?? 0)} unchanged, ${fmt(status.entries.pruned ?? 0)} removed` : ""
    )}${status.interruptedPrevious ? ` · the run before was interrupted` : ""}${status.error ? `<pre>${esc(status.error)}</pre>` : ""}</td></tr>`);
  }
  healthRows.push(`<tr><td>Database vs sources</td><td>${par.missing.length + par.orphans.length ? badge("warning", "Differs") : badge("good", "Matches")}</td><td>${
    fmt(par.missing.length)} source(s) not yet in the brain, ${fmt(par.orphans.length)} entr${par.orphans.length === 1 ? "y" : "ies"} whose source is gone or excluded. Newest write ${esc(isoDay(par.newestSync))}. ${par.adhoc} hand-captured note(s).</td></tr>`);
  healthRows.push(`<tr><td>Curated digests</td><td>${drift.length ? badge("warning", `${drift.length} behind`) : badge("good", "Current")}</td><td>${
    drift.length ? `${drift.length} of ${manifest.length} digests are older than their source. The brain serves the source file instead, so answers stay current, but the summary is worth rewriting.` : "Every digest is at least as new as its source."}</td></tr>`);

  const driftTable = drift.length
    ? `<details><summary>Digests to rewrite (${drift.length})</summary>${table(["Digest", "Source", "Days behind"],
      drift.map((x) => `<tr><td><code>${esc(x.slug)}</code></td><td>${esc(x.path)}</td><td class="num">${x.behind}</td></tr>`))}</details>` : "";
  const parityTable = par.missing.length + par.orphans.length
    ? `<details><summary>What differs (${par.missing.length + par.orphans.length})</summary>${table(["Entry", "Why"], [
      ...par.missing.slice(0, 40).map((e) => `<tr><td><code>${esc(e.slug)}</code></td><td>New or changed; not in the brain yet</td></tr>`),
      ...par.orphans.slice(0, 40).map((o) => `<tr><td><code>${esc(o.slug)}</code></td><td>Source gone or excluded: ${esc(o.file)}</td></tr>`),
    ])}</details>` : "";

  const repoTable = repos.length
    ? table(["Repo", "Pull", "Commits behind"], repos.map((r) => {
      const level = r.result === "failed" ? "critical" : r.result === "dirty" && r.behind > 0 ? "warning" : "good";
      const text = { updated: "Pulled", current: "Up to date", dirty: "Local changes, not pulled", "no-upstream": "No remote", failed: "Failed" }[r.result];
      return `<tr><td>${esc(r.repo)}</td><td>${badge(level, text)}${r.detail ? ` <span class="muted">${esc(r.detail)}</span>` : ""}</td><td class="num">${r.behind ?? "—"}</td></tr>`;
    }))
    : `<p class="muted">The pull step runs inside the scheduled sync and is recorded from its next run.</p>`;

  const health = section("health", "Health", "Whether the brain matches your files today. Green here means it matches its sources, not that the sources are right.",
    table(["Check", "State", "Detail"], healthRows) + driftTable + parityTable +
    `<h3>Repos</h3><p class="intro">Before each sync, every indexed repo without uncommitted changes is pulled, so laptop work arrives. A repo with local changes is only fetched, and its commits from elsewhere stay out of the brain until you pull it.</p>${repoTable}`);

  // --- Search checks --------------------------------------------------------
  let search = "";
  if (golden) {
    const prev = golden.previous?.ranks ?? {};
    search = section("search", "Search checks",
      `The questions in <code>docs/golden-queries.md</code>, asked the way any connected AI asks them. Each passes when the source that should answer it ranks in the top 3. A drop from the last run is how a stale or duplicated document shows up.`,
      table(["#", "Question", "Expected source rank", "Change", "Top result instead"], golden.results.map((r) => {
        const level = r.rank && r.rank <= 3 ? "good" : r.rank ? "warning" : "critical";
        const before = prev[r.n];
        const change = before === undefined ? "" : before === r.rank ? "Same" : !r.rank ? "Dropped out" : !before || r.rank < before ? `Up from ${before ?? "none"}` : `Down from ${before}`;
        const top = r.rank === 1 ? "" : r.error ? esc(r.error) : r.top ? `<code>${esc(r.top.group)}</code> ${(r.top.sim * 100).toFixed(0)}%` : "";
        return `<tr><td class="num">${r.n}</td><td>${esc(r.question)}</td><td>${badge(level, r.rank ? `#${r.rank}${r.sim ? ` · ${(r.sim * 100).toFixed(0)}%` : ""}` : "Not in top 10")}</td><td>${esc(change)}</td><td>${top}</td></tr>`;
      })));
  }

  // --- What it knows --------------------------------------------------------
  const projects = new Map();
  for (const e of local) {
    if (!projects.has(e.project)) projects.set(e.project, { sources: 0, chars: 0, rows: 0, newest: 0, folders: new Map() });
    const p = projects.get(e.project);
    p.sources++; p.chars += e.chars; p.rows += e.chunks;
    if (e.mtime > p.newest) p.newest = e.mtime;
    const f = p.folders.get(e.folder) || { sources: 0, chars: 0, newest: 0 };
    f.sources++; f.chars += e.chars; if (e.mtime > f.newest) f.newest = e.mtime;
    p.folders.set(e.folder, f);
  }
  const ranked = [...projects].sort((a, b) => b[1].chars - a[1].chars);
  const maxChars = ranked[0]?.[1].chars || 1;
  const bar = (v, max, tip) => `<span class="bar" tabindex="0" data-tip="${esc(tip)}"><span style="width:${Math.max(0.5, (v / max) * 100).toFixed(2)}%"></span></span>`;
  const knows = section("knows", "What it knows",
    `Every project the brain covers, sized by how much text it holds. Open a project to see its folders. Command Center includes its curated digests; each repo includes the Claude memory files written about it.`,
    `<div class="bars">${ranked.map(([key, p]) => {
      const share = ((p.chars / totalChars) * 100).toFixed(0);
      const tip = `${PROJECT_NAME[key]}: ${fmt(p.sources)} sources, ${fmt(p.rows)} rows, ${(p.chars / 1e6).toFixed(2)}M characters (${share}% of the brain). Newest edit ${isoDay(p.newest)}.`;
      const folders = [...p.folders].sort((a, b) => b[1].chars - a[1].chars);
      const fmax = folders[0]?.[1].chars || 1;
      return `<details class="bar-row"><summary><span class="bar-name">${esc(PROJECT_NAME[key])}</span>${bar(p.chars, maxChars, tip)}` +
        `<span class="bar-value">${share}% · ${fmt(p.sources)}</span><span class="bar-age muted">${days(p.newest)}d</span></summary>` +
        `<div class="folders">${folders.map(([name, f]) =>
          `<div class="folder-row"><span class="bar-name">${esc(name)}</span>${bar(f.chars, fmax, `${name}: ${fmt(f.sources)} sources, newest edit ${isoDay(f.newest)}`)}<span class="bar-value">${fmt(f.sources)}</span><span class="bar-age muted">${days(f.newest)}d</span></div>`).join("")}</div></details>`;
    }).join("")}</div><p class="legend muted">Bar: share of the brain's text · number: sources · last column: days since the newest edit.</p>`);

  // --- Activity -------------------------------------------------------------
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const m = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    months.push(m.toISOString().slice(0, 7));
  }
  const grid = new Map();
  let maxCell = 1;
  for (const e of local) {
    if (!e.mtime) continue;
    const m = e.mtime.toISOString().slice(0, 7);
    if (!months.includes(m)) continue;
    const k = `${e.project}|${m}`;
    grid.set(k, (grid.get(k) || 0) + 1);
    maxCell = Math.max(maxCell, grid.get(k));
  }
  const RAMP = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"];
  const cell = (n) => (n ? RAMP[Math.min(RAMP.length - 1, Math.floor((Math.log(n) / Math.log(maxCell + 1)) * RAMP.length))] : "");
  const monthName = (m) => new Date(`${m}-01T00:00:00Z`).toLocaleString("en-NZ", { month: "short", timeZone: "UTC" });
  const activity = section("activity", "Activity",
    `Files last edited in each month, by project. Each file counts once, in the month of its latest edit, so this shows where work went most recently rather than total effort.`,
    `<div class="table-wrap"><table class="heat"><thead><tr><th></th>${months.map((m) => `<th>${monthName(m)}<br><span class="muted">${m.slice(2, 4)}</span></th>`).join("")}</tr></thead><tbody>${
      ranked.map(([key]) => `<tr><th>${esc(PROJECT_NAME[key])}</th>${months.map((m) => {
        const n = grid.get(`${key}|${m}`) || 0;
        const dark = n && RAMP.indexOf(cell(n)) >= 3;
        return `<td tabindex="0" data-tip="${esc(`${PROJECT_NAME[key]}, ${monthName(m)} ${m.slice(0, 4)}: ${n} file(s)`)}"><span class="cell${n ? "" : " empty"}" style="${n ? `background:${cell(n)};color:${dark ? "#fff" : "#0b0b0b"}` : ""}">${n || ""}</span></td>`;
      }).join("")}</tr>`).join("")
    }</tbody></table></div>`);

  // --- Changed this week ----------------------------------------------------
  const recent = local.filter((e) => e.mtime && now - e.mtime < WEEK_MS).sort((a, b) => b.mtime - a.mtime);
  const byProj = new Map();
  for (const e of recent) {
    if (!byProj.has(e.project)) byProj.set(e.project, []);
    byProj.get(e.project).push(e);
  }
  const changed = section("changed", "Changed this week",
    `${fmt(recent.length)} file(s) edited in the last 7 days, newest first. These are what a session on another machine now sees.`,
    [...byProj].map(([key, list]) => `<details><summary>${esc(PROJECT_NAME[key])} <span class="muted">${list.length}</span></summary><ul class="files">${
      list.slice(0, 25).map((e) => `<li><code>${esc(e.label)}</code> <span class="muted">${isoDay(e.mtime)}</span></li>`).join("")
    }${list.length > 25 ? `<li class="muted">and ${list.length - 25} more</li>` : ""}</ul></details>`).join("") || `<p class="muted">No edits this week.</p>`);

  // --- Copies ---------------------------------------------------------------
  const kinds = ["Graduation candidate", "Near copy", "Template copy"];
  const kindHelp = {
    "Graduation candidate": "The Command Center copy is the older one. If the repo now holds the current version, graduate the folder: Command Center <code>reference/graduation.md</code>.",
    "Near copy": "The same content in two projects. Decide which copy is the live one and exclude or freeze the other.",
    "Template copy": "Boilerplate copied into three or more repos. Harmless, but each extra copy takes a search slot from something more useful.",
  };
  const copyTables = kinds.map((k) => {
    const list = copies.filter((c) => c.kind === k);
    if (!list.length) return "";
    return `<details${k === "Graduation candidate" ? " open" : ""}><summary>${k} <span class="muted">${list.length}</span></summary><p class="intro">${kindHelp[k]}</p>${
      table(["Similarity", "Older copy", "Newer copy", "Days apart"], list.slice(0, 60).map((c) =>
        `<tr><td class="num">${(c.sim * 100).toFixed(1)}%</td><td>${esc(PROJECT_NAME[c.older.project])}<br><code>${esc(c.older.label)}</code> <span class="muted">${isoDay(c.older.mtime)}</span></td>` +
        `<td>${esc(PROJECT_NAME[c.newer.project])}<br><code>${esc(c.newer.label)}</code> <span class="muted">${isoDay(c.newer.mtime)}</span></td><td class="num">${c.gap}</td></tr>`))}</details>`;
  }).join("");
  const gradRows = grads.map((g) => `<tr><td><code>${esc(g.folder)}</code></td><td>${esc(g.current)}</td><td>${esc(g.when)}</td></tr>`);
  const copiesSection = section("copies", "Copies and graduation",
    `Documents in different projects that are ${Math.round(COPY_THRESHOLD * 100)}% or more alike. Two copies of one document compete for the same search slot, and the older one can contradict the newer. ${fmt(copies.length)} pair(s) found.`,
    copyTables + `<h3>Graduated folders</h3><p class="intro">Frozen in Command Center and left out of the brain because their project's own repo now holds the current version. Ledger: Command Center <code>context/system-map.md</code>.</p>` +
    table(["Folder", "Current version", "Graduated"], gradRows));

  // --- Coverage -------------------------------------------------------------
  const unplanned = gaps.filter((g) => !g.reason);
  const coverage = section("coverage", "Coverage",
    `Repos with a commit in the last ${ACTIVE_DAYS} days that the brain does not index. Anything here is invisible to a session on the laptop or in claude.ai.`,
    table(["Repo", "Last commit", "Why not indexed"], gaps.map((g) =>
      `<tr><td>${esc(g.name)}</td><td>${isoDay(g.last)}</td><td>${g.reason ? esc(g.reason) : badge("warning", "No rule yet: add it to sources.mjs after a privacy scan")}</td></tr>`)) +
    `<p class="muted">Also outside the brain by design: client customers' personal data, non-markdown files, and dependency or build folders.</p>`);

  const nav = [["health", "Health"], ...(golden ? [["search", "Search checks"]] : []), ["knows", "What it knows"], ["activity", "Activity"], ["changed", "This week"], ["copies", "Copies"], ["coverage", "Coverage"]]
    .map(([id, t]) => `<a href="#${id}">${t}</a>`).join("");

  return `<!doctype html>
<html lang="en-NZ">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Brain Report</title>
<style>
:root {
  color-scheme: light;
  --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --axis: #c3c2b7; --border: rgba(11,11,11,0.10); --series: #2a78d6; --track: #f0efec;
  --good: #0ca30c; --warning: #fab219; --critical: #d03b3b; --good-ink: #006300;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
    --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10); --series: #3987e5; --track: #262624; --good-ink: #0ca30c;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d; --surface: #1a1a19; --ink: #f0efec; --ink-2: #c3c2b7; --muted: #898781;
  --grid: #2c2c2a; --axis: #383835; --border: rgba(255,255,255,0.10); --series: #3987e5; --track: #262624; --good-ink: #0ca30c;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--page); color: var(--ink); font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
header, main { max-width: 1100px; margin: 0 auto; padding: 0 16px; }
header { padding-top: 28px; }
h1 { font-size: 26px; margin: 0 0 4px; }
h2 { font-size: 20px; margin: 0 0 6px; }
h3 { font-size: 16px; margin: 22px 0 4px; }
.sub, .intro, .muted, .legend { color: var(--ink-2); }
.muted { color: var(--muted); }
.intro { margin: 0 0 12px; max-width: 75ch; }
nav { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 14px 0 6px; }
nav a { color: var(--ink-2); text-decoration: none; border-bottom: 1px solid var(--axis); }
nav a:hover { color: var(--ink); }
section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 18px; margin: 16px 0; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin: 16px 0; }
.tile { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 12px 14px; }
.tile-label { color: var(--ink-2); font-size: 13px; }
.tile-value { font-size: 28px; font-weight: 600; margin: 2px 0; }
.tile-note { font-size: 13px; color: var(--ink-2); }
.badge { display: inline-flex; align-items: center; gap: 5px; font-size: 13px; white-space: nowrap; color: var(--ink); }
.tile .badge { white-space: normal; align-items: flex-start; }
.badge > span { flex: none; display: inline-grid; place-items: center; width: 16px; height: 16px; border-radius: 50%; font-size: 11px; font-weight: 700; color: #fff; }
.badge.good > span { background: var(--good); }
.badge.warning > span { background: var(--warning); color: #0b0b0b; }
.badge.critical > span { background: var(--critical); }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { text-align: left; padding: 7px 10px 7px 0; border-bottom: 1px solid var(--grid); vertical-align: top; }
th { color: var(--ink-2); font-weight: 600; font-size: 13px; }
td.num { font-variant-numeric: tabular-nums; text-align: right; }
code { font: 12.5px ui-monospace, "Cascadia Mono", Consolas, monospace; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; font-size: 12px; color: var(--ink-2); }
details { margin: 8px 0; }
summary { cursor: pointer; }
.bars { display: grid; gap: 2px; }
.bar-row > summary, .folder-row { display: grid; grid-template-columns: minmax(110px, 190px) 1fr 84px 44px; align-items: center; gap: 10px; padding: 4px 0; }
.bar-row > summary { list-style: none; }
.bar-row > summary::-webkit-details-marker { display: none; }
.bar-row > summary .bar-name::before { content: "▸ "; color: var(--muted); }
.bar-row[open] > summary .bar-name::before { content: "▾ "; }
.folders { padding: 4px 0 10px 14px; border-left: 1px solid var(--grid); margin-left: 4px; }
.folder-row { font-size: 13px; padding: 2px 0; }
.bar-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bar { display: block; height: 10px; background: var(--track); border-radius: 0 4px 4px 0; }
.bar > span { display: block; height: 100%; background: var(--series); border-radius: 0 4px 4px 0; }
.bar-value, .bar-age { font-variant-numeric: tabular-nums; text-align: right; font-size: 13px; }
.heat { border-collapse: separate; border-spacing: 2px; width: auto; }
.heat th, .heat td { border: 0; padding: 0; text-align: center; }
.heat tbody th { text-align: right; padding-right: 8px; font-weight: 400; color: var(--ink); white-space: nowrap; }
.heat thead th { font-weight: 400; font-size: 12px; line-height: 1.2; padding-bottom: 4px; }
.cell { display: grid; place-items: center; width: 40px; height: 26px; border-radius: 4px; font-size: 12px; font-variant-numeric: tabular-nums; }
.cell.empty { background: var(--track); }
ul.files { margin: 6px 0; padding-left: 18px; }
#tip { position: fixed; pointer-events: none; z-index: 10; max-width: 320px; padding: 7px 10px; border-radius: 6px; font-size: 13px;
  background: var(--ink); color: var(--page); opacity: 0; transition: opacity .1s; }
footer { max-width: 1100px; margin: 0 auto; padding: 8px 16px 32px; color: var(--muted); font-size: 13px; }
@media (max-width: 640px) {
  .bar-row > summary, .folder-row { grid-template-columns: minmax(90px, 120px) 1fr 70px 36px; gap: 6px; }
  .tile-value { font-size: 24px; }
}
</style>
</head>
<body>
<header>
<h1>Brain Report</h1>
<div class="sub">Open Brain, built ${esc(now.toLocaleString("en-NZ", { dateStyle: "full", timeStyle: "short" }))}</div>
<nav>${nav}</nav>
</header>
<main>
<div class="tiles">${tiles}</div>
${health}
${search}
${knows}
${activity}
${changed}
${copiesSection}
${coverage}
</main>
<footer>Generated by <code>scripts/brain-report.mjs</code> in icu-brain after each scheduled sync. ${embedInfo}. Git is the source of truth; this page describes the index built from it.</footer>
<div id="tip" role="tooltip"></div>
<script>
const tip = document.getElementById("tip");
function show(el, x, y) {
  tip.textContent = el.dataset.tip;
  tip.style.opacity = 1;
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(x + 12, innerWidth - r.width - 8) + "px";
  tip.style.top = Math.max(8, y - r.height - 12) + "px";
}
document.addEventListener("pointermove", (e) => {
  const el = e.target.closest("[data-tip]");
  if (el) show(el, e.clientX, e.clientY); else tip.style.opacity = 0;
});
document.addEventListener("focusin", (e) => {
  const el = e.target.closest("[data-tip]");
  if (!el) return;
  const r = el.getBoundingClientRect();
  show(el, r.left, r.top);
});
document.addEventListener("focusout", () => (tip.style.opacity = 0));
</script>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------

const t0 = Date.now();
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const local = loadLocal();
const rows = await loadRows();
const { vectors, fetched } = await loadEmbeddings(rows);
const golden = skipGolden ? null : await runGolden();
const data = {
  status: readStatus(),
  local,
  rows,
  par: parity(local, rows),
  drift: digestDrift(),
  golden,
  copies: findCopies(rows, vectors, local),
  grads: graduatedFolders(),
  gaps: coverageGaps(),
  embedInfo: `${fmt(fetched)} embedding(s) downloaded this run, ${fmt(vectors.size - fetched)} from cache`,
};
writeFileSync(OUT_FILE, render(data));
console.log(
  `brain-report: wrote ${OUT_FILE} in ${((Date.now() - t0) / 1000).toFixed(1)}s — ` +
    `${local.length} sources, ${data.copies.length} copy pair(s)` +
    (golden ? `, search checks ${golden.results.filter((r) => r.rank && r.rank <= 3).length}/${golden.results.length}` : "")
);
