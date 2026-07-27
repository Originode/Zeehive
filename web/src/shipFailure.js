// SHIP-FAILURE report — the pure text-assembly behind the failed-ship "📨 Forward build output to
// the zee" button (Ship.jsx). Kept out of the JSX component so it can be unit-tested in plain node
// (no React/DOM), and so the "what do we hand the zee" contract lives in one place.
//
// A ship the queenzee ran and that FAILED carries its diagnosis in two places: a top-level `error`
// and a per-container `containers[]` list where each failed step has an `error` and/or the captured
// build `log`. This flattens exactly that — and nothing else — into a plain-text body the zee can
// read verbatim in its .zee-inbox, so the operator forwards the real output instead of retyping it.

const short = (s) => (s ? String(s).slice(0, 8) : '—');

// Is there anything a failed ship could forward? (a top-level error, or any failed step with output)
export function shipHasFailureOutput(req) {
  if (!req || req.status !== 'failed') return false;
  if (req.error) return true;
  return Array.isArray(req.containers) && req.containers.some((r) => !r.ok && (r.error || r.log));
}

// The message body: the same failure information the ship card shows, laid out for the zee to act on.
export function shipFailureReport(req) {
  if (!req) return '';
  const lines = [
    `Ship of ${short(req.commit)} to production${req.site_key ? ` @ ${req.site_key}` : ''} FAILED.`,
    '',
  ];
  if (req.error) lines.push(`Error: ${req.error}`, '');
  const steps = Array.isArray(req.containers) ? req.containers : [];
  for (const r of steps) {
    if (r.ok) continue; // only the steps that failed carry output worth forwarding
    lines.push(`── ${r.role || r.container || 'step'}${r.method ? ` (${r.method})` : ''} ──`);
    if (r.error) lines.push(r.error);
    if (r.log) lines.push('', '```', String(r.log).trim(), '```');
    lines.push('');
  }
  lines.push('Please read the build output above, fix the cause in this xell, then re-land and re-ship.');
  return lines.join('\n');
}
