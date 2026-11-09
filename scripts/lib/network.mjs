// Network readiness for the scheduled scripts.
//
// Windows runs a missed task the moment the machine wakes (StartWhenAvailable), which
// is often before DNS works. That is what most scheduled-sync failures turned out to
// be: `getaddrinfo ENOTFOUND` seconds after wake, followed by a full day with no sync.
//
// This file imports nothing from the sync path, so keep-warm can use it and stay
// independent of the manifest and the embedding API.

import { lookup } from "node:dns/promises";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves once `host` has an address, or when the timeout runs out. Never throws:
// callers decide what a missing network means for them.
export async function waitForDns(host, { timeoutMs = 300_000, intervalMs = 15_000 } = {}) {
  const started = Date.now();
  for (;;) {
    try {
      await lookup(host);
      return { ok: true, waitedMs: Date.now() - started, error: null };
    } catch (err) {
      const waitedMs = Date.now() - started;
      if (waitedMs + intervalMs > timeoutMs) return { ok: false, waitedMs, error: err.code || err.message };
      await sleep(intervalMs);
    }
  }
}

const NETWORK_FAILURE =
  /ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_|fetch failed/;

// Only network-shaped failures are worth retrying. A bad manifest entry would fail the
// same way every time, so retrying it would only hide it.
export function isNetworkFailure(text) {
  return NETWORK_FAILURE.test(text);
}
