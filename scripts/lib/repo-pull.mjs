// Bring each indexed repo up to date before the sync reads it.
//
// The sync reads files as they sit on this desktop. Work done on the laptop and pushed
// never reached the brain until someone pulled here by hand, which defeats the point of a
// brain shared across machines. So each scheduled run pulls first, but only where that
// cannot touch local work:
//
//   - A repo with uncommitted changes to tracked files is fetched, never pulled. The fetch
//     only updates remote-tracking refs, so it is safe, and it lets the report say how far
//     behind that repo is.
//   - A clean repo is pulled with --ff-only, which refuses rather than merges when the
//     histories have diverged.
//   - No prompts: a repo that needs credentials fails fast and is reported.

import { execFileSync } from "node:child_process";
import { sources } from "../../sources.mjs";

const TIMEOUT_MS = 60_000;

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TIMEOUT_MS,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

// The distinct git repos behind the sources.mjs rules (several Command Center rules share one).
export function indexedRepos() {
  const tops = new Set();
  for (const rule of sources) {
    if (!rule.root) continue;
    const top = tryGit(rule.root, ["rev-parse", "--show-toplevel"]);
    if (top) tops.add(top);
  }
  return [...tops];
}

// Returns one result per repo: { repo, result, behind, detail }, where result is
// "updated", "current", "dirty" (fetched, not pulled), "no-upstream" or "failed".
export function pullRepos() {
  const results = [];
  for (const repo of indexedRepos()) {
    const name = repo.split("/").pop();
    if (!tryGit(repo, ["rev-parse", "--abbrev-ref", "@{u}"])) {
      results.push({ repo: name, result: "no-upstream", behind: null });
      continue;
    }
    try {
      git(repo, ["fetch", "--quiet"]);
      const behind = Number(git(repo, ["rev-list", "--count", "HEAD..@{u}"]));
      const dirty = git(repo, ["status", "--porcelain", "--untracked-files=no"]) !== "";
      if (dirty) {
        results.push({ repo: name, result: "dirty", behind });
      } else if (behind === 0) {
        results.push({ repo: name, result: "current", behind: 0 });
      } else {
        git(repo, ["pull", "--ff-only", "--quiet"]);
        results.push({ repo: name, result: "updated", behind: 0, detail: `${behind} commit(s) pulled` });
      }
    } catch (err) {
      const detail = (err.stderr?.toString() || err.message).trim().split("\n").pop();
      results.push({ repo: name, result: "failed", behind: null, detail });
    }
  }
  return results;
}
