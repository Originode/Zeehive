// LANGFUSE PLUGIN — ONE system-wide observability stack (user ruling: "there should only be one
// langfuse instance for the whole system").
//
// Langfuse (langfuse.com/self-hosting) is a self-hosted LLM observability stack: web UI + worker
// + postgres + clickhouse + redis + minio. It is NOT a transparent proxy — traffic reaches it as
// SDK-level traces or, deterministically here, as POSTs to its public ingestion API. ZEEHIVE's
// integration is the honest version of "route agents there":
//
//   (A) PROVISION — a human clicks Setup in the console; this module docker-composes the single
//       stack (docker/zeehive/docker-compose.langfuse.yml) ONCE, generates every secret, records
//       them + the trace project keys in langfuse_config (migration 114), and seeds the Langfuse
//       admin + project via LANGFUSE_INIT_*. Mode-gated exactly like lib/devices.js: PROVISION_MODE
//       real runs docker; simulate models the row so tests exercise the rest of the system.
//
//   (B) ROUTE — every cxell zee gets LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY / LANGFUSE_BASE_URL
//       injected into its env at spawn (queenzee/intake.js merges langfuseClientEnv() into the
//       agent env), so anything in the cage that speaks Langfuse (a manager's curl to the public
//       API, a worker's instrumentation) is pointed at the instance. The CLIs themselves are not
//       re-aimed at a gateway in v1 — a gateway needs per-provider passthrough config and would
//       fight the deepseek adapter's own ANTHROPIC_BASE_URL; the queenzee's own ingestion POST
//       (C) records every provider equally and deterministically.
//
//   (C) RECORD — when a zee finishes a turn, the queenzee POSTs a Langfuse trace (session, model,
//       token usage, cost) to /api/public/ingestion, best-effort. When a conversation is archived,
//       it is linked into a trace too. This is the token-burn + conversation record the task asks
//       for, and it is what managers analyze via the public API.
//
//   (D) SURFACE — the console panel (web/src/LangfusePanel.jsx) reads langfuseConfig() (masked),
//       provisions/tears down, and offers the web UI link. Managers get the LANGFUSE_* env + a
//       manual note (migration 114) telling them the one curl to analyze their crew.
//
// The config row is the source of truth; nothing here reads the filesystem for state. The compose
// file is the only repo file this module needs, resolved from config.repoRoot (the server's own
// tree, like the other provision scripts).
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { q, one } from '../db/pool.js';
import { config } from '../config.js';
import { broadcast } from './events.js';
import { logline } from './logbus.js';
import { resolveBash } from './bash.js';

const MODE = process.env.PROVISION_MODE === 'real' ? 'real' : 'simulate';

// ── constants ────────────────────────────────────────────────────────────────
export const LANGFUSE_COMPOSE = 'docker/zeehive/docker-compose.langfuse.yml';
export const LANGFUSE_PROJECT = 'zeehive-langfuse';          // compose project name (namespaces volumes)
export const LANGFUSE_WEB_PORT = Number(process.env.LANGFUSE_PORT) || 3000;
export const LANGFUSE_MINIO_PORT = Number(process.env.LANGFUSE_MINIO_PORT) || 9090;
export const LANGFUSE_ORG_NAME = process.env.LANGFUSE_ORG_NAME || 'ZeeHive';
export const LANGFUSE_CTX = process.env.LANGFUSE_DOCKER_CTX || 'default';
// How the queenzee reaches the web port, and how a cxell does.
//
// The queenzee-facing base (base_url) is what the queenzee itself uses to POST traces and probe
// health. It must resolve from WHICHEVER process the queenzee is: a host process sees the
// published port on localhost, but a CONTAINERIZED queenzee (repo_root=/repos/...) sees its own
// localhost, not the host's. `host.docker.internal` is the one name that resolves from BOTH — a
// Docker Desktop host process maps it to 127.0.0.1, and inside a container it reaches the host
// gateway. So the queenzee-facing base defaults to host.docker.internal too (override with
// LANGFUSE_BASE_URL). The cxell-facing base is host.docker.internal always (the cxell's door to
// the queenzee's host is the same magic DNS). Each takes the resolved host port (custom port).
const queenzeeWebHost = (port = LANGFUSE_WEB_PORT) => process.env.LANGFUSE_BASE_URL
  || `http://host.docker.internal:${port}`;
const clientWebHost = (port = LANGFUSE_WEB_PORT) => `http://host.docker.internal:${port}`;
// A containerized queenzee's own localhost is its empty loopback — reconcileLangfuseBaseUrl() uses
// this to heal rows provisioned before the queenzee-facing base_url became container-aware.
const inContainer = existsSync('/.dockerenv');

const hint = (t) => (t ? `${t.slice(0, 6)}…${t.slice(-4)}` : null);

const rand = (bytes) => randomBytes(bytes).toString('hex');
const lfKey = (prefix) => `${prefix}-lf-${randomBytes(24).toString('base64url')}`;

// Validators for the human-supplied provisioning knobs (custom port + org name).
export function resolvePort(v) {
  if (v === undefined || v === null || v === '') return LANGFUSE_WEB_PORT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`invalid Langfuse web port "${v}" — must be an integer 1..65535`);
  }
  return n;
}
export function resolveOrg(v) {
  if (v === undefined || v === null || v === '') return LANGFUSE_ORG_NAME;
  const s = String(v).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9 _-]{0,79}$/.test(s)) {
    throw new Error(`invalid org name "${s}" — 1..80 chars, letters/digits/space/_/-`);
  }
  return s;
}
// org id = the slug Langfuse's LANGFUSE_INIT_ORG_ID expects (lowercase, dashes).
const orgId = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'zeehive';

// ── read model (the console's door — masked, provider-token discipline) ──────
export async function langfuseConfig() {
  const row = await one(`SELECT * FROM langfuse_config WHERE id = true`);
  if (!row) return { enabled: false, status: 'off' };
  return {
    enabled: row.enabled,
    status: row.status,
    error: row.error,
    docker_ctx: row.docker_ctx,
    host_port: row.host_port,
    minio_port: row.minio_port,
    base_url: row.base_url,                 // queenzee-facing (ingestion + public API)
    client_base_url: row.client_base_url,   // cxell-facing (LANGFUSE_BASE_URL)
    ui_url: row.ui_url,                     // human-facing (console link)
    public_key_hint: row.public_key_hint,
    secret_key_hint: row.secret_key_hint,
    org_name: row.org_name,
    org_public_key_hint: row.org_public_key_hint,
    org_secret_key_hint: row.org_secret_key_hint,
    admin_email: row.admin_email,
    admin_name: row.admin_name,
    admin_password_hint: row.admin_password_hint,
    gateway_url: row.gateway_url,
    system_project_id: row.system_project_id,   // stored system trace project id (TKT-127)
    provisioned_at: row.provisioned_at,
    updated_at: row.updated_at,
    mode: MODE,
  };
}

// ── the env injected into EVERY cxell (spawnCxell merges this into agentEnv) ──
// With a projectId, a 1:1-mapped ZEEHIVE project gets ITS OWN Langfuse keys (its own Langfuse
// project scope); without a mapping (or without a projectId) it falls back to the system trace
// project's keys. All existing callers keep working (no arg → system keys).
//
// `tracking` is the per-xell Langfuse tracking switch (xell.langfuse_tracking, default ON): when a
// xell has opted OUT, no LANGFUSE_* env is injected into its cage at all. spawnCxell passes the
// xell's flag; the console/test can assert the OFF side directly.
export async function langfuseClientEnv(projectId = null, { tracking = true } = {}) {
  if (!tracking) return {};   // per-xell switch OFF — this cage gets no LANGFUSE_*
  const c = await langfuseConfig();
  if (!c.enabled || !c.public_key_hint) return {};
  const row = await one(`SELECT public_key, secret_key, client_base_url FROM langfuse_config WHERE id = true`);
  if (!row?.public_key || !row?.secret_key) return {};
  let pub = row.public_key, sec = row.secret_key;
  if (projectId) {
    const mapped = await one(
      `SELECT public_key, secret_key FROM langfuse_project_map WHERE project_id=$1`, [projectId]);
    if (mapped?.public_key && mapped?.secret_key) { pub = mapped.public_key; sec = mapped.secret_key; }
  }
  const env = {
    LANGFUSE_PUBLIC_KEY: pub,
    LANGFUSE_SECRET_KEY: sec,
    LANGFUSE_BASE_URL: row.client_base_url || clientWebHost(),
  };
  if (row.gateway_url) env.LANGFUSE_GATEWAY_URL = row.gateway_url;
  return env;
}

// ── self-heal: rows provisioned before the container-aware base_url fix ───────
// Deployments provisioned while the queenzee-facing base_url was always 'localhost' (pre-fix)
// keep a URL the containerized queenzee cannot reach — its own loopback. A queenzee that boots
// in a container and finds a localhost base_url rewrites it to the host.docker.internal door it
// actually uses (or the LANGFUSE_BASE_URL override), so the fix reaches EXISTING rows, not just
// future provisions. Safe: inside a container, localhost:<langfuse port> can never be the
// host-published stack. Best-effort, never throws — boot must not fail on observability.
export async function reconcileLangfuseBaseUrl() {
  if (!inContainer) return null;
  try {
    const row = await one(`SELECT enabled, base_url FROM langfuse_config WHERE id=true`);
    if (!row?.enabled || !row.base_url || !row.base_url.startsWith('http://localhost:')) return null;
    const fixed = queenzeeWebHost();
    if (row.base_url === fixed) return null;
    await q(`UPDATE langfuse_config SET base_url=$1, updated_at=now() WHERE id=true`, [fixed]);
    logline('langfuse', `base_url self-healed: ${row.base_url} → ${fixed} (containerized queenzee reaches langfuse via the host)`);
    return fixed;
  } catch (e) {
    logline('langfuse', `base_url self-heal skipped: ${e.message}`);
    return null;
  }
}

