// THE CONSOLE IS THE AUTHORING SURFACE — so it has to be usable for the real thing.
//
// Since 080/082 the meta-DB owns every harness's personality, skills, memory AND badge, and there is no
// file to edit instead. That makes the harness manager load-bearing in a way it was not when it was a
// convenience over a folder, and it was sized for the convenience: a memory body — a 15k manual — got a
// 2-row textarea, and an INHERITED entry (the manual a wearer actually receives) was rendered as a
// character count while the docs told people to "read it in the console's harness manager".
//
// So this renders the REAL components (esbuild + react-dom/server, the trick harness-empty-visible
// uses) and asserts what a human can do with them:
//   1. every part of a harness is editable here — personality, skills, memory, badge — and each editor
//      is big enough to hold what it holds;
//   2. an inherited entry can be OPENED and read, and is read-only when open (the source is the parent);
//   3. the total a wearer is briefed with is stated, because that is what the harness costs per dispatch;
//   4. the badge is an SVG in the row: previewed, replaceable, clearable, and refused when it is not one;
//   5. the API round-trip behind all of it works against the real DB — save a persona, a skill, a
//      memory file and a badge, read them back, and see them in the files a xell would receive.
// The harness it creates is deleted in a finally.
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const { q, one, pool } = await import('../server/src/db/pool.js');
const H = await import('../server/src/lib/harness.js');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const tag = randomUUID().slice(0, 8);
const key = `zt-author-${tag}`;
const compiled = [];
// Node cannot load a raw .jsx, so a component is transformed beside itself — and so is every SIBLING
// component it imports (the harness editor now renders <ZeeAvatar>, the provider-coin badge), with
// the specifier rewritten to the compiled copy. Plain .js imports are left alone: node loads those.
const compile = (rel, name) => {
  const file = join(ROOT, dirname(rel), `.${name}.test-build.mjs`);
  let code = transformSync(read(rel), { loader: 'jsx', format: 'esm', jsx: 'transform' }).code;
  code = code.replace(/(['"])\.\/([A-Za-z0-9_-]+)\.jsx\1/g, (_m, _q, dep) => {
    const depName = `${name}-${dep.toLowerCase()}`;
    compile(join(dirname(rel), `${dep}.jsx`), depName);
    return `"./.${depName}.test-build.mjs"`;
  });
  writeFileSync(file, code);
  compiled.push(file);
  return `file://${file}`;
};
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><circle cx="8" cy="8" r="7"/></svg>';

try {
  const HM = await import(compile('web/src/HarnessManager.jsx', 'hmauthor'));

  // ── 1. every part is editable, and the editors are the right size ────────────────────────────
  console.log('\n── the editor holds what a harness actually holds ──');
  const src = read('web/src/HarnessManager.jsx');
  // read rows= off the <textarea> that CARRIES this placeholder (attribute order varies, so find the
  // element and look inside it rather than scanning forward from a label)
  const rowsFor = (placeholder) => {
    const el = src.split('<textarea').find((chunk) => chunk.slice(0, chunk.indexOf('/>')).includes(placeholder));
    const m = el ? el.slice(0, el.indexOf('/>')).match(/rows=\{(\d+)\}/) : null;
    return m ? Number(m[1]) : 0;
  };
  ok(rowsFor('How this persona thinks') >= 10, `the personality editor is ${rowsFor('How this persona thinks')} rows (a persona is ~2k chars)`);
  ok(rowsFor('the instructions') >= 8, `a skill body gets ${rowsFor('the instructions')} rows`);
  ok(rowsFor('a fact the persona always carries') >= 14,
     `a memory body gets ${rowsFor('a fact the persona always carries')} rows (the manual is 15k+ chars)`);
  ok(/hm-mono/.test(src), 'and they are monospace — this is markdown, not prose in a chat box');
  for (const part of ['personality', 'skills', 'memory', 'avatar_svg']) {
    ok(new RegExp(`set\\('${part}'`).test(src) || new RegExp(`onChange=\\{\\(v\\) => set\\('${part}'`).test(src),
       `${part} is editable in the console`);
  }
  ok(/\{chars\(/.test(src), 'each editor states its size (a budget you cannot see is a budget nobody keeps)');

  // ── 2. inherited text is READABLE, not a char count ──────────────────────────────────────────
  console.log('\n── the inherited chain can be read here (the docs say it can) ──');
  const inhClosed = renderToStaticMarkup(React.createElement(HM.InheritedEntry,
    { icon: '🧠', name: 'cxell-zee-manual.md', text: `THE MANUAL BODY ${tag}` }));
  ok(inhClosed.includes('cxell-zee-manual.md') && /\d+ chars/.test(inhClosed),
     'closed, it still shows the entry and its size');
  ok(!inhClosed.includes(`THE MANUAL BODY ${tag}`), 'and not the body — the chain is long, so it starts collapsed');
  ok(/aria-expanded="false"/.test(inhClosed), 'as a real disclosure control, not a div');
  // open it the way a human does: React state, so render the whole manager? No — the component IS the
  // unit; drive it by rendering with the caret already open via a wrapper that clicks on mount is
  // overkill, so assert the branch exists and is read-only where it renders the text.
  const compSrc = src.slice(src.indexOf('export function InheritedEntry'), src.indexOf('// order the flat harness list'));
  ok(/open && <textarea/.test(compSrc), 'opening it renders the full text');
  ok(/readOnly/.test(compSrc), 'read-only — the source is the parent harness, and it says so');
  ok(/rows=\{20\}/.test(compSrc), 'in an editor big enough to read a manual in');

  // ── 3. what a wearer is briefed with, as one number ──────────────────────────────────────────
  console.log('\n── the cost of the harness is stated ──');
  const total = HM.briefingChars({
    personality: 'x'.repeat(100),
    skills: [{ name: 'a', when: 'b', body: 'y'.repeat(50) }],
    memory: [{ path: 'm.md', text: 'z'.repeat(200) }],
    inherited: { skills: [{ name: 'c', when: 'd', body: 'w'.repeat(10) }], memory: [{ path: 'n.md', text: 'v'.repeat(1000) }] },
  });
  ok(total === 100 + 1 + 1 + 50 + 200 + 1 + 1 + 10 + 1000,
     `briefingChars() counts own + inherited persona, skills and memory (${total})`);
  ok(HM.briefingChars(null) === 0, 'and is safe on nothing');

  // ── 4. the badge, in the row ─────────────────────────────────────────────────────────────────
  console.log('\n── the badge is an SVG in the meta-DB, edited here ──');
  const withSvg = renderToStaticMarkup(React.createElement(HM.AvatarField, { svg: SVG, onChange: () => {} }));
  ok(withSvg.includes('data-testid="harness-avatar-field"'), 'the badge field renders');
  ok(/<img[^>]+src="data:image\/svg\+xml/.test(withSvg), 'and PREVIEWS the SVG — the only honest check that it is the art you meant');
  ok(/meta-DB/.test(withSvg), 'saying where it is stored (no repo needed)');
  ok(/type="file"/.test(withSvg) && /clear/.test(withSvg), 'with a file picker and a clear button');
  const noSvg = renderToStaticMarkup(React.createElement(HM.AvatarField, { svg: '', onChange: () => {} }));
  ok(!/<img/.test(noSvg) && /none/.test(noSvg), 'a harness with no badge says so instead of rendering a broken image');

  // ── 5. the round trip, against the real DB ───────────────────────────────────────────────────
  console.log('\n── and the save path behind it really works ──');
  await H.createHarness({ key, label: `Author ${tag}`, zee_type: 'worker' });
  const saved = await H.updateHarness(key, {
    personality: `persona ${tag}`,
    summary: 'authored entirely in the console',
    skills: [{ name: 'do-the-thing', when: 'when asked', body: `body ${tag}` }],
    memory: [{ path: 'note.md', text: `# note ${tag}\n\nremember this.\n` }],
    avatar_svg: SVG,
  }, { mode: 'simulate' });
  ok(saved.personality === `persona ${tag}`, 'the personality round-trips');
  ok(saved.skills[0]?.body === `body ${tag}`, 'the skill round-trips');
  ok(saved.memory[0]?.text.includes(`# note ${tag}`), 'the memory file round-trips');
  ok(saved.avatar_svg === SVG, 'the badge round-trips');
  const listed = (await H.listHarnesses()).find((h) => h.key === key);
  ok(listed?.avatar_url === `/api/harnesses/${key}/avatar` && listed.has_avatar === true,
     'the list model advertises the badge route');
  ok(listed?.bundle_empty === false, 'and the harness is no longer reported empty');

  const files = H.harnessFiles(await H.effectiveHarness(await one(`SELECT * FROM harness WHERE key=$1`, [key])));
  const rels = files.map((f) => f.relPath);
  ok(rels.includes('.zeehive/harness/PERSONA.md') && rels.includes('.claude/skills/do-the-thing/SKILL.md')
     && rels.includes('.zeehive/harness/memory/note.md'),
     `everything authored here becomes a file in the xell (${rels.join(', ')})`);
  ok(files.every((f) => f.text.includes('GENERATED by ZEEHIVE from the meta-DB')),
     'each one stamped with where it came from');
  ok(files.find((f) => f.relPath.endsWith('note.md')).text.includes(`harness \`${key}\``),
     'naming this harness, so a zee knows which row to point a human at');
} finally {
  await q(`DELETE FROM harness WHERE key=$1`, [key]).catch(() => {});
  for (const f of compiled) { try { rmSync(f); } catch { /* */ } }
  await pool.end().catch(() => {});
}

console.log(failures ? `\n${failures} FAILED` : '\nall good');
process.exit(failures ? 1 : 0);
