// THIS XELL'S STACK, AS MARKDOWN — the inventory appended to every generated entry-point doc.
//
// An agent arriving in a xell needs two different things. The project's instructions (how this repo
// works) are the same for every xell, and an operator writes them once — that is project_doc.body.
// The other half is the environment it woke up in: which containers are ITS containers, which
// database it holds, which URL its own app is served on, how to build. That half is different for
// every xell and cannot be written by hand.
//
// House rule 7 is the reason this is a function and not a paragraph in the doc: names, containers,
// couplings and status are DATA. A container name typed into prose is stale at the next rebuild, and
// one of those sent zees at an exited husk for weeks. So the section below is GENERATED from the
// meta-DB at injection time, points at the commands that re-resolve it live (`zee status`), and never
// asks the reader to trust a name it printed once.
//
// It is deliberately NOT a second briefing. The binding a zee is spawned with (queenzee/intake.js
// bindingFor) remains the authoritative, exhaustive one; this is the short inventory a NON-ZEEHIVE
// agent — Cursor, Copilot, Codex — would otherwise have no way to know, sitting in the file that
// agent actually opens.
import { q, one } from '../db/pool.js';
import { resolveRealDbContainerCached } from './xell-db.js';
import { cloneInstanceFor } from './db-instances.js';

// Never print a conn_ref or DSN: those can carry a password, and this text lands in a file inside a
// workspace an agent may quote back into a diff, a log or a chat. The address is enough to reach a
// container; the credential lives in .zeehive.env, which is generated and git-excluded.
const addressOf = (c) => (c.host && c.host_port ? `${c.host}:${c.host_port}`
  : c.host_port ? `localhost:${c.host_port}` : '—');

const COUPLING_NOTE = {
  'db-isolated': 'your OWN throwaway container, restored from a dump — migrate, seed or destroy it '
    + 'freely; nothing you do to it touches dev or prod.',
  'db-clone': 'your OWN clone inside the shared dev postgres — free to migrate/seed/destroy, but '
    + 'always connect to YOUR database by name (the container default is the SHARED dev db, whose '
    + 'schema is frozen).',
  'db-shared-dev': 'the SHARED dev database. Never run DDL against it — its schema is frozen, and '
    + "ad-hoc DDL there trips every other xell's ship gate.",
  'db-shared-prod': '⚠ THE LIVE PRODUCTION DATABASE, writable. A human deliberately assigned it. '
    + 'Reads are free; before ANY write or migration, state exactly what it will change and get a '
    + 'human to agree. Schema changes are refused outright — they go through a landed migration.',
  'db-prod-readonly': 'THE LIVE PRODUCTION DATABASE, READ-ONLY — postgres itself refuses every write '
    + 'and every DDL. Read it freely; production data changes go through a landed, human-approved seed.',
};

// The markdown appendix for one xell, or null when the xell cannot be resolved (a doc is still
// generated in that case — an entry-point file with no stack section beats no file at all).
export async function xellStackMarkdown(xellId, { cxell = true } = {}) {
  if (!xellId) return null;
  const xell = await one(
    `SELECT x.slug, x.branch, x.db_coupling, x.source_coupling, x.zee_type, x.is_production,
            xo.ref AS source_ref
       FROM xell x LEFT JOIN xource xo ON xo.id = x.xource_id
      WHERE x.id = $1`, [xellId]);
  if (!xell) return null;
  const rows = await q(
    `SELECT c.role, c.name, c.url, c.tier, c.docker_ctx, host(c.host) AS host, c.host_port
       FROM xell_uses_container uc JOIN container c ON c.id = uc.container_id
      WHERE uc.xell_id = $1 ORDER BY c.role`, [xellId]);
  // Resolved at the boundary, exactly as bindingFor does it: the row carries a LOGICAL db container
  // name and the daemon runs a versioned one, so the raw name can be an exited husk holding the old
  // volume. Cheap and non-blocking — it serves the logical name and refreshes in the background.
  const stack = rows.map((c) => (c.role === 'db'
    ? { ...c, name: resolveRealDbContainerCached(c.docker_ctx, c.name) } : c));
  const clone = xell.db_coupling === 'db-clone'
    ? (await cloneInstanceFor(xellId).catch(() => null))?.name || null : null;

  const L = [];
  L.push('---');
  L.push('');
  L.push('## Your xell — the stack you actually own');
  L.push('');
  L.push('<!-- GENERATED per xell from the ZEEHIVE meta-DB, alongside the instructions above. Nobody');
  L.push('     wrote this section by hand and no other xell has these values. -->');
  L.push('');
  L.push(`You are working in xell **${xell.slug}** on branch \`${xell.branch}\``
    + `${xell.source_ref ? `, cut from \`${xell.source_ref}\`` : ''}`
    + `${xell.source_coupling ? ` (${xell.source_coupling})` : ''}.`);
  if (xell.zee_type === 'manager') {
    L.push('');
    L.push('This is a **manager** xell: it coordinates other zees and writes no code itself.');
  }
  L.push('');
  if (stack.length) {
    L.push('| role | container | reach | tier |');
    L.push('|---|---|---|---|');
    for (const c of stack) {
      L.push(`| ${c.role} | \`${c.name}\` | ${c.url ? `<${c.url}>` : addressOf(c)} | ${c.tier || '—'} |`);
    }
  } else {
    L.push('_No containers are attached to this xell yet._');
  }
  L.push('');
  const note = COUPLING_NOTE[xell.db_coupling];
  L.push(`- **Database** (\`${xell.db_coupling || 'none'}\`)${clone ? ` — clone \`${clone}\`` : ''}`
    + `${note ? ` — ${note}` : ''}`);
  L.push('  Connect over TCP with `DATABASE_URL` from `.zeehive.env` in the repo root — that file is '
    + 'GENERATED (never edit it) and it also carries this xell\'s ports and safety flags.');
  if (cxell) {
    L.push('- **Build and verify** — build your OWN app tier through the queenzee: `zee build '
      + '[server|webapp|all]`, and `--wait` (in the background) to be told when a container is really '
      + 'serving your HEAD. It builds your COMMITS, so commit first. There is no docker CLI in here, '
      + 'and never hand-roll a poll loop against your own app.');
    L.push('- **Nothing leaves this xell without a human** — `zee land` (push to main), `zee ship` '
      + '(deploy), `zee prod`/`zee seed` (production data) and `zee done` are each only a REQUEST that '
      + 'lands on a human gate. Commit freely; a commit moves only your own branch ref.');
  }
  L.push('- **These are DATA, not documentation** — names, ports, couplings and status live in the '
    + 'meta-DB and change on a rebuild. This section was true when the file was written; '
    + `\`zee status\`${cxell ? '' : ' (or the ZEEHIVE console)'} re-resolves it live, and it is the `
    + 'answer if anything above disagrees with what you find.');
  if (xell.is_production || xell.db_coupling === 'db-shared-prod') {
    L.push('- ⚠ **This xell touches PRODUCTION.** Treat every write as irreversible and get a human '
      + 'to agree before making one.');
  }
  L.push('');
  return L.join('\n');
}