// ── heal: a stack stuck in v4 `events_only` write mode → dual ────────────────
// Langfuse v4 defaults migration write mode to `events_only`, which DISABLES the traces API —
// traces keep flowing in via OTel, but the console's "recent traces" read 404s with the explicit
// events_only message. The provisioner now starts every stack in `dual` (compose default + the
// vars composeEnv passes), but a stack provisioned BEFORE that fix is still running events_only
// with no code path to change it. This heal is the deterministic, no-AI version of "set
// LANGFUSE_MIGRATION_V4_WRITE_MODE=dual and restart".
//
// ⚠ DELIBERATELY NOT automatic at boot. The first version ran at boot and fired `docker compose
// up -d` on the live stack with an INCOMPLETE interpolation env (the container env carries the
// RESOLVED service vars — DATABASE_URL, SALT, … — not the LANGFUSE_* names the compose file
// interpolates), and the compose up FAILED mid-recreate, taking the prod observability stack
// down (measured live 2026-08-03). The heal is therefore a HUMAN-triggered action only (the
// console's "Heal write mode" button / POST /api/langfuse/heal): new stacks are dual by default,
// and flipping an existing stack is a deliberate click. This still reads the RUNNING langfuse-web
// container's env (the only copy of the generated secrets — the config row stores just the trace
// keys + admin login), re-runs `docker compose up -d` with that env mapped back into the
// LANGFUSE_* interpolation names PLUS the two dual vars, and lets compose recreate ONLY
// langfuse-web + langfuse-worker — postgres/clickhouse/redis/minio and every volume are untouched.
// A recreate wipes the docker cp'd auto-login page, so it is re-injected after.
// Best-effort, never throws, mode-gated (simulate → null).
export async function reconcileLangfuseWriteMode({ force = false } = {}) {
  if (MODE !== 'real') return null;   // nothing is running in simulate
  try {
    const row = await one(`SELECT enabled FROM langfuse_config WHERE id=true`);
    if (!row?.enabled) return null;
    const container = await langfuseWebContainer();
    if (!container) return null;
    const env = await containerEnv(container);
    if (!env) return null;
    // Langfuse v4's own default is events_only when the var is absent — that IS the stuck state.
    const mode = env.LANGFUSE_MIGRATION_V4_WRITE_MODE || 'events_only';
    if (!force && mode === 'dual') return null;
    // Reconstruct the compose INTERPOLATION env from the container env: the container holds the
    // RESOLVED service values (DATABASE_URL, SALT, ENCRYPTION_KEY, REDIS_AUTH, …), but the compose
    // file interpolates the LANGFUSE_* names. Passing the raw container env made compose up fail
    // (undefined LANGFUSE_DATABASE_URL / LANGFUSE_SALT / …) and took the stack down — map them back.
    const next = { ...composeEnvFromContainer(env),
      LANGFUSE_MIGRATION_V4_WRITE_MODE: 'dual',
      LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN: 'true',
    };
    const r = await composeUp(next);
    if (!r.ok) {
      logline('langfuse', `write-mode self-heal failed: compose up → ${r.err}`);
      return { ok: false, err: r.err };
    }
    // The recreate replaced langfuse-web with a fresh container — the auto-login page (docker cp'd
    // into the old one's writable layer) is gone, so re-inject + restart it.
    await injectAutoLoginPage();
    probeLangfuseSoon();   // flips status → 'up'/'down' once the recreated web answers
    logline('langfuse', `write mode self-healed: ${mode} → dual (langfuse-web + worker recreated with the dual env; traces API re-enabled)`);
    return { ok: true, from: mode, to: 'dual' };
  } catch (e) {
    logline('langfuse', `write-mode self-heal skipped: ${e.message}`);
    return null;
  }
}

// Map a container's RESOLVED env back to the LANGFUSE_* names docker compose interpolates. A
// running langfuse-web's `.Config.Env` holds the compose `environment:` block with values already
// filled in (DATABASE_URL, SALT, ENCRYPTION_KEY, REDIS_AUTH, CLICKHOUSE_*, the LANGFUSE_S3_*/INIT_*
// keys) — but the compose file's `${LANGFUSE_*}` references need the SOURCE names. Pure function,
// exported for the test. Keys already named LANGFUSE_* pass through unchanged; resolved service
// keys are reverse-mapped; a value that exists under neither stays absent (compose falls back to
// its `${VAR:-default}`).
export function composeEnvFromContainer(containerEnv) {
  const env = {};
  for (const [k, v] of Object.entries(containerEnv)) {
    if (k.startsWith('LANGFUSE_')) env[k] = v;
  }
  const take = (from, to) => { if (containerEnv[from] !== undefined) env[to] = containerEnv[from]; };
  // resolved service env → the interpolation name the compose file references
  take('NEXTAUTH_URL', 'LANGFUSE_NEXTAUTH_URL');
  take('NEXTAUTH_SECRET', 'LANGFUSE_NEXTAUTH_SECRET');
  take('SALT', 'LANGFUSE_SALT');
  take('ENCRYPTION_KEY', 'LANGFUSE_ENCRYPTION_KEY');
  take('DATABASE_URL', 'LANGFUSE_DATABASE_URL');
  take('CLICKHOUSE_MIGRATION_URL', 'LANGFUSE_CLICKHOUSE_MIGRATION_URL');
  take('CLICKHOUSE_URL', 'LANGFUSE_CLICKHOUSE_URL');
  take('CLICKHOUSE_USER', 'LANGFUSE_CLICKHOUSE_USER');
  take('CLICKHOUSE_PASSWORD', 'LANGFUSE_CLICKHOUSE_PASSWORD');
  take('REDIS_HOST', 'LANGFUSE_REDIS_HOST');
  take('REDIS_PORT', 'LANGFUSE_REDIS_PORT');
  take('REDIS_AUTH', 'LANGFUSE_REDIS_AUTH');
  // the S3/media upload block resolves the MINIO_/S3_ source vars into LANGFUSE_S3_* keys
  take('LANGFUSE_S3_EVENT_UPLOAD_BUCKET', 'LANGFUSE_S3_BUCKET');
  take('LANGFUSE_S3_EVENT_UPLOAD_REGION', 'LANGFUSE_S3_REGION');
  take('LANGFUSE_S3_EVENT_UPLOAD_ACCESS_KEY_ID', 'LANGFUSE_MINIO_USER');
  take('LANGFUSE_S3_EVENT_UPLOAD_SECRET_ACCESS_KEY', 'LANGFUSE_MINIO_PASSWORD');
  take('LANGFUSE_S3_EVENT_UPLOAD_ENDPOINT', 'LANGFUSE_S3_INTERNAL_ENDPOINT');
  take('LANGFUSE_S3_MEDIA_UPLOAD_ENDPOINT', 'LANGFUSE_S3_MEDIA_ENDPOINT');
  // the init-user block resolves the public/secret trace keys into LANGFUSE_INIT_* keys
  take('LANGFUSE_INIT_PROJECT_PUBLIC_KEY', 'LANGFUSE_PUBLIC_KEY');
  take('LANGFUSE_INIT_PROJECT_SECRET_KEY', 'LANGFUSE_SECRET_KEY');
  return env;
}

