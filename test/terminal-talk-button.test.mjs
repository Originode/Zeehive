// TERMINAL TALK-BUTTON test — the conversation door in a cxell zee's terminal.
//
// "let me converse with zee managers in terminal of their xell… when i said readonly i didnt mean
// the terminal was readonly." The web app is deliberately read-only about the FLEET (no prompting
// there — HANDOFF.md says so, and that stands); the terminal is not part of that stance. It is the
// place a human stands when they want to talk to a zee, and while the zee was mid-turn the pane
// was its transcript feed, which reads nothing: typing there reached nobody, silently.
//
// So the header carries 💬 talk, and this pins what it must keep being:
//   • present only on the ZEE door (a container shell has no zee to converse with);
//   • the SAME composer 📨 opens — one delivery path, one set of rules for long text and images;
//   • loud (`urge`) exactly while a live feed owns the pane — the one state in which typing into
//     the terminal does nothing;
//   • and a receipt that says which of the two things happened, in words, into the pane.
//
// Static source + stylesheet check (the repo's app-dialog-imports pattern): the header is plain
// JSX, so reading it is enough to stop this regressing.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(resolve(here, rel), 'utf8');
const src = read('../web/src/ZeeTerminal.jsx');
const app = read('../web/src/App.jsx');
const css = read('../web/src/styles.css');

let failures = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`); if (!cond) failures++; };

const head = src.slice(src.indexOf('<div className={`term-head'), src.indexOf('<div className="zeeterm-main"'));

console.log('\n── the header carries one talk door ──');
ok(head.includes('data-testid="talk-toggle"'), '💬 talk is in the terminal header');
ok((head.replace(/\{\/\*[\s\S]*?\*\/\}/g, '').match(/💬/g) || []).length === 1,
   'exactly one of them (comments aside)');
ok(/\{xell\?\.id && \(/.test(head),
   'and only when the modal was given a xell — a container shell has no zee to converse with');
ok(/feed\.live === true \? ' urge' : ''/.test(head.replace(/\s+/g, ' ')) || /urge/.test(head),
   'it wears `urge` while a live feed owns the pane (the state in which typing reaches nobody)');
ok(/MID-TURN/.test(head), 'its tooltip says the zee is mid-turn and what will happen to the message');

console.log('\n── it opens the SAME composer the hexagon 📨 button does ──');
ok(/import MessageComposer from '\.\/MessageComposer\.jsx'/.test(src), 'it imports MessageComposer');
ok(/<MessageComposer xell=\{xell\}/.test(src), 'and renders it against this xell');
ok(!/sendXellMessage|fetch\(/.test(src),
   'the terminal does NOT grow its own delivery path — one door, one set of rules about long text and images');

console.log('\n── the receipt tells the truth about delivery ──');
const receipt = src.slice(src.indexOf('const talkReceipt'), src.indexOf('const toggleExplorer'));
ok(/const queued = feed\.live === true/.test(receipt),
   'it reads who owns the pane from the bridge, rather than assuming a happy path');
ok(/QUEUED/.test(receipt) && /the moment the turn ends/.test(receipt),
   'a mid-turn message is reported as QUEUED, and says when it will arrive');
ok(/typed into the zee's live session/.test(receipt), 'an idle zee is reported as typed in');
ok(/attachments/.test(receipt), 'and attachments handed over to .zee-inbox are named');
ok(/\\x1b\[2m/.test(receipt), 'printed dim, so a receipt is never mistaken for something the zee said');

console.log('\n── the console hands the terminal the xell it needs ──');
ok((app.match(/<ZeeTerminal /g) || []).length === (app.match(/xellId=\{/g) || []).length
   && /xellId=\{termXell\.id\}/.test(app) && /xellId=\{x\.id\}/.test(app),
   'both ZeeTerminal call sites (the flower and the card) pass xellId — otherwise the button is dark');

console.log('\n── the stylesheet backs the two states ──');
ok(/\.term-x\.talk\b/.test(css), '.term-x.talk is styled as a labelled button, not a bare glyph');
ok(/\.term-x\.talk\.urge/.test(css), 'and .urge is a distinct, visible state');
ok(/💬 talk/.test(src.slice(src.indexOf('const foot ='))),
   'the footer hint names it too, so it is findable without hovering');

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED ✓');
process.exit(failures ? 1 : 0);
