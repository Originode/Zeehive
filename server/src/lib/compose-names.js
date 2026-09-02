// WHAT WILL DOCKER ACTUALLY CALL THIS CONTAINER?
//
// The meta-DB names a per-xell container from the project's naming template
// (manifest naming.container, e.g. "omnibiz_spin_{role}_{slug}"). That is a GUESS about a file the
// project owns: when the spinoff compose pins `container_name:`, THAT is the name docker creates,
// and the template is only right by coincidence.
//
// omnibiz, 2026-09-02 — the coincidence ran out:
//
//   compose:  webapp: container_name: omnibiz_spin_web_${SPINOFF_SLUG}
//   meta-DB:  omnibiz_spin_webapp_<slug>
//
// The health monitor matches a row to a real container by zeehive labels first and by NAME as the
// fallback (queenzee/containers.js matchState) — and omnibiz's spinoff compose sets no labels. So
// every omnibiz webapp row read 'down' forever, minutes after its own build reported success:
// app-serve:webapp could never pass, the readiness proof could never say 'ok', and `docker exec`
// from the console addressed a container that does not exist. The container was up the whole time.
//
// This resolves the compose file's own answer. It is deliberately CONSERVATIVE: a service with no
// container_name, an interpolation we cannot resolve, or YAML we cannot parse all return null —
// "I don't know", which leaves the template's name exactly as it was. A wrong guess here would
// rename a row away from a container that IS being found.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

// Compose's ${VAR}, ${VAR:-default}, ${VAR-default} and $VAR, resolved against `vars` ONLY (never
// process.env — the build runs with a different environment than this projector). An unresolvable
// reference makes the whole name unknown rather than half-interpolated.
export function interpolate(text, vars = {}) {
  const src = String(text ?? '');
  let unresolved = false;
  const lookup = (name, op, def) => {
    const v = vars[name];
    const has = v != null && v !== '';
    if (has) return String(v);
    if (op && (op === ':-' || op === '-')) return String(def ?? '');
    unresolved = true;
    return '';
  };
  const out = src
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(:?[-?])?([^}]*)\}/g, (_, name, op, def) => lookup(name, op, def))
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => lookup(name, null, null));
  return unresolved ? null : out;
}

// The literal container name a compose file pins for `service`, or null when it pins none / cannot
// be resolved. Never throws.
export function composeContainerName(composeYaml, service, vars = {}) {
  if (!composeYaml || !service) return null;
  let doc = null;
  try { doc = parse(String(composeYaml)); } catch { return null; }
  const pinned = doc?.services?.[service]?.container_name;
  if (!pinned || typeof pinned !== 'string') return null;
  const name = interpolate(pinned, vars);
  return name && name.trim() ? name.trim() : null;
}

// Same answer, read from a worktree. `composeRel` is the row's/manifest's compose path. Absent
// file → null (a build would fail on that separately, with its own message).
export function composeContainerNameFor({ worktree, composeRel, service, slug }) {
  try {
    if (!worktree || !composeRel || !service) return null;
    const abs = resolve(String(worktree).replace(/\\/g, '/'), composeRel);
    if (!existsSync(abs)) return null;
    return composeContainerName(readFileSync(abs, 'utf8'), service, { SPINOFF_SLUG: slug });
  } catch { return null; }
}