// Read a running container's full env via `docker inspect` — the authoritative record of the
// generated secrets (compose interpolates them from the process env at `up`, and the config row
// stores only the trace keys + admin login). Plain object, or null on failure (never throws).
function containerEnv(container) {
  return new Promise((res) => {
    const p = spawn('docker',
      ['--context', LANGFUSE_CTX, 'inspect', '--format', '{{json .Config.Env}}', container],
      { windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => {
      try {
        const env = {};
        for (const e of JSON.parse(out.trim())) {
          const i = e.indexOf('=');
          if (i > 0) env[e.slice(0, i)] = e.slice(i + 1);
        }
        res(env);
      } catch { res(null); }
    });
    p.on('error', () => res(null));
  });
}

// ── provisioning ──────────────────────────────────────────────────────────────
// Generate every secret the compose file interpolates. Deterministic shape, fresh each provision.
// The init-user block seeds the admin login + org + the trace project whose keys this module
// records. Takes the resolved custom port + org name.
export function composeEnv({ publicKey, secretKey, port, org }) {
  const postgresPw = rand(16), clickPw = rand(16), redisPw = rand(16), minioPw = rand(16);
  return {
    LANGFUSE_WEB_PORT: String(port),
    LANGFUSE_MINIO_PORT: String(LANGFUSE_MINIO_PORT),
    // NEXTAUTH_URL is what LANGFUSE ITSELF serves redirects on — the human-facing URL, which on
    // a container publishing :port is the host's localhost (or LANGFUSE_UI_URL). NOT the
    // queenzee-facing base.
    LANGFUSE_NEXTAUTH_URL: process.env.LANGFUSE_UI_URL || `http://localhost:${port}`,
    LANGFUSE_NEXTAUTH_SECRET: rand(32),
    LANGFUSE_SALT: rand(16),
    LANGFUSE_ENCRYPTION_KEY: rand(32),
    LANGFUSE_DATABASE_URL: `postgresql://postgres:${postgresPw}@postgres:5432/langfuse`,
    LANGFUSE_POSTGRES_PASSWORD: postgresPw,
    LANGFUSE_CLICKHOUSE_MIGRATION_URL: `clickhouse://clickhouse:9000`,
    LANGFUSE_CLICKHOUSE_URL: `http://clickhouse:8123`,
    LANGFUSE_CLICKHOUSE_USER: 'clickhouse',
    LANGFUSE_CLICKHOUSE_PASSWORD: clickPw,
    LANGFUSE_REDIS_AUTH: redisPw,
    LANGFUSE_MINIO_USER: 'minio',
    LANGFUSE_MINIO_PASSWORD: minioPw,
    LANGFUSE_S3_BUCKET: 'langfuse',
    // v4 migration write mode: dual keeps the traces API enabled (see the compose file). Provisioned
    // explicitly so the STORED provision env and the compose default never disagree.
    LANGFUSE_MIGRATION_V4_WRITE_MODE: process.env.LANGFUSE_MIGRATION_V4_WRITE_MODE || 'dual',
    LANGFUSE_MIGRATION_V4_ALLOW_PREVIEW_OPT_IN: 'true',
    LANGFUSE_INIT_ORG_ID: orgId(org),
    LANGFUSE_INIT_ORG_NAME: org,
    LANGFUSE_INIT_PROJECT_ID: 'zeehive',
    LANGFUSE_INIT_PROJECT_NAME: 'ZeeHive',
    LANGFUSE_INIT_USER_EMAIL: process.env.LANGFUSE_ADMIN_EMAIL || 'admin@zeehive.local',
    LANGFUSE_INIT_USER_NAME: process.env.LANGFUSE_ADMIN_NAME || 'ZeeHive Admin',
    LANGFUSE_INIT_USER_PASSWORD: process.env.LANGFUSE_ADMIN_PASSWORD || `Zee${rand(10)}!`,
    LANGFUSE_PUBLIC_KEY: publicKey,
    LANGFUSE_SECRET_KEY: secretKey,
  };
}

// Provision the single Langfuse stack. Mode-gated: PROVISION_MODE real runs docker compose,
// simulate records the modeled config so routes/tests work. Returns the masked config.
// Never leaves a partial state: on a real-mode compose failure the row is rolled back to off.
// Custom knobs: hostPort (web port), orgName (Langfuse org), and — for the 1:1 project mapping —
// orgPublicKey/orgSecretKey (an ORG-SCOPED Langfuse API key, without which provisioning keeps the
// single system trace project and no per-project map is created).
export async function provisionLangfuse({ by = 'human@console', hostPort = null, orgName = null,
                                           orgPublicKey = null, orgSecretKey = null } = {}) {
  const cur = await langfuseConfig();
  if (cur.enabled) {
    return { ok: true, message: 'Langfuse is already enabled — no change.', ...(await langfuseConfig()) };
  }
  const port = resolvePort(hostPort);
  const org = resolveOrg(orgName);
  const publicKey = lfKey('pk');
  const secretKey = lfKey('sk');
  const env = composeEnv({ publicKey, secretKey, port, org });
  const adminPassword = env.LANGFUSE_INIT_USER_PASSWORD;
  const baseUrl = queenzeeWebHost(port);
  const clientBaseUrl = clientWebHost(port);
  // The human-facing UI is the HOST's published port — localhost for a human on the machine, or
  // LANGFUSE_UI_URL for a remote/console-facing address.
  const uiUrl = process.env.LANGFUSE_UI_URL || `http://localhost:${port}`;

  const updateRow = {
    enabled: true,
    status: 'provisioning',
    error: null,
    docker_ctx: LANGFUSE_CTX,
    host_port: port,
    minio_port: LANGFUSE_MINIO_PORT,
    compose_project: LANGFUSE_PROJECT,
    base_url: baseUrl,
    client_base_url: clientBaseUrl,
    ui_url: uiUrl,
    org_name: org,
    org_public_key: orgPublicKey || null,
    org_secret_key: orgSecretKey || null,
    org_public_key_hint: orgPublicKey ? hint(orgPublicKey) : null,
    org_secret_key_hint: orgSecretKey ? hint(orgSecretKey) : null,
    public_key: publicKey,
    secret_key: secretKey,
    public_key_hint: hint(publicKey),
    secret_key_hint: hint(secretKey),
    admin_email: env.LANGFUSE_INIT_USER_EMAIL,
    admin_name: env.LANGFUSE_INIT_USER_NAME,
    admin_password: adminPassword,
    admin_password_hint: hint(adminPassword),
    provisioned_at: new Date(),
  };

  if (MODE === 'real') {
    const r = await composeUp(env);
    if (!r.ok) {
      await q(
        `UPDATE langfuse_config SET enabled=false, status='error', error=$2, updated_at=now() WHERE id=true`,
        [false, `provision failed: ${r.err.slice(-400)}`]);
      return { ok: false, error: r.err.slice(-400) };
    }
    await injectAutoLoginPage();   // the same-origin auto-login page, so auto sign-in works
    await persistConfig(updateRow);
    logline('langfuse', `provisioned on ${LANGFUSE_CTX} (compose ${LANGFUSE_PROJECT}) by ${by} — probing…`);
    probeLangfuseSoon();   // flips status → 'up'/'down' in the background, no blocking
    // 1:1 mapping when the human supplied an org-scoped key — create per-project Langfuse projects.
    if (orgPublicKey && orgSecretKey) {
      try { await syncLangfuseProjects({ by }); }
      catch (e) { logline('langfuse', `project sync after provision failed (best-effort): ${e.message}`); }
    }
    return { ok: true, message: `Langfuse provisioned on ${LANGFUSE_CTX} — waiting for it to come up.`, ...(await langfuseConfig()) };
  }

  // simulate: model the row; do NOT claim up. The probe is skipped (nothing is listening); status
  // stays 'provisioning' with a note, exactly like a device emulator's 'unknown' in simulate.
  updateRow.error = `simulate — PROVISION_MODE is ${MODE}; the stack was not started (set PROVISION_MODE=real on the queenzee to provision for real)`;
  await persistConfig(updateRow);
  logline('langfuse', `provisioned (SIMULATED) by ${by} — stack not started; status stays provisioning`);
  return { ok: true, message: 'Langfuse enabled (simulate — the stack was not actually started).', ...(await langfuseConfig()) };
}

async function persistConfig(fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
  const row = await one(
    `UPDATE langfuse_config SET ${sets}, updated_at=now() WHERE id=true RETURNING *`, keys.map((k) => fields[k]));
  broadcast('langfuse', row);
  return row;
}

// docker compose up -d -p <project> -f <compose> with the generated env. The compose file
// interpolates every ${LANGFUSE_*} from the process env docker passes it. Returns { ok, err }.
function composeUp(env) {
  return new Promise((res) => {
    const args = [
      '--context', LANGFUSE_CTX,
      'compose', '-p', LANGFUSE_PROJECT,
      '-f', resolve(config.repoRoot, LANGFUSE_COMPOSE),
      'up', '-d',
    ];
    const p = spawn('docker', args, {
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => res({ ok: false, err: String(e.message) }));
    p.on('close', (code) => res(code === 0 ? { ok: true } : { ok: false, err: (err || out).slice(-500) }));
  });
}

// The running langfuse-web container, found by its image (langfuse/langfuse) — fallback to the
// compose-project name if the lookup fails. Never throws.
async function langfuseWebContainer() {
  try {
    const r = await new Promise((res) => {
      const p = spawn('docker',
        ['--context', LANGFUSE_CTX, 'ps', '--filter', 'name=' + LANGFUSE_PROJECT, '--format', '{{.Names}}'],
        { windowsHide: true });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.on('close', () => res(out.trim().split('\n').find((n) => n.includes('langfuse-web')) || ''));
      p.on('error', () => res(''));
    });
    return r;
  } catch { return ''; }
}

// AUTO LOGIN PAGE INJECTION — docker cp the same-origin auto-login HTML into the langfuse-web
// container's public/generated/ so it is served from the LANGFUSE origin. That origin is the ONLY
// place a credentials POST can carry the CSRF cookie (NextAuth double-submit requires the cookie on
// the same origin the form posts to) — a ZEEHIVE-origin page cannot set it (measured live: the
// cross-origin popup got "?csrf=true"). docker cp is robust: no bind-mount path coordination, works
// from any queenzee (host process or container), and survives a container restart (the file sits on
// the container's writable layer). Best-effort: a failed copy must not fail provisioning — auto
// sign-in degrades to "sign in manually", never breaks the stack.
export async function injectAutoLoginPage() {
  try {
    // The source file can live in EITHER the queenzee image (/app — where the Dockerfile COPYs it)
    // OR the Zeehive project's clone (/repos/Zeehive — the live tree, which has it the moment it's
    // landed on main). Resolve whichever exists so an already-deployed queenzee heals without a
    // full image rebuild.
    const candidates = [
      resolve(config.repoRoot, 'docker/zeehive/langfuse-auto-login.html'),
      ...(process.env.REPOS_DIR ? [resolve(process.env.REPOS_DIR, 'Zeehive', 'docker/zeehive/langfuse-auto-login.html')] : []),
    ];
    const src = candidates.find((p) => existsSync(p));
    if (!src) {
      const err = `auto-login page source not found (tried ${candidates.join(', ')}) — the queenzee image or /repos clone lacks it`;
      logline('langfuse', `auto-login page injection failed: ${err}`);
      return { ok: false, err };
    }
    // The compose container name: `-p <project>` → `<project>-langfuse-web-1` on the default naming.
    // Resolve the running langfuse-web container by its image/label so a renamed container or a
    // one-off `docker run` still finds it.
    const container = await langfuseWebContainer() || `${LANGFUSE_PROJECT}-langfuse-web-1`;
    // Locate the dir Next.js serves static files from. The langfuse image keeps web/public/ under
    // the app dir, but the exact path depends on the build (plain `next start` → /app/public; a
    // standalone build → /app/.next/standalone/public). We can't guess (both were wrong for the
    // live image). So ASK the container: find any `generated` dir under a `public` dir, or any dir
    // that already holds a known static asset (favicon.ico). Create a `public/generated` in the
    // app root as a last resort (Next.js serves <app>/public even for a fresh dir).
    // Find EVERY dir that holds a served public asset (favicon.ico) — Next may serve from more than
    // one (source web/public vs a standalone copy). We inject into each `*/generated` beside one, so
    // whichever Next actually serves gets the page. If none is found, fall back to any `*/public`.
    const mkdir = await new Promise((res) => {
      const p = spawn('docker', ['--context', LANGFUSE_CTX, 'exec', container, '/bin/sh', '-c',
        'dirs=$(find / -maxdepth 8 -type f -name favicon.ico 2>/dev/null | xargs -r -n1 dirname | sort -u); '
        + 'if [ -z "$dirs" ]; then '
        + '  dirs=$(find / -maxdepth 8 -type d -path "*/public" 2>/dev/null); '
        + '  [ -z "$dirs" ] && dirs=/app/public && mkdir -p /app/public; '
        + 'fi; '
        + 'for d in $dirs; do mkdir -p "$d/generated"; done; '
        + 'echo "$dirs" | while read d; do echo "$d/generated"; done'],
        { windowsHide: true });
      let out = '', err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', () => res(out.trim().split('\n').filter(Boolean) || (err.trim() ? [`__exec_err__:${err.trim().slice(0, 200)}`] : [])));
      p.on('error', (e) => res([`__exec_err__:${String(e.message)}`]));
    });
    if (!mkdir.length || mkdir[0].startsWith('__exec_err__')) {
      const err = mkdir[0]?.startsWith('__exec_err__') ? mkdir[0].slice('__exec_err__:'.length) : 'no public dir found';
      logline('langfuse', `auto-login page injection failed: docker exec into ${container} → ${err}`);
      return { ok: false, err: `docker exec into ${container}: ${err}` };
    }
    // docker cp into EVERY discovered `public/generated` (whichever Next serves gets the page).
    let lastErr = null;
    for (const destDir of mkdir) {
      const r = await new Promise((res) => {
        const p = spawn('docker', ['--context', LANGFUSE_CTX, 'cp', src, `${container}:${destDir}/zeehive-auto-login.html`],
          { windowsHide: true });
        let err = '';
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => res(code === 0 ? { ok: true } : { ok: false, err: err.slice(-300) }));
        p.on('error', (e) => res({ ok: false, err: String(e.message) }));
      });
      if (r.ok) logline('langfuse', `auto-login page injected into langfuse-web (${destDir}/zeehive-auto-login.html)`);
      else { lastErr = r.err; logline('langfuse', `auto-login page NOT injected into ${destDir}: ${r.err}`); }
    }
    if (lastErr) return { ok: false, err: lastErr };
    // next start can serve from a file list captured at boot — restart so it re-reads public/ and
    // actually serves the injected page (measured: a runtime-added file 404s until the container
    // restarts). Best-effort; a failed restart is logged, not fatal.
    const restarted = await new Promise((res) => {
      const p = spawn('docker', ['--context', LANGFUSE_CTX, 'restart', container], { windowsHide: true });
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => res(code === 0 ? true : `restart failed: ${err.slice(-200)}`));
      p.on('error', (e) => res(`restart failed: ${e.message}`));
    });
    if (restarted === true) logline('langfuse', `restarted ${container} so Next serves the auto-login page`);
    else logline('langfuse', `auto-login inject done but ${restarted} — the page may 404 until a manual restart`);
    return { ok: true, restarted: restarted === true };
  } catch (e) {
    logline('langfuse', `auto-login page injection failed (best-effort): ${e.message}`);
    return { ok: false, err: e.message };
  }
}

