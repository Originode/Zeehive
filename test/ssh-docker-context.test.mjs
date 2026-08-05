// SSH DOCKER CONTEXTS — reachable through the `docker` CLI only, never the HTTP API.
//
// The `mardale-prod-alt` context reaches the Mardale NAS through an SSH tunnel over Cloudflare
// Access (ssh://mnrevelo@ssh.omnibiz.express). The queenzee's HTTP-based docker paths (health
// monitor, discovery, reaper — lib/docker.js) hit the daemon's HTTP API directly, which cannot
// ride SSH: a context whose endpoint is ssh:// must FAIL CLOSED with an actionable message, not
// a cryptic "unsupported docker endpoint" that reads like a typo.
//
// This proves, against a fake ~/.docker context store (no daemon, no CLI):
//   1. a TCP context (the existing mardale-prod / ugreen-nas shape) still resolves to host+port;
//   2. an ssh:// context REFUSES with a message that names SSH and points at the CLI + runbook;
//   3. the refusal is a real throw — callers map it to 'unknown', never to 'down'/'empty'.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

let fail = 0;
const ok = (c, m) => { console.log(`  ${c ? '✓' : '✗ FAIL'} ${m}`); if (!c) fail++; };

// Point config.dockerConfigDir at a scratch context store.
const dir = mkdtempSync(join(tmpdir(), `ssh-ctx-${randomUUID().slice(0, 8)}-`));
process.env.DOCKER_CONFIG = dir;

const { resolveContext } = await import('../server/src/lib/docker.js');

// meta.json path is the SAME layout the docker CLI uses: contexts/meta/<sha256(name)>/meta.json
const ctxPath = (name) => join(dir, 'contexts', 'meta', createHash('sha256').update(name).digest('hex'), 'meta.json');
const putCtx = (name, host) => {
  const p = ctxPath(name);
  mkdirSync(join(dirname(p)), { recursive: true });
  writeFileSync(p, JSON.stringify({ Name: name, Endpoints: { docker: { Host: host } } }), 'utf8');
};

try {
  console.log('\n── TCP contexts still resolve (the mardale-prod / ugreen-nas shape) ──');
  putCtx('mardale-prod', 'tcp://10.2.0.16:2375');
  putCtx('dns-tcp', 'tcp://docker.example.com:2375');
  const lan = await resolveContext('mardale-prod');
  ok(lan.host === '10.2.0.16' && lan.port === 2375, `tcp context → host+port [${lan.host}:${lan.port}]`);
  const dns = await resolveContext('dns-tcp');
  ok(dns.host === 'docker.example.com' && dns.port === 2375, `DNS-name tcp context → host+port [${dns.host}:${dns.port}]`);

  console.log('\n── ssh:// contexts refuse with an actionable error ──');
  putCtx('mardale-prod-alt', 'ssh://mnrevelo@ssh.omnibiz.express');
  let sshErr = null;
  try { await resolveContext('mardale-prod-alt'); } catch (e) { sshErr = e; }
  ok(!!sshErr, 'ssh context throws (does not silently parse)');
  ok(/SSH/.test(sshErr?.message || ''), 'error names SSH');
  ok(/docker --context/.test(sshErr?.message || ''), 'error points at the docker CLI');
  ok(/onboard-mardale-prod-alt/.test(sshErr?.message || ''), 'error names the runbook');

  console.log('\n── unknown context still fails cleanly (the pre-existing contract) ──');
  let unkErr = null;
  try { await resolveContext('no-such-ctx'); } catch (e) { unkErr = e; }
  ok(!!unkErr && /unknown docker context/.test(unkErr?.message || ''), 'unknown context → "unknown docker context"');

  console.log(fail ? `\n${fail} FAILED` : '\nall good');
} catch (e) {
  console.error('TEST ERROR:', e);
  fail++;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
