// Idempotent seed: the OmniBiz project, its xource, agent runtimes, pool config,
// and the fleet-shared container inventory (from the container-topology research).
// Re-runnable: everything is upserted on natural keys.
import { pool, q, one } from './pool.js';
import { config } from '../config.js';

async function seed() {
  // ── agent runtimes (the UI runtime toggle lists the enabled ones) ──────────
  const runtimes = [
    // local viewer = the desktop-protocol deep link (same claude:// scheme the T-Keyboard
    // uses to jump Claude Desktop to a session); built per-zee from its session id at spawn.
    { key: 'claude-code-local',  label: 'Claude Code (local)',  vendor: 'anthropic', driver: 'agent-sdk',  viewer_kind: 'desktop-protocol', tmpl: 'claude://resume?session={session}', enabled: true,  sort: 100 },
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
  const project = await one(
    `INSERT INTO project (name,repo_root,main_branch,docker_ctx_dev,docker_ctx_prod,
        dev_host_ip,prod_host_ip,compose_dev,compose_spinoff,compose_prod,env_file,
        port_server_base,port_web_base,port_slot_mod)
     VALUES ('OmniBiz',$1,'main','ugreen-nas','mardale-prod','10.1.0.18','10.2.0.16',
        'docker-compose.dev.yml','docker-compose.spinoff.yml','docker-compose.prodsrc.yml','.env',
        3100,5200,90)
     ON CONFLICT (name) DO UPDATE SET repo_root=EXCLUDED.repo_root
     RETURNING id`,
    [config.omnibizRoot]
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

  // ── fleet-shared container inventory (dev + prod singletons) ───────────────
  // role, tier, name, host_port, internal_port, url
  const dev = '10.1.0.18', prod = '10.2.0.16';
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
      `INSERT INTO container (project_id,role,tier,isolation,name,host,host_port,internal_port,url,docker_ctx,health)
       VALUES ($1,$2,$3,'shared',$4,$5,$6,$7,$8,$9,'unknown')
       ON CONFLICT (project_id,name) DO UPDATE SET
         role=EXCLUDED.role, tier=EXCLUDED.tier, host_port=EXCLUDED.host_port,
         internal_port=EXCLUDED.internal_port, url=EXCLUDED.url, docker_ctx=EXCLUDED.docker_ctx`,
      [projectId, role, tier, name, tier === 'dev' ? dev : prod, hostPort, intPort, url, ctx]
    );
  }

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
  await pool.end();
}

seed().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