// Teardown: real → compose down -v (removes volumes); both modes clear the sensitive config.
export async function teardownLangfuse({ by = 'human@console' } = {}) {
  const cur = await langfuseConfig();
  if (MODE === 'real' && cur.enabled) {
    const r = await new Promise((res) => {
      const p = spawn('docker',
        ['--context', cur.docker_ctx || LANGFUSE_CTX, 'compose', '-p', cur.compose_project || LANGFUSE_PROJECT,
         '-f', resolve(config.repoRoot, LANGFUSE_COMPOSE), 'down', '-v'],
        { windowsHide: true });
      let out = '', err = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (err += d));
      p.on('close', (code) => res(code === 0 ? { ok: true } : { ok: false, err: (err || out).slice(-400) }));
      p.on('error', (e) => res({ ok: false, err: String(e.message) }));
    });
    if (!r.ok) return { ok: false, error: r.err };
  }
  // Remove every per-project mapping — Langfuse is going away, so the map rows point at nothing.
  await q(`DELETE FROM langfuse_project_map`);
  await q(
    `UPDATE langfuse_config
        SET enabled=false, status='off', error=null, docker_ctx=null, host_port=null, minio_port=null,
            compose_project=null, base_url=null, client_base_url=null, ui_url=null,
            org_name=null, org_public_key=null, org_secret_key=null,
            org_public_key_hint=null, org_secret_key_hint=null,
            public_key=null, secret_key=null, public_key_hint=null, secret_key_hint=null,
            admin_email=null, admin_name=null, admin_password=null, admin_password_hint=null,
            gateway_url=null, system_project_id=null, provisioned_at=null, updated_at=now()
      WHERE id=true`);
  const row = await one(`SELECT * FROM langfuse_config WHERE id=true`);
  broadcast('langfuse', row);
  logline('langfuse', `torn down by ${by}${MODE === 'real' ? ' (compose down -v)' : ' (simulated — nothing was running)'}`);
  return { ok: true, ...(await langfuseConfig()) };
}

