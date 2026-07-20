// Idempotent seed: the OmniBiz project, its xource, agent runtimes, pool config,
// and the fleet-shared container inventory (from the container-topology research).
// Re-runnable: everything is upserted on natural keys.
import { resolve } from 'node:path';
import { pool, q, one } from './pool.js';
import { config } from '../config.js';
import { loadManifest } from '../lib/manifest.js';

async function seed() {
  // ── agent runtimes (the UI runtime toggle lists the enabled ones) ──────────
  const runtimes = [
    // local viewer = the desktop-protocol deep link (same claude:// scheme the T-Keyboard
    // uses to jump Claude Desktop to a session); built per-zee from its session id at spawn.
    { key: 'claude-code-local',  label: 'Claude Code (local)',  vendor: 'anthropic', driver: 'agent-sdk',  viewer_kind: 'desktop-protocol', tmpl: 'claude://resume?session={session}', enabled: true,  sort: 100 },
    // cxell = the CLI runs INSIDE a per-xell zee-agent container (kernel-enforced confinement,
    // not prompt-enforced). No viewer: its session JSONL lives in the container, so claude://
    // cannot attach — output streams to the dashboard over SSE instead. (Also in 028 for
    // already-migrated DBs; seeded here for fresh ones.)
    { key: 'claude-code-cxell',  label: 'Claude Code (cxell)',  vendor: 'anthropic', driver: 'cxell-cli',  viewer_kind: 'none',            tmpl: null, enabled: true,  sort: 150 },
    // remote viewer_url is captured LIVE from `claude remote` output at spawn (the real
    // claude.ai session URL) — no template, so a URL scheme is never fabricated.
    { key: 'claude-code-remote', label: 'Claude Code (remote)', vendor: 'anthropic', driver: 'remote-api', viewer_kind: 'web',             tmpl: null, enabled: true,  sort: 200 },
    // Others are registered but disabled until a real driver + viewer URL exist:
    { key: 'gpt-codex',          label: 'GPT (Codex CLI)',      vendor: 'openai',    driver: 'none',       viewer_kind: 'none',            tmpl: null, enabled: false, sort: 300 },
  ];
  const runtimeIds = {};
  for (const r of runtimes) {
    const row = await one(
      `INSERT INTO agent_runtime (key,label,vendor,driver,viewer_kind,viewer_url_template,enabled,sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (key) DO UPDATE SET
         label=EXCLUDED.label, vendor=EXCLUDED.vendor, driver=EXCLUDED.driver,
         viewer_kind=EXCLUDED.viewer_kind, viewer_url_template=EXCLUDED.viewer_url_template,
         enabled=EXCLUDED.enabled, sort_order=EXCLUDED.sort_order
       RETURNING id`,
      [r.key, r.label, r.vendor, r.driver, r.viewer_kind, r.tmpl, r.enabled, r.sort]
    );
    runtimeIds[r.key] = row.id;
  }

  // ── the OmniBiz project ────────────────────────────────────────────────────
  // The seeded manifest captures OmniBiz's EXACT current shape (names, ports, prerequisites) so
  // manifest-driven code paths change nothing for it. Once the repo grows a real zeehive.yml
  // (runbook Task 1), a manifest refresh replaces this cache — which is why the upsert below
  // never clobbers an existing manifest.
  const omnibizManifest = {
    version: 1,
    project: 'omnibiz',
    env: { file: '.env', generated: '.zeehive.env' },
    tiers: {
      dev: { compose: 'docker-compose.dev.yml' },
      spinoff: {
        compose: 'docker-compose.spinoff.yml',
        project_name: 'omnibiz-spin-{slug}',
        ports: { server: { base: 3100, mod: 90 }, webapp: { base: 5200, mod: 90 } },
        requires: {
          // the `postgres` alias is load-bearing: a db recreated by bare `docker run` drops it
          // and crash-loops every spinoff — verified at provision (lib/provision.js verifyRequires)
          networks: [{ name: 'omnibiz_omnibiz-net', aliases: ['postgres'] }],
          volumes: ['omnibiz_synapse_data_dev'],
        },
        scripts: { up: 'scripts/spin-env.sh up', purge: 'scripts/spin-env.sh purge' },
      },
      prod: { compose: 'docker-compose.prodsrc.yml', requires: { volumes: ['postgres_data_prod'] } },
    },
    roles: {
      server: { service: 'server', buildable: true },
      webapp: { service: 'webapp', buildable: true },
      db: { service: 'postgres', buildable: false },
    },
    naming: {
      container: { server: 'omnibiz_spin_server_{slug}', webapp: 'omnibiz_spin_web_{slug}', db: 'omnibiz_db_spin_{slug}' },
      image: { server: 'omnibiz-spin-server:{slug}', webapp: 'omnibiz-spin-webapp:{slug}' },
      compose_project: 'omnibiz-spin-{slug}',
    },
    db: { name: 'omnibiz', user: 'postgres' },
  };
  if (!config.omnibizRoot) {
    throw new Error('OMNIBIZ_ROOT is not set — the seed needs the OmniBiz repo path (set it in .env, '
      + 'e.g. D:\\Repos\\OmniBiz\\omnibiz on the host or /repos/OmniBiz/omnibiz in the container)');
  }
  const project = await one(
    `INSERT INTO project (name,repo_root,main_branch,docker_ctx_dev,docker_ctx_prod,
        dev_host_ip,prod_host_ip,compose_dev,compose_spinoff,compose_prod,env_file,
        port_server_base,port_web_base,port_slot_mod,db_name,db_user,manifest,manifest_at)
     VALUES ('OmniBiz',$1,'main','ugreen-nas','mardale-prod','10.1.0.18','10.2.0.16',
        'docker-compose.dev.yml','docker-compose.spinoff.yml','docker-compose.prodsrc.yml','.env',
        3100,5200,90,'omnibiz','postgres',$2,now())
     ON CONFLICT (name) DO UPDATE SET
        repo_root=EXCLUDED.repo_root,
        db_name=COALESCE(project.db_name, EXCLUDED.db_name),
        db_user=COALESCE(project.db_user, EXCLUDED.db_user),
        manifest=COALESCE(project.manifest, EXCLUDED.manifest),
        manifest_at=COALESCE(project.manifest_at, now())
     RETURNING id`,
    [config.omnibizRoot, JSON.stringify(omnibizManifest)]
  );
  const projectId = project.id;

  // ── the xource (local main) ────────────────────────────────────────────────
  await q(
    `INSERT INTO xource (project_id,ref,read_only) VALUES ($1,'main',true)
     ON CONFLICT (project_id,ref) DO NOTHING`,
    [projectId]
  );

  // ── pool config ────────────────────────────────────────────────────────────
  await q(
    `INSERT INTO pool_config (project_id,target_ready,default_source_coupling,default_db_coupling,
        default_runtime_id,prod_backup_cron,refresh_interval_sec)
     VALUES ($1,$2,'sparse-overlay','db-shared-dev',$3,'0 3 * * *',3600)
     ON CONFLICT (project_id) DO UPDATE SET
        target_ready=EXCLUDED.target_ready, default_runtime_id=EXCLUDED.default_runtime_id`,
    [projectId, config.poolTargetReady, runtimeIds['claude-code-local']]
  );

  // ── deploy sites: WHERE each tier runs and how it is reached (015, spec §5) ─
  const dev = '10.1.0.18', prod = '10.2.0.16';
  const sites = [
    { key: 'dev', tier: 'dev', ctx: 'ugreen-nas', host: dev, isDefault: true, compose: null, ingress: { kind: 'lan' } },
    { key: 'mardale-prod', tier: 'prod', ctx: 'mardale-prod', host: prod, isDefault: true, compose: 'docker-compose.prodsrc.yml',
      ingress: { kind: 'cloudflare-tunnel', proxy_role: 'infra:caddy', provider_container: 'cloudflare_tunnel',
                 notes: 'WebRTC media (UDP 7882/TCP 7881) does NOT traverse the tunnel — TURN required' } },
  ];
  const siteIds = {};
  for (const s of sites) {
    const row = await one(
      `INSERT INTO deploy_site (project_id,key,tier,docker_ctx,host,compose_file,ingress,is_default)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (project_id,key) DO UPDATE SET
         tier=EXCLUDED.tier, docker_ctx=EXCLUDED.docker_ctx, host=EXCLUDED.host,
         compose_file=EXCLUDED.compose_file, ingress=EXCLUDED.ingress, is_default=EXCLUDED.is_default
       RETURNING id`,
      [projectId, s.key, s.tier, s.ctx, s.host, s.compose, JSON.stringify(s.ingress), s.isDefault]);
    siteIds[s.tier] = row.id;
  }

  // ── fleet-shared container inventory (dev + prod singletons) ───────────────
  // role, tier, name, host_port, internal_port, url
  const shared = [
    // DEV (context ugreen-nas)
    ['db',     'dev',  'omnibiz_db_dev',        5434, 5432, null,                  'ugreen-nas'],
    ['server', 'dev',  'omnibiz_server_dev',    3000, 3000, `http://${dev}:3000`,  'ugreen-nas'],
    ['webapp', 'dev',  'omnibiz_webapp_dev',    null, 5173, `http://${dev}:5174`,  'ugreen-nas'],
    ['infra',  'dev',  'omnibiz_caddy_dev',     5174, 80,   null,                  'ugreen-nas'],
    ['infra',  'dev',  'omnibiz_synapse_dev',   8008, 8008, null,                  'ugreen-nas'],
    ['infra',  'dev',  'omnibiz_element_dev',   8009, 80,   null,                  'ugreen-nas'],
    ['infra',  'dev',  'omnibiz_livekit_dev',   7880, 7880, null,                  'ugreen-nas'],
    ['infra',  'dev',  'omnibiz_mosquitto_dev', 1883, 1883, null,                  'ugreen-nas'],
    ['infra',  'dev',  'omnibiz_markitdown_dev',null, 8010, null,                  'ugreen-nas'],
    ['infra',  'dev',  'omnibiz_redis_dev',     null, 6379, null,                  'ugreen-nas'],
    // PROD (context mardale-prod)
    ['db',     'prod', 'omnibiz_db_prod',       5432, 5432, null,                  'mardale-prod'],
    ['server', 'prod', 'omnibiz_server_prod',   null, 3000, null,                  'mardale-prod'],
    ['webapp', 'prod', 'omnibiz_webapp_prod',   null, 5173, null,                  'mardale-prod'],
    ['infra',  'prod', 'omnibiz_caddy_prod',    80,   80,   `http://${prod}`,      'mardale-prod'],
    ['infra',  'prod', 'cloudflare_tunnel',     null, null, null,                  'mardale-prod'],
    ['infra',  'prod', 'omnibiz_synapse_prod',  8008, 8008, null,                  'mardale-prod'],
    ['infra',  'prod', 'omnibiz_livekit_prod',  7880, 7880, null,                  'mardale-prod'],
    ['infra',  'prod', 'omnibiz_redis_prod',    null, 6379, null,                  'mardale-prod'],
  ];
  for (const [role, tier, name, hostPort, intPort, url, ctx] of shared) {
    await q(
      `INSERT INTO container (project_id,role,tier,isolation,name,host,host_port,internal_port,url,docker_ctx,site_id,health)
       VALUES ($1,$2,$3,'shared',$4,$5,$6,$7,$8,$9,$10,'unknown')
       ON CONFLICT (project_id,name) DO UPDATE SET
         role=EXCLUDED.role, tier=EXCLUDED.tier, host_port=EXCLUDED.host_port,
         internal_port=EXCLUDED.internal_port, url=EXCLUDED.url, docker_ctx=EXCLUDED.docker_ctx,
         site_id=EXCLUDED.site_id`,
      [projectId, role, tier, name, tier === 'dev' ? dev : prod, hostPort, intPort, url, ctx, siteIds[tier]]
    );
  }

  // ── how the queenzee ships each prod container (010_ship_gate) ─────────────
  // The path + interpreter live on the CONTAINER row so the queenzee looks up how to build a
  // thing instead of hardcoding one project's deploy. Only server/webapp are shippable: the db
  // and infra are NOT redeployed by a ship (swapping the prod postgres image is a coordinated
  // infra change, never a side effect of shipping a feature).
  const shipScript = resolve(config.repoRoot, 'scripts', 'ship-prod.sh').replace(/\\/g, '/');
  await q(
    `UPDATE container SET build_script=$2, build_exec='bash'
       WHERE project_id=$1 AND tier='prod' AND role IN ('server','webapp')`,
    [projectId, shipScript]
  );

  // ── production as an untouchable xell (references the prod containers) ──────
  const xourceRow = await one(`SELECT id FROM xource WHERE project_id=$1 AND ref='main'`, [projectId]);
  const prodXell = await one(
    `INSERT INTO xell (project_id,xource_id,slug,branch,db_coupling,status,is_pooled,is_production)
     VALUES ($1,$2,'production','production','db-shared-prod','working',false,true)
     ON CONFLICT (project_id,slug) DO UPDATE SET is_production=true RETURNING id`,
    [projectId, xourceRow.id]);
  // link the prod containers as prod's stack
  for (const role of ['db', 'server', 'webapp']) {
    const c = await one(
      `SELECT id FROM container WHERE project_id=$1 AND role=$2 AND tier='prod' AND isolation='shared' LIMIT 1`,
      [projectId, role]);
    if (c) await q(
      `INSERT INTO xell_uses_container (xell_id,container_id,relation) VALUES ($1,$2,'owns')
       ON CONFLICT DO NOTHING`, [prodXell.id, c.id]);
  }

  console.log(`Seeded project OmniBiz (${projectId}) with ${shared.length} shared containers, ${runtimes.length} runtimes, + production xell.`);

  await seedZeehive(runtimeIds);
  await pool.end();
}

