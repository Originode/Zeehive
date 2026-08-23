// SHIP-FAILURE CLASSIFIER — turn a failed ship's raw output into a one-line cause (ticket #58).
//
// A failed ship_request stores the raw docker tail in `error` and `containers[].log` — that STAYS,
// the evidence is never replaced — but a 400-character tail of "#8 [5/6] COPY . . #8 CACHED" does
// not tell a human reading the card WHY the deploy failed, and it does not tell a zee what to fix.
// This classifies the raw output into a small stable vocabulary (image-pull, npm-install,
// migration-refused, health-check, disk, other) plus the ONE line that identifies it, so the card
// and the forwarded report can say the cause instead of handing out a log to scroll.
//
// PURE — no I/O. The queenzee calls it at failure time to store failure_cause / failure_line on the
// row; the web renders the STORED cause (it never reclassifies, so the record and the card cannot
// disagree). Exported for tests. Matches against the real text the deploy path actually produces
// (the shipmigrate refusal sentences, docker build/npm error shapes) — not a vocabulary invented
// for the classifier.

export const SHIP_FAILURE_CAUSES = [
  'image-pull',
  'npm-install',
  'migration-refused',
  'health-check',
  'disk',
  'other',
];

// Order matters: FIRST MATCH WINS, so migration-refused must come before the generic docker/npm
// patterns it also contains, and the distinctive causes before the catch-all.
const RULES = [
  // The 5+3 knowable-at-request-time failures (ticket #58) plus the ledger's own words.
  { cause: 'migration-refused',
    test: (s) => /refus(?:e|ing) to migrate|migration (?:aborted|failed)|ledger (?:unreadable|cannot be read)|cannot (?:create|read) ledger|no prod db container/i.test(s) },
  // A base image the daemon cannot fetch: wrong tag, private repo, registry rate limit.
  { cause: 'image-pull',
    test: (s) => /failed to (?:pull|resolve|get) image|pull access denied|manifest unknown|no matching manifest|image .* not found|toomanyrequests|denied: requested access|unauthorized: authentication required|unexpected status from GET request/i.test(s) },
  // npm resolving/building dependencies — the classic "#N RUN npm ci" step failing.
  { cause: 'npm-install',
    test: (s) => /npm err(?:or)?!|npm error|failed to (?:install|fetch) (?:dependencies|package)|ETARGET|E404|ENOENT.*(?:package|module)|Cannot find module|npm ci failed/i.test(s) },
  // Out of disk — on the daemon or the build cache.
  { cause: 'disk',
    test: (s) => /no space left on device|ENOSPC|filesystem is full|disk (?:is )?full|insufficient (?:disk )?space|out of space|max depth exceeded/i.test(s) },
  // The post-deploy health probe / the process answering its URL.
  { cause: 'health-check',
    test: (s) => /health[- ]?check|is not (?:ready|healthy)|did not become ready|connectivity (?:test|check) failed|unhealthy|curl.*(?:timed out|connection refused)|failed to (?:reach|connect to) .* (?:health|port)|not verifiably up/i.test(s) },
];

// The ONE line that identifies the cause. Among the lines the rule matched, prefer the LAST
// contentful one (≥ 30 chars): a docker log ends with the cause, and the short markers above it
// ("npm ERR! code ETARGET", "#11 [webapp 5/6]") are headers, not verdicts. With no rule (the
// 'other' catch-all), the first non-docker-progress line — docker's "#8 [5/6]" and "--->" noise is
// never a verdict.
function identifyingLine(all, rule) {
  const lines = String(all || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (rule) {
    const matched = lines.filter((l) => rule.test(l));
    if (matched.length) {
      const contentful = matched.filter((l) => l.length >= 30);
      return (contentful[contentful.length - 1] || matched[matched.length - 1]).slice(0, 300);
    }
  }
  const verdict = lines.find((l) => !/^#\d+\s*\[/i.test(l) && !/^\s*--->/i.test(l) && !/ CACHED\s*$/i.test(l));
  return (verdict || lines[0] || '').slice(0, 300);
}

// Classify a failed ship's raw output. `error` is the top-level ship error; `containers` is the
// per-step result array (only the steps with `ok:false` carry failure output worth reading).
// Returns { cause, line } where cause ∈ SHIP_FAILURE_CAUSES and line is the identifying ONE line.
export function classifyShipFailure(input = {}) {
  const { error, containers } = input || {};
  const haystacks = [];
  if (error) haystacks.push(String(error));
  for (const c of (Array.isArray(containers) ? containers : [])) {
    if (c && c.ok === false) {
      if (c.error) haystacks.push(String(c.error));
      if (c.log) haystacks.push(String(c.log));
    }
  }
  const all = haystacks.join('\n');
  for (const rule of RULES) {
    if (rule.test(all)) return { cause: rule.cause, line: identifyingLine(all, rule) };
  }
  return { cause: 'other', line: identifyingLine(all, null) };
}