// ── health probe ──────────────────────────────────────────────────────────────
// The deterministic "is the web actually up?" oracle, run in the background after provision and on
// demand (langfuseStatus). The official docs: wait ~2-3 min until langfuse-web logs 'Ready'; a
// bounded probe of the public API root is the honest verdict.
//
// ⚠ DELIBERATELY NOT mode-gated. The probe is a READ — an HTTP GET to the base_url — and must
// report what is actually reachable there whether PROVISION_MODE is real or simulate. The mode
// gate belongs on the ACTIONS (docker compose up/down, the auto-login inject, the heal), never on
// "is the instance answering". A queenzee that restarted with PROVISION_MODE not 'real' against a
// LIVE stack (a ship/restart losing the one-shot background probe — measured live 2026-08-04)
// would otherwise report a healthy, trace-ingesting instance as 'provisioning' forever, while
// postTurnToLangfuse (also not mode-gated) keeps POSTing traces to the same base_url.
export async function probeLangfuse() {
  const c = await one(`SELECT enabled, base_url FROM langfuse_config WHERE id=true`);
  if (!c?.enabled || !c.base_url) return c?.enabled ? 'down' : 'off';
  try {
    const r = await fetch(`${c.base_url}/api/public/health`, { signal: AbortSignal.timeout(5000) });
    return r.ok ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

function probeLangfuseSoon() {
  // Not awaited — provisioning returns immediately; the probe flips status when Langfuse answers.
  (async () => {
    // Langfuse takes minutes to migrate its own DB on first boot. Poll up to 4 min (the official
    // guidance is "wait 2-3 minutes"), then record whatever the last probe said. ONLY 'up' ends
    // the wait: a 'down' on first boot is the NORMAL state (the stack is still migrating), so
    // breaking on it would write 'down' seconds after provision and leave the row stuck there
    // even after the instance comes up (sibling of the stale-'provisioning' bug — both are "the
    // stored status is written once and never re-verified"). If it never comes up, the last
    // 'down' is written at the deadline.
    const deadline = Date.now() + 4 * 60 * 1000;
    let status = 'provisioning';
    while (Date.now() < deadline) {
      status = await probeLangfuse();
      if (status === 'up') break;
      await new Promise((r) => setTimeout(r, 5000));
    }
    await q(`UPDATE langfuse_config SET status=$2, updated_at=now() WHERE id=true`, [true, status]);
    // Once the stack answers, learn + store the SYSTEM trace project's id — the "View Langfuse"
    // resolver reads it from the row instead of a live credentialed API call on every request.
    // Best-effort: a failed read leaves system_project_id null and the resolver falls back.
    if (status === 'up') await refreshSystemProjectId();
    const row = await one(`SELECT * FROM langfuse_config WHERE id=true`);
    broadcast('langfuse', row);
    logline('langfuse', `status → ${status}${status === 'up' ? '' : ' — check the queenzee log / docker'}`);
  })();
}

export async function langfuseStatus() {
  const c = await langfuseConfig();
  if (!c.enabled) return { enabled: false, status: 'off' };
  // The LIVE probe is health. The stored `status` column is a provisioning-time field: the
  // one-shot background probe (probeLangfuseSoon) writes it once after provision/heal and can
  // leave it stale — a queenzee that restarted before that probe finished keeps 'provisioning'
  // forever even while the instance is live and ingesting (measured live 2026-08-04). So this
  // read RECONCILES the row: persist an authoritative verdict so the probe's answer reaches the
  // row too. 'provisioning' is left for the background probe to resolve (never clobbered with
  // 'down' mid-boot), but it IS healed forward to 'up' when the instance is genuinely answering.
  const live = await probeLangfuse();
  if (live === 'up' && c.status !== 'up') {
    await q(`UPDATE langfuse_config SET status='up', updated_at=now() WHERE id=true`);
    c.status = 'up';
  } else if (live === 'down' && c.status === 'up') {
    await q(`UPDATE langfuse_config SET status='down', updated_at=now() WHERE id=true`);
    c.status = 'down';
  }
  return { ...c, live };
}

// ── ingestion: the deterministic "route every zee's traffic to Langfuse" ──────
// Langfuse v4's durable door is the OpenTelemetry HTTP endpoint, POST /api/public/otel/v1/traces,
// Basic auth over the trace project keys. The legacy /api/public/ingestion endpoint is DEPRECATED
// and, on a fresh v4 deployment, gated to LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only (it only
// accepts score/log events there — measured live 2026-08-03: trace-create → "Event type not
// accepted"). OTel works in every mode and is the endpoint Langfuse's own docs point new
// integrations at ("Send data via the OpenTelemetry endpoint").
//
// This builder produces an OTLP/HTTP JSON body (OpenTelemetry protobuf-JSON wire format):
//   { resourceSpans: [ { resource: { attributes }, scopeSpans: [ { scope, spans: [ ... ] } ] } ] }
// Each span carries the trace id (hex, 32 chars), the parent/span id, the model call as a
// GENERATION span with token usage, and the xell/zee identity as span attributes. The function is
// PURE so a test can assert the exact payload without a server.
const hex = (n) => Buffer.from(n).toString('hex');
export function buildOtelTrace({ sessionId, model, usage = {}, metadata = {}, input, output,
                                  startTime, endTime, traceId = null, name = null }) {
  const ts = (d) => (d instanceof Date ? d : d || new Date());
  const t0 = ts(startTime), t1 = ts(endTime);
  const id = traceId || `zee-${createHash('sha1').update(`${sessionId || ''}:${t0.toISOString()}`).digest('hex').slice(0, 24)}`;
  // traceId/spanId must be hex strings of the right length for OTel
  const hex32 = String(id).padEnd(32, '0').slice(0, 32).replace(/[^0-9a-f]/g, '0');
  const spanId = hex32.slice(16, 32).padStart(16, '0');
  const u = usage || {};
  const attrs = (obj) => Object.entries(obj || {}).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ({
      key: k,
      value: typeof v === 'boolean' ? { boolValue: v }
        : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v })
        : { stringValue: String(v) },
    }));
  const span = {
    traceId: hex32,
    spanId,
    name: name || `zee turn — ${metadata?.xell_slug || 'unknown'}`,
    startTimeUnixNano: String(Math.round(t0.getTime() * 1e6)),
    endTimeUnixNano: String(Math.round(Math.max(t1.getTime(), t0.getTime()) * 1e6)),
    // sessionId must be emitted under Langfuse's OTel mapping (langfuse.session.id) for the
    // Sessions feature to group traces — a plain `sessionId` attribute is just observation
    // metadata and never appears in the Langfuse UI's Sessions view. (docs: "sessionId via
    // langfuse.session.id or session.id").
    attributes: attrs({ ...(metadata || {}), 'gen_ai.request.model': model, 'langfuse.session.id': sessionId }),
  };
  if (u.input || u.output) {
    span.attributes.push(...[
      { key: 'gen_ai.usage.input_tokens', value: { intValue: String(Number(u.input) || 0) } },
      { key: 'gen_ai.usage.output_tokens', value: { intValue: String(Number(u.output) || 0) } },
    ]);
  }
  if (input !== undefined) span.attributes.push({ key: 'gen_ai.input', value: { stringValue: typeof input === 'string' ? input.slice(0, 4000) : JSON.stringify(input).slice(0, 4000) } });
  if (output !== undefined) span.attributes.push({ key: 'gen_ai.output', value: { stringValue: typeof output === 'string' ? output.slice(0, 4000) : JSON.stringify(output).slice(0, 4000) } });
  return {
    resourceSpans: [{
      resource: { attributes: attrs({ 'service.name': 'zeehive', 'service.version': '1' }) },
      scopeSpans: [{ scope: { name: 'zeehive' }, spans: [span] }],
    }],
  };
}

// The per-xell Langfuse tracking switch (xell.langfuse_tracking, default ON). When OFF the queenzee
// records no trace for this xell's turns. The flag is on the full xell row when the caller has it
// (intake.js passes `xell` straight through); only nudge.js builds a partial xell, so a missing flag
// is looked up from the DB. Best-effort, NEVER throws: a read failure treats the xell as ON rather
// than silently dropping a trace (or sinking a turn).
async function langfuseTrackingEnabled(xell) {
  if (typeof xell?.langfuse_tracking === 'boolean') return xell.langfuse_tracking;
  if (!xell?.id) return true;                    // no xell → nothing to opt out (default ON)
  try {
    const row = await one(`SELECT langfuse_tracking FROM xell WHERE id=$1`, [xell.id]);
    return row ? row.langfuse_tracking !== false : true;
  } catch (e) {
    logline('langfuse', `langfuse_tracking read failed (${e.message}) — treating as ON`);
    return true;
  }
}

// POST a finished turn's trace to Langfuse. Best-effort and NEVER throws: observability must not
// sink a zee's completion. Respects the per-xell switch (default ON), enable + a reachable base
// URL; in simulate or when disabled it is a logged no-op.
export async function postTurnToLangfuse({ xell, zee, sessionId = null, model = null, result = null,
                                            input = null, output = null, startTime = null, endTime = null }) {
  try {
    // PER-XELL SWITCH — checked BEFORE the config read, so an OFF flag costs nothing and a turn on
    // a tracking-off xell is skipped even when the plugin is enabled.
    if (!(await langfuseTrackingEnabled(xell))) return { ok: false, skipped: 'langfuse-tracking-off' };
    const row = await one(
      `SELECT enabled, base_url, public_key, secret_key FROM langfuse_config WHERE id=true`);
    if (!row?.enabled || !row?.public_key || !row?.secret_key) return { ok: false, skipped: 'disabled' };
    // 1:1 mapping: a ZEEHIVE project with a mapped Langfuse project uses ITS OWN keys (its own
    // Langfuse scope). Without a mapping, the system trace project's keys are used.
    let pub = row.public_key, sec = row.secret_key;
    let projectName = null;
    if (xell?.project_id) {
      const mapped = await one(
        `SELECT public_key, secret_key, langfuse_project_name FROM langfuse_project_map WHERE project_id=$1`,
        [xell.project_id]);
      if (mapped?.public_key && mapped?.secret_key) {
        pub = mapped.public_key; sec = mapped.secret_key;
        projectName = mapped.langfuse_project_name;
      }
    }
    const u = (result?.usage) || {};
    const usage = {
      input: Number(u.input_tokens || 0),
      output: Number(u.output_tokens || 0),
      cacheRead: Number(u.cache_read_input_tokens || 0),
      cacheWrite: Number(u.cache_creation_input_tokens || 0),
    };
    // TKT-99-1390: the trace reads the SAME result.usage the zee row reads, so an unmetered turn
    // (no total_cost_usd AND no usage) must be marked here too — otherwise the trace is the second
    // consumer showing silent zeros for a turn that ran and reported nothing. Mirrors usageFrom's
    // metered test so the two consumers can never disagree about which turns were metered.
    const metered = result?.total_cost_usd != null || u?.total_cost_usd != null
      || !!(u && (u.input_tokens != null || u.output_tokens != null
                  || u.cache_read_input_tokens != null || u.cache_creation_input_tokens != null));
    const body = buildOtelTrace({
      sessionId: sessionId || zee?.session_name || zee?.claude_session_id || null,
      model: model || zee?.model || null,
      usage: { ...usage, input: usage.input + usage.cacheRead, output: usage.output + usage.cacheWrite },
      metadata: {
        xell_slug: xell?.slug || null,
        xell_id: xell?.id || null,
        zee_id: zee?.id || null,
        project_id: xell?.project_id || null,
        project_name: projectName || null,
        cost_usd: Number(result?.total_cost_usd ?? 0),
        metered,
        status: result?.is_error ? 'error' : 'ok',
      },
      input,
      output,
      startTime,
      endTime,
    });
    const url = `${row.base_url}/api/public/otel/v1/traces`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${Buffer.from(`${pub}:${sec}`).toString('base64')}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) {
      logline('langfuse', `OTel trace POST to ${url} → ${r.status} (${(await r.text()).slice(0, 200)})`);
      return { ok: false, status: r.status };
    }
    return { ok: true };
  } catch (e) {
    logline('langfuse', `OTel trace POST failed (best-effort): ${e.message}`);
    return { ok: false, error: e.message };
  }
}

