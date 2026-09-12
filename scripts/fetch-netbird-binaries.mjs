#!/usr/bin/env node
// Fetch the PINNED NetBird binaries the live API test drives (docs/netbird-mesh-plan.md §11).
//
//   node scripts/fetch-netbird-binaries.mjs [--version 0.78.1] [--dir <cache>]
//
// Two sources, because NetBird ships them in two places:
//   • the CLIENT   — a GitHub release tarball (netbird_<v>_linux_amd64.tar.gz)
//   • the MANAGEMENT server — NOT a release asset. It ships only as a container image, so this
//     pulls `netbirdio/management:<v>` straight from the Docker Hub registry over HTTPS (the OCI
//     distribution API: token → image index → amd64 manifest → blobs) and extracts
//     /go/bin/netbird-mgmt from the layer that carries it. No docker CLI, no daemon.
//
// The binaries land in <dir>/<version>/{netbird,netbird-mgmt} — exactly where
// test/netbird-live-api.test.mjs looks — and are verified against the sha256 pins below, so a
// byte-swapped or truncated download fails loudly instead of quietly changing what "verified"
// means. Re-running is cheap: an already-pinned binary is left alone.
//
// Both tarballs are read in-process (zlib + the 30-line USTAR walker at the bottom) rather than
// shelling out to `tar`: one less host dependency, and it works unchanged inside a hardened cage.
//
// This is a TEST-fetcher, not a deploy: docker-compose*.yml still pin the images the mesh runs.
import { createHash } from 'node:crypto';
import { mkdirSync, createWriteStream, existsSync, readFileSync, rmSync, statSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { gunzipSync } from 'node:zlib';
import { Readable } from 'node:stream';

const args = process.argv.slice(2);
const argOf = (flag, dflt) => {
  const i = args.indexOf(flag);
  return i === -1 ? dflt : args[i + 1];
};

const PINNED = {
  version: argOf('--version', '0.78.1'),
  // sha256 of the extracted binaries — the exact bytes this repo's §11 was verified against.
  sha256: {
    netbird: 'dec903b426de6ca43e6522d3dc3b60a49f05e422ab7248094ce38c34c38e824b',
    'netbird-mgmt': '03325d3249c65a8d142a8af439fbaf0508f5892676ef6893409f191507642f2d',
  },
};
const dir = join(argOf('--dir', join(homedir(), '.cache', 'zeehive', 'netbird')), PINNED.version);
mkdirSync(dir, { recursive: true });

const say = (m) => console.log(`  … ${m}`);
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

async function download(url, dest, headers = {}) {
  const res = await fetch(url, { headers, redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
  return dest;
}

function verify(file, name) {
  const want = PINNED.sha256[name];
  const got = sha256(file);
  if (want !== got) {
    throw new Error(`${name}: sha256 mismatch\n    want ${want}\n    got  ${got}\n`
      + '    (a different build than the one docs/netbird-mesh-plan.md §11 was verified against)');
  }
  chmodSync(file, 0o755);
}

// ── the client (GitHub release) ────────────────────────────────────────────────────────────────
const clientPath = join(dir, 'netbird');
if (existsSync(clientPath) && sha256(clientPath) === PINNED.sha256.netbird) {
  say(`client already pinned: ${clientPath}`);
} else {
  const tgz = join(tmpdir(), `netbird-client-${PINNED.version}.tar.gz`);
  const url = `https://github.com/netbirdio/netbird/releases/download/v${PINNED.version}/`
    + `netbird_${PINNED.version}_linux_amd64.tar.gz`;
  say(`client  ← ${url}`);
  await download(url, tgz);
  const member = tarMembers(readFileSync(tgz)).find((m) => m.name === 'netbird');
  if (!member) throw new Error('the release tarball carries no top-level `netbird` binary');
  writeFileSync(clientPath, member.data);
  rmSync(tgz, { force: true });
  verify(clientPath, 'netbird');
  say(`client pinned: ${clientPath}`);
}

// ── the management server (Docker Hub registry API — there is no release asset) ────────────────
const mgmtPath = join(dir, 'netbird-mgmt');
if (existsSync(mgmtPath) && sha256(mgmtPath) === PINNED.sha256['netbird-mgmt']) {
  say(`management already pinned: ${mgmtPath}`);
} else {
  const repo = 'netbirdio/management';
  const tag = PINNED.version;
  const auth = await (await fetch(`https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull`)).json();
  const H = { Authorization: `Bearer ${auth.token}`, Accept: 'application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json' };
  const index = await (await fetch(`https://registry-1.docker.io/v2/${repo}/manifests/${tag}`, { headers: H })).json();
  const list = index.manifests || [index];
  const amd64 = list.find((m) => (m.platform?.architecture || 'amd64') === 'amd64' && (m.platform?.os || 'linux') === 'linux');
  if (!amd64?.digest) throw new Error(`no linux/amd64 manifest for ${repo}:${tag}`);
  say(`management ← ${repo}:${tag} (linux/amd64 ${amd64.digest.slice(0, 19)}…)`);
  const manifest = await (await fetch(`https://registry-1.docker.io/v2/${repo}/manifests/${amd64.digest}`,
    { headers: { ...H, Accept: 'application/vnd.oci.image.manifest.v1+json' } })).json();

  // Layers are an overlay: a later layer WINS, so search from the top down and stop at the first
  // layer carrying the binary — the smallest download that is also the correct one (in practice
  // the 19.5MB top layer, not all 90MB).
  let found = false;
  for (const layer of [...(manifest.layers || [])].reverse()) {
    const blob = join(tmpdir(), `netbird-mgmt-layer-${layer.digest.slice(7, 19)}.tar.gz`);
    say(`  layer ${layer.digest.slice(7, 19)}… (${(layer.size / 1e6).toFixed(1)}MB)`);
    await download(`https://registry-1.docker.io/v2/${repo}/blobs/${layer.digest}`, blob, { Authorization: `Bearer ${auth.token}` });
    const members = tarMembers(readFileSync(blob));
    rmSync(blob, { force: true });
    const hit = members.find((m) => m.name === 'go/bin/netbird-mgmt' || m.name.endsWith('/netbird-mgmt'));
    if (!hit) continue;
    writeFileSync(mgmtPath, hit.data);
    verify(mgmtPath, 'netbird-mgmt');
    found = true;
    break;
  }
  if (!found) throw new Error(`none of ${manifest.layers?.length} layers carried go/bin/netbird-mgmt`);
  say(`management pinned: ${mgmtPath}`);
}

for (const [name, p] of [['netbird', clientPath], ['netbird-mgmt', mgmtPath]]) {
  if (!existsSync(p)) throw new Error(`${name} missing after fetch`);
  say(`${name}: ${(statSync(p).size / 1e6).toFixed(1)}MB sha256 ${sha256(p).slice(0, 16)}…`);
}
console.log(`\n✓ NetBird ${PINNED.version} pinned into ${dir}`);
console.log('  run the live proof:  node test/netbird-live-api.test.mjs');

// ── a minimal USTAR/GNU-tar walker ─────────────────────────────────────────────────────────────
// Enough for these two tarballs: 512-byte headers, octal sizes, prefix field, and the GNU 'L'
// long-name entry (PAX 'x'/'g' headers are skipped — the members we want are short-named).
function tarMembers(gz) {
  const buf = gunzipSync(gz);
  const out = [];
  let off = 0;
  let longName = null;
  const field = (block, s, e) => block.subarray(s, e).toString('utf8').replace(/\0.*$/, '').trim();
  while (off + 512 <= buf.length) {
    const block = buf.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break;
    const size = parseInt(field(block, 124, 136) || '0', 8) || 0;
    const type = String.fromCharCode(block[156]);
    const dataStart = off + 512;
    const data = buf.subarray(dataStart, dataStart + size);
    const next = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/, ''); off = next; continue; }
    if (type === 'x' || type === 'g') { off = next; continue; }
    const prefix = field(block, 345, 500);
    let name = field(block, 0, 100);
    if (longName) { name = longName; longName = null; } else if (prefix) name = `${prefix}/${name}`;
    out.push({ name, data });
    off = next;
  }
  return out;
}