// ── ZEEHIVE as a project of ZEEHIVE (spec §6) ────────────────────────────────
// The orchestrator's own runtime shape: server + web are LOCAL PROCESSES on the 'local' prod
// site (docker_ctx 'default' — dogfooding "just this machine"); the meta-DB is the pinned prod
// db (to Zeehive what omnibiz_db_prod is to OmniBiz: backed up, never rebuilt by a ship).
// Process-role rows have docker_ctx NULL + a url — the health monitor probes them by URL.
async function seedZeehive(runtimeIds) {
  // the REAL manifest from this very repo — the reference implementation of runner: process
  const mf = loadManifest(config.repoRoot);
  const dbUrl = new URL(config.databaseUrl.replace(/^postgres(ql)?:/, 'http:')); // parse host/port

  const zee = await one(
    `INSERT INTO project (name,repo_root,main_branch,compose_prod,env_file,
        port_server_base,port_web_base,port_slot_mod,db_name,db_user,manifest,manifest_hash,manifest_at)
     VALUES ('Zeehive',$1,'master','docker-compose.yml','.env',4800,5300,90,'zeehive','zeehive',$2,$3,
        CASE WHEN $2::jsonb IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (name) DO UPDATE SET
        repo_root=EXCLUDED.repo_root,
        manifest=COALESCE(EXCLUDED.manifest, project.manifest),
        manifest_hash=COALESCE(EXCLUDED.manifest_hash, project.manifest_hash)
     RETURNING id`,
    [config.repoRoot, mf.found && !mf.errors.length ? JSON.stringify(mf.manifest) : null,
     mf.found && !mf.errors.length ? mf.hash : null]);

  await q(`INSERT INTO xource (project_id,ref,read_only) VALUES ($1,'master',true)
           ON CONFLICT (project_id,ref) DO NOTHING`, [zee.id]);
  // target_ready 0 ON CREATE only: pre-warming Zeehive xells is opt-in (raise it in the console)
  // — a REAL-mode queenzee must not start cutting worktrees of its own repo as a seed side effect.
  await q(`INSERT INTO pool_config (project_id,target_ready,default_source_coupling,default_db_coupling,
              default_runtime_id,refresh_interval_sec)
           VALUES ($1,0,'sparse-overlay','db-isolated',$2,3600)
           ON CONFLICT (project_id) DO NOTHING`, [zee.id, runtimeIds['claude-code-local']]);

  const sites = [
    { key: 'dev', tier: 'dev', ctx: 'ugreen-nas', host: '10.1.0.18', ingress: { kind: 'lan' } },
    { key: 'local', tier: 'prod', ctx: 'default', host: null,
      ingress: { kind: 'lan', notes: 'the orchestrator itself — node processes on this machine' } },
  ];
  const zeeSiteIds = {};
  for (const s of sites) {
    const row = await one(
      `INSERT INTO deploy_site (project_id,key,tier,docker_ctx,host,ingress,is_default)
       VALUES ($1,$2,$3,$4,$5,$6,true)
       ON CONFLICT (project_id,key) DO UPDATE SET docker_ctx=EXCLUDED.docker_ctx, host=EXCLUDED.host
       RETURNING id`,
      [zee.id, s.key, s.tier, s.ctx, s.host, JSON.stringify(s.ingress)]);
    zeeSiteIds[s.tier] = row.id;
  }

  // the meta-DB container (pinned; ctx from wherever DATABASE_URL points — NAS in Mark's setup)
  // and the two process roles, URL-probed. NOTE: process rows keep docker_ctx NULL on purpose —
  // that is what routes them to the URL prober instead of `docker ps`.
  const rows = [
    ['db', 'prod', 'zeehive_db', 'ugreen-nas', dbUrl.hostname, Number(dbUrl.port) || 5445, 5432, null, zeeSiteIds.prod],
    ['server', 'prod', 'zeehive_server', null, null, config.port, config.port, `http://localhost:${config.port}/api/projects`, zeeSiteIds.prod],
    ['webapp', 'prod', 'zeehive_web', null, null, 5180, 5180, 'http://localhost:5180', zeeSiteIds.prod], // web/vite.config.js pins 5180
  ];
  for (const [role, tier, name, ctx, host, hostPort, intPort, url, siteId] of rows) {
    await q(
      `INSERT INTO container (project_id,role,tier,isolation,name,docker_ctx,host,host_port,internal_port,url,site_id,health)
       VALUES ($1,$2,$3,'shared',$4,$5,$6,$7,$8,$9,$10,'unknown')
       ON CONFLICT (project_id,name) DO UPDATE SET
         docker_ctx=EXCLUDED.docker_ctx, host=EXCLUDED.host, host_port=EXCLUDED.host_port,
         url=EXCLUDED.url, site_id=EXCLUDED.site_id`,
      [zee.id, role, tier, name, ctx, host, hostPort, intPort, url, siteId]);
  }

  // shipping Zeehive = the detached self-restart (spec §6.3); webapp rides along (no-op restart)
  const selfShip = resolve(config.repoRoot, 'scripts', 'self-ship.sh').replace(/\\/g, '/');
  await q(
    `UPDATE container SET build_script=$2, build_exec='bash'
      WHERE project_id=$1 AND tier='prod' AND role IN ('server','webapp')`, [zee.id, selfShip]);

  const zeeXource = await one(`SELECT id FROM xource WHERE project_id=$1 AND ref='master'`, [zee.id]);
  const prodXell = await one(
    `INSERT INTO xell (project_id,xource_id,slug,branch,db_coupling,status,is_pooled,is_production)
     VALUES ($1,$2,'production','production','db-shared-prod','working',false,true)
     ON CONFLICT (project_id,slug) DO UPDATE SET is_production=true RETURNING id`,
    [zee.id, zeeXource.id]);
  for (const role of ['db', 'server', 'webapp']) {
    const c = await one(
      `SELECT id FROM container WHERE project_id=$1 AND role=$2 AND tier='prod' LIMIT 1`, [zee.id, role]);
    if (c) await q(
      `INSERT INTO xell_uses_container (xell_id,container_id,relation) VALUES ($1,$2,'owns')
       ON CONFLICT DO NOTHING`, [prodXell.id, c.id]);
  }
  console.log(`Seeded project Zeehive (${zee.id}) — self-hosted: 2 sites, pinned meta-db, 2 process roles, production xell${mf.found ? ' (manifest from repo)' : ''}.`);
}

seed().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