// ── THE "VIEW LANGFUSE" LINK — this zee's Langfuse SESSION, for the console ──
// The trace every finished turn posts carries `langfuse.session.id` = the zee's session id
// (claude_session_id / session_name), so the Session view in Langfuse groups that zee's turns. A
// human clicking "View Langfuse" on the flower wants to land ON that session: ui_url + the Langfuse
// project + the session id → /project/<lfProjectId>/sessions/<id>. Pure builder, so a test can
// assert the exact string without a live Langfuse.
export function langfuseSessionUrl({ uiUrl, projectId, sessionId }) {
  const base = String(uiUrl || '').replace(/\/+$/, '');
  if (!base || !projectId || !sessionId) return null;
  return `${base}/project/${encodeURIComponent(String(projectId))}/sessions/${encodeURIComponent(String(sessionId))}`;
}

// Learn the SYSTEM trace project's Langfuse id from the public API — the one place it is defined
// authoritatively (GET /api/public/projects with the trace project keys returns the single project
// those keys scope). Returns { ok:true, projectId } or { ok:false, reason } where reason is:
//   'no-keys'        — the config holds nothing to read with (disabled / never provisioned)
//   'unreachable'    — network failure or non-200 (the instance is not answering healthily)
//   'no-project-id'  — 200 but no project in the body (the keys scope no project)
// Best-effort, NEVER throws: observability must not sink a console request.
async function learnSystemProjectId({ base_url, public_key, secret_key }) {
  if (!base_url || !public_key || !secret_key) return { ok: false, reason: 'no-keys' };
  try {
    const r = await fetch(`${base_url}/api/public/projects`, {
      headers: { authorization: `Basic ${Buffer.from(`${public_key}:${secret_key}`).toString('base64')}` },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      logline('langfuse', `system project id read → HTTP ${r.status}`);
      return { ok: false, reason: 'unreachable', status: r.status };
    }
    const j = await r.json();
    const projectId = j?.data?.[0]?.id || j?.projects?.[0]?.id || null;
    if (!projectId) return { ok: false, reason: 'no-project-id' };
    return { ok: true, projectId };
  } catch (e) {
    logline('langfuse', `system project id read failed (best-effort): ${e.message}`);
    return { ok: false, reason: 'unreachable', error: e.message };
  }
}

// Refresh + persist the stored SYSTEM project id (langfuse_config.system_project_id). Called when
// the stack comes up after provision and by the existing project sync, so the "View Langfuse"
// resolver reads the id from the row instead of a live credentialed API call. Best-effort, never
// throws: a failure leaves the stored value untouched (a null stays null — the resolver falls back
// to the live read, which writes back what it learns). Returns the stored id, or null.
export async function refreshSystemProjectId() {
  try {
    const cfg = await one(`SELECT base_url, public_key, secret_key FROM langfuse_config WHERE id=true`);
    if (!cfg?.base_url || !cfg?.public_key || !cfg?.secret_key) return null;
    const learned = await learnSystemProjectId(cfg);
    if (!learned.ok || !learned.projectId) return null;
    await q(`UPDATE langfuse_config SET system_project_id=$1, updated_at=now() WHERE id=true`,
      [learned.projectId]);
    logline('langfuse', `system project id stored (from the live API)`);
    return learned.projectId;
  } catch (e) {
    logline('langfuse', `system project id refresh skipped: ${e.message}`);
    return null;
  }
}

// Resolve the "View Langfuse" session link for one xell. Returns { ok:true, url, session_id,
// project_id } or { ok:false, reason } where reason ∈ langfuse-disabled · langfuse-tracking-off ·
// no-session · no-project · langfuse-unreachable. Resolution order (TKT-127 — the link must resolve
// from stored state, not a live credentialed call):
//   1. the xell's 1:1 mapping (langfuse_project_map) — its own Langfuse project;
//   2. the STORED system project id (langfuse_config.system_project_id);
//   3. ONLY THEN, best-effort, the live public-API read — kept as how an instance provisioned before
//      the column existed gets its stored value populated, and it writes back what it learns.
// Best-effort on that one live read; never throws.
export async function xellLangfuseSession({ xellId, zeeId = null, sessionId = null }) {
  try {
    const cfg = await one(
      `SELECT enabled, base_url, ui_url, public_key, secret_key, system_project_id FROM langfuse_config WHERE id=true`);
    if (!cfg?.enabled || !cfg?.ui_url) return { ok: false, reason: 'langfuse-disabled' };
    const xell = await one(
      `SELECT id, slug, project_id, langfuse_tracking FROM xell WHERE id=$1`, [xellId]);
    if (!xell) return { ok: false, reason: 'no-such-xell' };
    if (xell.langfuse_tracking === false) return { ok: false, reason: 'langfuse-tracking-off' };
    let sid = sessionId;
    if (!sid) {
      const zee = zeeId
        ? await one(`SELECT claude_session_id, session_name FROM zee WHERE id=$1`, [zeeId])
        : await one(`SELECT claude_session_id, session_name FROM zee WHERE xell_id=$1 ORDER BY created_at DESC LIMIT 1`, [xellId]);
      sid = zee?.claude_session_id || zee?.session_name || null;
    }
    if (!sid) return { ok: false, reason: 'no-session' };
    // The Langfuse PROJECT that owns this session: a 1:1-mapped ZEEHIVE project has its own Langfuse
    // project (its id is in the map); otherwise the trace landed in the SYSTEM trace project, whose
    // Langfuse id is stored on the config row (system_project_id — written at provision / project
    // sync / the write-back below). The live read is the LAST resort, and a failing read refuses
    // with a reason a human can act on — it never fabricates a link.
    let projectId = null;
    if (xell.project_id) {
      const mapped = await one(
        `SELECT langfuse_project_id FROM langfuse_project_map WHERE project_id=$1`, [xell.project_id]);
      projectId = mapped?.langfuse_project_id || null;
    }
    if (!projectId && cfg.system_project_id) {
      projectId = cfg.system_project_id;
    }
    if (!projectId) {
      const learned = await learnSystemProjectId(cfg);
      if (learned.ok && learned.projectId) {
        projectId = learned.projectId;
        // Write back what we learned so the NEXT resolution needs no live call — this is how an
        // instance provisioned before system_project_id existed gets its stored value populated.
        // A failed write-back must not sink the link, so it is caught here.
        await q(`UPDATE langfuse_config SET system_project_id=$1, updated_at=now() WHERE id=true`,
          [projectId]).catch(() => {});
      } else if (learned.reason === 'unreachable') {
        // The stored id is missing AND the instance is not answering — name it so a human can act.
        return { ok: false, reason: 'langfuse-unreachable' };
      }
      // reason 'no-keys' / 'no-project-id' → fall through to no-project: Langfuse has never told
      // us its project id (and the instance, if reached, has no project for these keys).
    }
    if (!projectId) return { ok: false, reason: 'no-project' };
    const url = langfuseSessionUrl({ uiUrl: cfg.ui_url, projectId, sessionId: sid });
    if (!url) return { ok: false, reason: 'no-session' };
    return { ok: true, url, session_id: sid, project_id: projectId };
  } catch (e) {
    logline('langfuse', `langfuse session link failed (best-effort): ${e.message}`);
    return { ok: false, reason: 'error', error: e.message };
  }
}

// ── AUTO SIGN-IN — the "Open Langfuse UI" link signs the human in without re-typing ──
// Langfuse is NextAuth (JWT-cookie sessions). The console is a different origin than Langfuse, so
// the browser cannot fetch Langfuse's CSRF (no CORS headers) and cannot set Langfuse's cookie
// directly. The reliable mechanism: a POPUP page served by ZEEHIVE (same-origin to the console,
// via the nginx /api proxy) whose server does the ONLY cross-origin fetch (GET /api/auth/csrf),
// then the popup renders a hidden <form> that does a TOP-LEVEL POST to Langfuse's credentials
// callback. A top-level form POST is the one cross-origin request that is not CORS-blocked and the
// one that carries Lax cookies — Langfuse sets its session cookie on its own origin, the popup
// redirects to the dashboard, and the human is signed in.
//
// The credentials come from the stored admin login (revealLangfuse's row) — the SAME human who
// provisioned Langfuse, now already authenticated to ZEEHIVE. No password prompt.
//
// Pure HTML builders so tests can assert the exact page without a live Langfuse.
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

export function signinHtml({ csrfToken, adminEmail, adminPassword, callbackUrl, uiUrl }) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Signing you into Langfuse…</title></head>
<body style="font-family:system-ui;background:#0d1117;color:#c9d1d9;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="text-align:center"><p>Signing you into <b>Langfuse</b>…</p>
  <form id="lf-auth" method="post" action="${esc(callbackUrl)}">
    <input type="hidden" name="csrfToken" value="${esc(csrfToken)}" />
    <input type="hidden" name="email" value="${esc(adminEmail)}" />
    <input type="hidden" name="password" value="${esc(adminPassword)}" />
    <input type="hidden" name="callbackUrl" value="${esc(uiUrl || '/')}" />
    <input type="hidden" name="json" value="true" />
    <noscript><button type="submit">Continue</button></noscript>
  </form></div>
  <script>window.addEventListener('load', () => { const f = document.getElementById('lf-auth'); if (f) f.submit(); });</script>
</body></html>`;
}

export function signedInHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Signed in</title></head>
<body style="font-family:system-ui;background:#0d1117;color:#35c46b;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
  <div style="text-align:center"><p>✓ Signed in to Langfuse.</p><p style="color:#8b949e;font-size:13px">You can close this tab.</p></div>
</body></html>`;
}

