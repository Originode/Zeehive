// FILE-UPLOAD COMPOSERS test — the console's two composers used to accept ONLY images; this pins
// that they now accept ANY file type, and that the file reaches the zee under its real name.
//
// The 📨 MessageComposer (operator → live zee) and the ➕ Dispatch composer (prompt → new zee) both
// restricted attachment input to `image/*` — picker `accept`, paste filter and drop filter all
// checked `type.startsWith('image/')`. A human wanting to hand a zee a CSV, a log or a PDF had no
// way to do it. Now any file rides the same base64-data-URL body; images still render as thumbnails
// and everything else renders as a 📎 file chip. The wire field keeps its legacy name `images` so
// the API contract (Hermes bridge, router, CLI dispatch) never had to move.
//
// Static source + stylesheet check (the repo's app-dialog-imports pattern): the filters and labels
// are plain JSX/JS, so reading the source is enough to stop this regressing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');
const msg = read('../web/src/MessageComposer.jsx');
const disp = read('../web/src/Dispatch.jsx');
const zt = read('../web/src/ZeeTerminal.jsx');
const app = read('../web/src/App.jsx');
const nudge = read('../server/src/queenzee/nudge.js');
const intake = read('../server/src/queenzee/intake.js');
const css = read('../web/src/styles.css');

let failures = 0;
const ok = (cond, msgText) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msgText}`); if (!cond) failures++; };

console.log('\n── the 📨 MessageComposer accepts any file, not just images ──');
ok(!/accept="image\/\*"/.test(msg), 'the file picker no longer restricts to image/*');
ok(!/\.filter\(\(f\) => f\.type\.startsWith\('image\/'\)\)/.test(msg), 'the drop/pick path does not filter by image type');
ok(!/it\.kind === 'file' && it\.type\.startsWith\('image\/'\)/.test(msg), 'the paste path does not filter by image type');
ok(/msg-filechip/.test(msg), 'a non-image attachment renders as a 📎 file chip, not a broken <img>');
ok(/📎 attach files/.test(msg), 'the attach button names files, not images');
ok(/images: attachments\.map/.test(msg), 'the wire field stays `images` (legacy) but maps from the attachments state');
ok(!/pasted-image\.png/.test(msg), 'a nameless pasted file gets a type-derived name, not a hard-coded .png');

console.log('\n── the ➕ Dispatch composer accepts any file, not just images ──');
ok(!/it\.kind === 'file' && it\.type\.startsWith\('image\/'\)/.test(disp), 'the paste path does not filter by image type');
ok(/disp-filechip/.test(disp), 'a non-image attachment renders as a 📎 file chip');
ok(/images: attachments\.map/.test(disp), 'the wire field stays `images` (legacy) but maps from the attachments state');
ok(!/an image alone is not enough/.test(disp), 'the "needs a task" error no longer says an image alone is not enough');
ok(/attachment\{attachments\.length === 1 \? '' : 's'\}/.test(disp), 'the summary line counts attachments, not images');

console.log('\n── the server hands the zee the file under its REAL name ──');
ok(/attachmentFileName\(/.test(nudge), 'nudge.js names inbox files from the original filename');
ok(!/image-\$\{i \+ 1\}/.test(nudge), 'the generic image-N naming is gone');
ok(/attachments = \[\]/.test(nudge), 'sendMessageToXell takes `attachments`, not `images`');
ok(/attached file\(s\)/.test(nudge), 'the typed pointer says attached files');
ok(nudge.includes(".replace(/[^A-Za-z0-9._-]/g, '_')"),
   'a hostile filename (path separators, shell chars) is sanitized before it lands in .zee-inbox');
ok(nudge.includes(".replace(/^\\.+/, '')"),
   '…and leading dots are stripped (no hidden/traversal names)');
ok(/saveDispatchAttachments\(/.test(intake), 'intake.js renamed saveDispatchImages → saveDispatchAttachments');
ok(/## Attached files/.test(intake), 'the prompt block says Attached files');
ok(!/## Attached images/.test(intake), '…not Attached images');

console.log('\n── the message/talk window COPY says files, not images ──');
ok(!/long text and images/.test(zt), 'the 💬 talk tooltip no longer tells a human "images"');
ok(/long text and any files/.test(zt), '…it says long text and ANY FILES are handed over');
ok(!/Uploading \$\{nImg\} image/.test(app), 'the dispatch toast no longer says "Uploading N image(s)"');
ok(/Uploading \$\{nAtt\} attachment/.test(app), '…it counts attachments');
ok(!/open the long-text\/image composer/.test(app), 'the 📨 comment no longer says "image composer"');

console.log('\n── the stylesheets back the new file chips ──');
ok(/\.msg-filechip/.test(css), '.msg-filechip is styled in the stylesheet');
ok(/\.disp-filechip/.test(css), '.disp-filechip is styled in the stylesheet');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED ✓');
process.exit(failures ? 1 : 0);