// Open-redirect guard for the auto-login popup's `?next=` callback. The callback becomes the
// auto-login page's post-login `location.href` (docker/zeehive/langfuse-auto-login.html), and
// GET /api/langfuse/signin is UNAUTHENTICATED, so a crafted link auto-signs a human into Langfuse
// with the stored admin credentials and then top-level-navigates them to an attacker's origin.
// The old startsWith('/') guard also passed `//evil.com`, `///evil.com` and `/\evil.com` (a browser
// URL parser treats a backslash as a slash, so `/\evil.com` resolves like `//evil.com`). Reject
// backslashes outright, then parse against uiBase and require the resolved origin to equal
// uiBase's; anything else (null) makes the caller fall back to uiBase. A relative path is accepted
// because it stays on the Langfuse origin by construction.
export function safeLangfuseCallback(next, uiBase) {
  if (!next) return null;
  const raw = String(next);
  if (/\\/.test(raw)) return null;
  try {
    return new URL(raw, uiBase).origin === new URL(uiBase).origin ? raw : null;
  } catch {
    return null;
  }
}

// ── one-time signin token (TKT-95: the admin password never rides in a URL) ──
// The redirect to the injected auto-login page used to carry `?email=…&password=…` in its query
// string — the Langfuse admin credential landed in browser history, proxy logs and the referrer
// chain to ANY caller that could reach the API. Instead the server mints a ONE-TIME, short-TTL
// token, stores only its SHA-256 hash (the same discipline as xell.self_token_hash), and the
// redirect carries the token + a redemption URL. The auto-login page POSTs the token back to the
// server to obtain the credential once; a second redemption matches no row (used_at is set on the
// first claim) and an expired token never matches either.
const SIGNIN_TOKEN_TTL_MS = 60_000;   // short — the page redeems within a second of the redirect

export async function mintLangfuseSigninToken(callback) {
  const token = randomBytes(32).toString('base64url');
  const hash = createHash('sha256').update(token).digest('hex');
  // Opportunistic sweep: expired rows are never redeemable, so this only keeps the table small.
  await q(`DELETE FROM langfuse_signin_token WHERE expires_at < now()`);
  await q(`INSERT INTO langfuse_signin_token (token_hash, callback, expires_at)
           VALUES ($1, $2, now() + (make_interval(secs => $3)))`,
    [hash, callback, SIGNIN_TOKEN_TTL_MS / 1000]);
  return token;
}

// Redeem a one-time signin token for the stored admin credential. Atomic single-use claim: only an
// unused, unexpired row can be claimed, so a token cannot be redeemed twice and a raced pair of
// redemptions cannot both win. The callback is stored WITH the token (guarded by
// safeLangfuseCallback when minted), so the redirect carries only the token — never the callback
// or the credential in a URL.
export async function redeemLangfuseSigninToken(token) {
  const t = String(token || '').trim();
  if (!t) return { ok: false, error: 'missing signin token' };
  const hash = createHash('sha256').update(t).digest('hex');
  const row = await one(
    `UPDATE langfuse_signin_token SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING callback`,
    [hash]);
  if (!row) return { ok: false, error: 'invalid, expired or already-used signin token' };
  const cfg = await one(`SELECT admin_email, admin_password FROM langfuse_config WHERE id=true`);
  if (!cfg?.admin_email || !cfg?.admin_password) {
    return { ok: false, error: 'No stored admin login — re-provision Langfuse.' };
  }
  return { ok: true, email: cfg.admin_email, password: cfg.admin_password, callback: row.callback };
}

// ── one-time REVEAL token (TKT-104 / TKT-108-E589) ──
// POST /api/langfuse/reveal used to return the FULL Langfuse credential set (admin_password
// included) to ANY caller — the same disclosure class TKT-95 just closed on /signin. It now
// follows the signin pattern: the route refuses a caged zee and returns only a ONE-TIME, short-TTL
// reveal token (the SAME langfuse_signin_token table from migration 144), and the credential
// leaves the server only on a redemption that (a) is not a caged zee, (b) presents the SAME
// console origin that minted the token, and (c) atomically claims the single-use token before its
// 60s TTL. The token row's `callback` column stores `reveal:<console-host>` (there is no
// post-login callback for a reveal); the redemption requires the caller's Origin host to equal it,
// so a token minted by one console origin cannot be redeemed by another.
export async function mintLangfuseRevealToken(origin, requestBase) {
  const originHost = originHostOf(origin);
  const baseHost = originHostOf(requestBase);
  if (!originHost || !baseHost || originHost !== baseHost) {
    return { ok: false, status: 403, error: 'langfuse/reveal is a human-console verb — the console must present its own origin' };
  }
  const token = await mintLangfuseSigninToken(`reveal:${originHost}`);
  return { ok: true, token };
}

export async function redeemLangfuseRevealToken(token, origin) {
  const t = String(token || '').trim();
  const originHost = originHostOf(origin);
  if (!t) return { ok: false, error: 'missing reveal token' };
  if (!originHost) {
    return { ok: false, status: 403, error: 'langfuse/reveal/redeem is a human-console verb — the console must present its own origin' };
  }
  const hash = createHash('sha256').update(t).digest('hex');
  // Distinguish a wrong-origin redemption (403 — the caller may be an attacker with someone
  // else's token) from a bad/used/expired token (400), so the refusal reason stays honest.
  const existing = await one(`SELECT callback FROM langfuse_signin_token WHERE token_hash = $1`, [hash]);
  if (existing && existing.callback !== `reveal:${originHost}`) {
    return { ok: false, status: 403, error: 'reveal token redemption refused — the token was minted for a different console origin' };
  }
  const row = await one(
    `UPDATE langfuse_signin_token SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
        AND callback = $2
      RETURNING token_hash`,
    [hash, `reveal:${originHost}`]);
  if (!row) return { ok: false, error: 'invalid, expired or already-used reveal token' };
  try {
    return { ok: true, ...(await revealLangfuse()) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// The host part of an origin URL (`http://10.0.0.1:9999` → `10.0.0.1`), tolerant of a bare host.
// Hostname (not full origin) is what scopes a reveal token: the prod nginx keeps Origin and Host
// in lock-step, but the vite dev proxy rewrites Host to the API target while the browser keeps the
// webapp origin — the port differs between dev and prod, the host never does. Same bar-not-wall
// posture as the signin redemption's Origin check.
function originHostOf(origin) {
  const o = String(origin || '').trim();
  if (!o) return null;
  try {
    return new URL(o.includes('://') ? o : `http://${o}`).hostname || null;
  } catch {
    return null;
  }
}

// Server-side CSRF fetch + the auto-submitting HTML. Returns { ok, html } or { ok:false, error }.
// Requires the plugin to be UP (a signed-in popup needs a live Langfuse). Never throws.
//
// `next` — an optional LANGFUSE-ORIGIN url (the "View Langfuse" session link) to land on AFTER the
// auto-login, so a human is never dumped on a login page. Guarded against an open redirect: only a
// URL on the stored ui_url origin (or a relative path) is honoured; anything else falls back to the
// default callback. The caller (/api/langfuse/signin?next=…) passes the session URL computed by
// xellLangfuseSession — it is always on the Langfuse origin, so the guard never blocks the real flow.
//
// `redeemBase` — the browser-facing base the auto-login page should redeem the token against
// (computed by the route from the request Host / X-Forwarded-* headers). The redirect carries it
// as `redeem` so the page knows where to POST the token; the credential itself never appears.
export async function langfuseSigninPage(next = null, { redeemBase = null } = {}) {
  try {
    const row = await one(
      `SELECT enabled, status, base_url, ui_url, admin_email, admin_password FROM langfuse_config WHERE id=true`);
    // Gate on the LIVE probe, not the stored status column: the background probe that flips the
    // stored status can lag (or be lost after a ship/restart), so Langfuse is genuinely up while
    // `status` still says provisioning — measured live 2026-08-03. probeLangfuse() is the honest
    // "is it answering" oracle and returns 'off'|'up'|'down' (it is a READ, not mode-gated).
    const live = await probeLangfuse();
    if (!row?.enabled || live !== 'up') {
      return { ok: false, error: row?.enabled
        ? 'Langfuse is not answering — is the stack healthy?'
        : 'Langfuse is not enabled.' };
    }
    if (!row?.admin_email || !row?.admin_password) {
      return { ok: false, error: 'No stored admin login — re-provision Langfuse.' };
    }
    // The popup must land on the LANGFUSE ORIGIN, not the ZEEHIVE origin: NextAuth's CSRF is a
    // double-submit cookie, and a cross-origin page cannot set it (measured live: a ZEEHIVE-origin
    // popup got "?csrf=true" — the cookie never landed on Langfuse's origin). So we 302 the popup
    // to the SAME-ORIGIN auto-login page we injected into the langfuse-web container at provision
    // (/generated/zeehive-auto-login.html). That page redeems a ONE-TIME token against the ZEEHIVE
    // server to obtain the credential, then fetches its own CSRF and posts the creds — same-origin,
    // cookie accepted, session set. The credential never rides in a query string.
    const uiBase = String(row.ui_url || `http://localhost:${LANGFUSE_WEB_PORT}`).replace(/\/+$/, '');
    // safeLangfuseCallback guards the post-login callback against an open redirect — see above.
    const safeNext = safeLangfuseCallback(next, uiBase);
    const token = await mintLangfuseSigninToken(safeNext || uiBase);
    const pageUrl = `${row.base_url}/generated/zeehive-auto-login.html`
      + `?token=${encodeURIComponent(token)}`
      + (redeemBase ? `&redeem=${encodeURIComponent(`${redeemBase.replace(/\/+$/, '')}/api/langfuse/signin/redeem`)}` : '');
    return { ok: true, redirect: pageUrl, token };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── read model for the console: recent traces (public API, read-only) ─────────
// The traces read endpoint is NOT available while Langfuse runs in v4 `events_only` migration
// mode (it 404s with an explicit message). Report that honestly instead of a bare 404, so the
// console tells a human "set LANGFUSE_MIGRATION_V4_WRITE_MODE=dual" rather than "traces broke".
export async function listLangfuseTraces({ limit = 20 } = {}) {
  const row = await one(`SELECT enabled, base_url, public_key, secret_key FROM langfuse_config WHERE id=true`);
  if (!row?.enabled || !row?.public_key || !row?.secret_key) return { ok: false, reason: 'disabled' };
  try {
    const r = await fetch(`${row.base_url}/api/public/traces?limit=${Math.min(Math.max(Number(limit) || 20, 1), 100)}`, {
      headers: {
        authorization: `Basic ${Buffer.from(`${row.public_key}:${row.secret_key}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) {
      const text = (await r.text()).slice(0, 300);
      if (/events_only/i.test(text)) {
        return { ok: false, events_only: true, error:
          'Langfuse is in v4 `events_only` migration mode — the traces API is disabled. Use the '
          + '"Heal write mode" button in this panel to flip the stack to dual (new stacks already '
          + 'provision in dual). Traces are still being ingested via OTel meanwhile.' };
      }
      return { ok: false, status: r.status, error: text };
    }
    return { ok: true, traces: (await r.json())?.data || [] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ── 1:1 project mapping: each ZEEHIVE project → its own Langfuse project ─────
// With an ORG-SCOPED Langfuse API key (org_public_key/org_secret_key), the queenzee creates a
// Langfuse project + a per-project API key for every ZEEHIVE project, so a project's traces land
// only in that project's Langfuse scope. The map is langfuse_project_map (migration 117), modeled
// on provider_token: project_id FK ON DELETE CASCADE, full keys + masked hints.
//
// Langfuse public API (from the fern definitions):
//   GET  /api/public/projects                          — project-scoped key → its own project
//   POST /api/public/projects                          — org-scoped key → create a project
//   POST /api/public/projects/{projectId}/apiKeys      — org-scoped key → create a project API key
// The create-project response body carries the new project id; the apiKeys response carries the
// new public/secret key (the secret appears ONCE).

// Read model: every ZEEHIVE project + whether a Langfuse mapping exists (masked hints).
export async function listLangfuseProjects() {
  const c = await langfuseConfig();
  const rows = await q(
    `SELECT p.id, p.name,
            lm.langfuse_project_id, lm.langfuse_project_name,
            lm.public_key_hint, lm.secret_key_hint, lm.created_at
       FROM project p
       LEFT JOIN langfuse_project_map lm ON lm.project_id = p.id
      ORDER BY p.name`);
  return {
    enabled: !!c.enabled,
    has_org_keys: !!(c.org_public_key_hint && c.org_secret_key_hint),
    org_name: c.org_name || null,
    projects: rows.map((r) => ({
      project_id: r.id,
      project_name: r.name,
      mapped: !!r.langfuse_project_id,
      langfuse_project_id: r.langfuse_project_id || null,
      langfuse_project_name: r.langfuse_project_name || null,
      public_key_hint: r.public_key_hint || null,
      secret_key_hint: r.secret_key_hint || null,
      created_at: r.created_at || null,
    })),
  };
}

// Create a Langfuse project + a per-project API key for every ZEEHIVE project that has no mapping
// yet. Requires the plugin enabled + org keys. Per-project best-effort: one failure is logged, the
// loop continues (a transient API hiccup must not stop the whole sync). Simulate models the map
// rows without a real POST (same gating as provision).
export async function syncLangfuseProjects({ by = 'human@console' } = {}) {
  const cfg = await one(
    `SELECT enabled, base_url, org_public_key, org_secret_key, org_name, public_key_hint
       FROM langfuse_config WHERE id=true`);
  if (!cfg?.enabled) throw new Error('Langfuse is not enabled — provision it first.');
  // Refresh the stored SYSTEM trace project id first — it needs only the trace keys (present
  // whenever the plugin is enabled), and it is the value the "View Langfuse" resolver reads
  // instead of a live credentialed call. Best-effort: a failure leaves the stored value untouched.
  await refreshSystemProjectId();
  if (!cfg?.org_public_key || !cfg?.org_secret_key) {
    throw new Error('No org-scoped Langfuse API key — paste the org public + secret key at Setup to enable 1:1 project mapping.');
  }
  const orgAuth = `Basic ${Buffer.from(`${cfg.org_public_key}:${cfg.org_secret_key}`).toString('base64')}`;
  const base = cfg.base_url;
  const projects = await q(`SELECT id, name FROM project ORDER BY name`);
  const created = [], skipped = [], failed = [];
  for (const p of projects) {
    const existing = await one(`SELECT langfuse_project_id FROM langfuse_project_map WHERE project_id=$1`, [p.id]);
    if (existing) { skipped.push(p.name); continue; }
    try {
      // Create the Langfuse project (org-scoped key).
      let projectId = null, projectName = p.name;
      if (MODE === 'real') {
        const projRes = await fetch(`${base}/api/public/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: orgAuth },
          body: JSON.stringify({ name: p.name, metadata: { zeehive: true, zeehive_project_id: p.id } }),
          signal: AbortSignal.timeout(10000),
        });
        if (!projRes.ok) {
          const txt = (await projRes.text()).slice(0, 200);
          throw new Error(`project create → ${projRes.status} ${txt}`);
        }
        projectId = (await projRes.json())?.id || null;
        if (!projectId) throw new Error('project create returned no id');
        // Create a project-scoped API key (org-scoped key can also do this).
        const keyRes = await fetch(`${base}/api/public/projects/${projectId}/apiKeys`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: orgAuth },
          body: JSON.stringify({ note: `zeehive:${p.name}` }),
          signal: AbortSignal.timeout(10000),
        });
        if (!keyRes.ok) {
          const txt = (await keyRes.text()).slice(0, 200);
          throw new Error(`apiKey create → ${keyRes.status} ${txt}`);
        }
        const keyBody = await keyRes.json();
        const pub = keyBody?.publicKey || keyBody?.id || null;
        const sec = keyBody?.secretKey || keyBody?.secret || null;
        if (!pub || !sec) throw new Error('apiKey create returned no public/secret key');
        await one(
          `INSERT INTO langfuse_project_map
             (project_id, langfuse_project_id, langfuse_project_name, public_key, secret_key, public_key_hint, secret_key_hint)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (project_id) DO UPDATE
             SET langfuse_project_id=EXCLUDED.langfuse_project_id,
                 langfuse_project_name=EXCLUDED.langfuse_project_name,
                 public_key=EXCLUDED.public_key, secret_key=EXCLUDED.secret_key,
                 public_key_hint=EXCLUDED.public_key_hint, secret_key_hint=EXCLUDED.secret_key_hint`,
          [p.id, projectId, projectName, pub, sec, hint(pub), hint(sec)]);
        created.push(p.name);
      } else {
        // simulate: model a map row (deterministic keys) without a real Langfuse POST.
        const pub = lfKey('pk'), sec = lfKey('sk');
        await one(
          `INSERT INTO langfuse_project_map
             (project_id, langfuse_project_id, langfuse_project_name, public_key, secret_key, public_key_hint, secret_key_hint)
           VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (project_id) DO UPDATE
             SET langfuse_project_id=EXCLUDED.langfuse_project_id,
                 langfuse_project_name=EXCLUDED.langfuse_project_name,
                 public_key=EXCLUDED.public_key, secret_key=EXCLUDED.secret_key,
                 public_key_hint=EXCLUDED.public_key_hint, secret_key_hint=EXCLUDED.secret_key_hint`,
          [p.id, `sim-${p.id}`, p.name, pub, sec, hint(pub), hint(sec)]);
        created.push(p.name);
      }
    } catch (e) {
      failed.push({ project: p.name, error: e.message });
      logline('langfuse', `project sync failed for ${p.name}: ${e.message}`);
    }
  }
  logline('langfuse', `project sync by ${by} (${MODE}): ${created.length} created, ${skipped.length} skipped, ${failed.length} failed`);
  return { ok: true, mode: MODE, created, skipped, failed,
           mapped_count: created.length + skipped.length };
}

// ── human reveal (the second full-value door, like provider tokens / exportEnv) ─
// TKT-104: the FULL credential set is only served by /langfuse/reveal/redeem after a one-time-token
// redemption (the console's positive auth). This function is the redeem's payload source; it is
// never called from a route that an unauthenticated caller can hit directly.
export async function revealLangfuse() {
  const row = await one(
    `SELECT public_key, secret_key, org_public_key, org_secret_key,
            admin_password, admin_email, base_url, ui_url, gateway_url, org_name
       FROM langfuse_config WHERE id=true`);
  if (!row?.public_key || !row?.secret_key) {
    throw new Error('Langfuse is not provisioned — there is nothing to reveal.');
  }
  return {
    public_key: row.public_key,
    secret_key: row.secret_key,
    org_public_key: row.org_public_key,
    org_secret_key: row.org_secret_key,
    org_name: row.org_name,
    admin_email: row.admin_email,
    admin_password: row.admin_password,
    base_url: row.base_url,
    ui_url: row.ui_url,
    gateway_url: row.gateway_url,
  };
}
