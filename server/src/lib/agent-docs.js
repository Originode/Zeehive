// THE ENTRY-POINT FILE CONVENTIONS OF EVERY AI CODING AGENT — one source, many generated files.
//
// A project's agent-facing instructions are ONE piece of writing. What differs per tool is only the
// FILENAME it opens: Claude Code reads CLAUDE.md, Codex reads AGENTS.md, Gemini CLI reads GEMINI.md,
// Copilot reads .github/copilot-instructions.md, Cursor reads .cursor/rules/*.mdc — and a repo that
// wants to be worked on by more than one of them ends up with N hand-copied files that drift apart
// the first time somebody edits one.
//
// So the meta-DB holds the CONTENTS (project_doc.body — the source of truth an operator writes in the
// console's Docs tab) and this table holds the FILENAMES. The queenzee generates one file per target
// when a zee is assigned to the project (lib/project-docs.js), each stamped as generated and each
// carrying that xell's own stack inventory (lib/xell-stack.js).
//
// WHY ONE ENTRY PER FILE, NOT PER VENDOR: a dozen tools read AGENTS.md. Keying this list by tool
// would generate the same path a dozen times and make the winner an accident of ordering, so each
// entry is a FILE and `reads` names the tools that open it. Enabling "AGENTS.md" is enabling all of
// them at once, which is the whole point of that standard.
//
// KEEPING IT HONEST: `url` is the vendor's own documentation for the path — the only thing that can
// settle a disagreement about a convention, and the thing to re-check before editing an entry. These
// conventions move (Windsurf's rules folder is being renamed to .devin/rules; .cursorrules and
// .windsurfrules are deprecated single-file ancestors of the folders below), so this list is
// deliberately explicit and commented rather than clever.
//
// Verified against vendor docs on 2026-07-29; agents.md's own supported-tools list is the source for
// which tools read AGENTS.md.

// A target is:
//   key         stable id stored in project_doc.targets — NEVER rename one (it is data)
//   path        repo-relative file the queenzee writes
//   label       what the console calls it
//   reads       the agents that actually open that path (what an operator is choosing)
//   url         vendor documentation for the convention
//   default     on when a doc is created without an explicit choice
//   frontmatter YAML the file must OPEN with for the tool to apply it always, or null
//   note        the caveat an operator needs before enabling it
export const AGENT_DOC_TARGETS = [
  {
    key: 'agents',
    path: 'AGENTS.md',
    label: 'AGENTS.md',
    reads: ['OpenAI Codex', 'Cursor', 'Gemini CLI', 'GitHub Copilot coding agent', 'Windsurf/Devin',
            'Zed', 'Aider', 'goose', 'opencode', 'Jules', 'Junie', 'Roo Code', 'Amp', 'Warp',
            'Kilo Code', 'Factory', 'Augment', 'Cline'],
    url: 'https://agents.md/',
    default: true,
    frontmatter: null,
    note: 'The cross-tool standard: plain markdown at the repo root, no required fields, and the '
      + 'nearest file in the tree wins. One file, ~20 agents — enable this one first.',
  },
  {
    key: 'claude',
    path: 'CLAUDE.md',
    label: 'CLAUDE.md',
    reads: ['Claude Code', 'Claude Agent SDK', 'GitHub Copilot (as an alternative to AGENTS.md)'],
    url: 'https://docs.claude.com/en/docs/claude-code/memory',
    default: true,
    frontmatter: null,
    note: 'What the zees in THIS fleet read: a cxell zee is `claude` in a container, and CLAUDE.md is '
      + 'the file it is told to open first.',
  },
  {
    key: 'gemini',
    path: 'GEMINI.md',
    label: 'GEMINI.md',
    reads: ['Gemini CLI', 'Gemini Code Assist'],
    url: 'https://github.com/google-gemini/gemini-cli',
    default: false,
    frontmatter: null,
    note: 'Gemini CLI\'s default context file (its `contextFileName` setting can point elsewhere; it '
      + 'also reads AGENTS.md).',
  },
  {
    key: 'copilot',
    path: '.github/copilot-instructions.md',
    label: '.github/copilot-instructions.md',
    reads: ['GitHub Copilot (chat + IDE, repository-wide)'],
    url: 'https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions',
    default: false,
    frontmatter: null,
    note: 'Copilot\'s repository-wide instructions. Its coding AGENT reads AGENTS.md (and will fall '
      + 'back to CLAUDE.md/GEMINI.md); this path is the one the IDE and chat use.',
  },
  {
    key: 'cursor',
    path: '.cursor/rules/zeehive-project.mdc',
    label: '.cursor/rules/*.mdc',
    reads: ['Cursor'],
    url: 'https://cursor.com/docs/context/rules',
    default: false,
    // Cursor's rules engine reads ONLY .mdc in this folder (a .md there is ignored), and a rule with
    // no `alwaysApply` is merely offered to the model — so the frontmatter is what makes it context
    // rather than a suggestion.
    frontmatter: 'alwaysApply: true',
    note: 'Cursor also reads AGENTS.md. Prefer that unless you want a structured, always-applied '
      + 'rule — note the .mdc extension: a .md file in this folder is ignored.',
  },
  {
    key: 'cline',
    path: '.clinerules/zeehive-project.md',
    label: '.clinerules/*.md',
    reads: ['Cline'],
    url: 'https://docs.cline.bot/features/cline-rules',
    default: false,
    frontmatter: null,
    note: 'Cline combines every .md/.txt in .clinerules/ (and also reads AGENTS.md).',
  },
  {
    key: 'windsurf',
    path: '.windsurf/rules/zeehive-project.md',
    label: '.windsurf/rules/*.md',
    reads: ['Windsurf'],
    url: 'https://docs.devin.ai/desktop/cascade/memories',
    default: false,
    // Windsurf activates a rule from its frontmatter; always_on is the mode that matches what a
    // project entry-point doc is for.
    frontmatter: 'trigger: always_on',
    note: 'The LEGACY location — Windsurf is now Devin desktop and reads .devin/rules/*.md first, '
      + 'though this path is still read. Enable `devin` as well if your team has moved.',
  },
  {
    key: 'devin',
    path: '.devin/rules/zeehive-project.md',
    label: '.devin/rules/*.md',
    reads: ['Devin desktop (Windsurf)'],
    url: 'https://docs.devin.ai/desktop/cascade/memories',
    default: false,
    frontmatter: 'trigger: always_on',
    note: 'The current name of the Windsurf rules folder. 12,000 characters per file.',
  },
  {
    key: 'continue',
    path: '.continue/rules/zeehive-project.md',
    label: '.continue/rules/*.md',
    reads: ['Continue'],
    url: 'https://docs.continue.dev/customize/deep-dives/rules',
    default: false,
    frontmatter: null,
    note: 'Continue reads every rule file in .continue/rules/ — and does NOT read AGENTS.md, so this '
      + 'is the only way to reach it.',
  },
  {
    key: 'roo',
    path: '.roo/rules/zeehive-project.md',
    label: '.roo/rules/*.md',
    reads: ['Roo Code'],
    url: 'https://docs.roocode.com/advanced-usage/custom-instructions',
    default: false,
    frontmatter: null,
    note: 'Roo Code also reads AGENTS.md.',
  },
  {
    key: 'amazonq',
    path: '.amazonq/rules/zeehive-project.md',
    label: '.amazonq/rules/*.md',
    reads: ['Amazon Q Developer'],
    url: 'https://docs.aws.amazon.com/amazonq/latest/qdeveloper-ug/context-project-rules.html',
    default: false,
    frontmatter: null,
    note: 'Amazon Q picks up every markdown file in .amazonq/rules/ as project context.',
  },
  {
    key: 'kiro',
    path: '.kiro/steering/zeehive-project.md',
    label: '.kiro/steering/*.md',
    reads: ['Kiro'],
    url: 'https://kiro.dev/docs/steering/',
    default: false,
    frontmatter: null,
    note: 'Kiro calls these steering docs; the folder is always loaded.',
  },
  {
    key: 'junie',
    path: '.junie/guidelines.md',
    label: '.junie/guidelines.md',
    reads: ['JetBrains Junie'],
    url: 'https://www.jetbrains.com/junie/',
    default: false,
    frontmatter: null,
    note: 'Junie\'s own guidelines file (it reads AGENTS.md too). The filename is fixed.',
  },
  {
    key: 'aider',
    path: 'CONVENTIONS.md',
    label: 'CONVENTIONS.md',
    reads: ['Aider'],
    url: 'https://aider.chat/docs/usage/conventions.html',
    default: false,
    frontmatter: null,
    note: 'Aider does not load this on its own — it must be added with `--read CONVENTIONS.md` or in '
      + '.aider.conf.yml. Aider reads AGENTS.md without being asked.',
  },
  {
    key: 'zed',
    path: '.rules',
    label: '.rules',
    reads: ['Zed'],
    url: 'https://zed.dev/docs/ai/rules',
    default: false,
    frontmatter: null,
    note: 'Zed\'s generic rules file (it reads AGENTS.md as well).',
  },
  {
    key: 'goose',
    path: '.goosehints',
    label: '.goosehints',
    reads: ['goose'],
    url: 'https://block.github.io/goose/docs/guides/using-goosehints/',
    default: false,
    frontmatter: null,
    note: 'goose reads AGENTS.md first and .goosehints as its own convention. Not markdown by name, '
      + 'but markdown content is fine.',
  },
];

export const TARGET_KEYS = AGENT_DOC_TARGETS.map((t) => t.key);
export const DEFAULT_TARGET_KEYS = AGENT_DOC_TARGETS.filter((t) => t.default).map((t) => t.key);

export function targetByKey(key) {
  return AGENT_DOC_TARGETS.find((t) => t.key === String(key || '').trim().toLowerCase()) || null;
}

// Order a set of keys the way the registry lists them (AGENTS.md and CLAUDE.md first), drop
// duplicates, and REFUSE anything unknown — a typo'd key that silently generated nothing would be
// the exact failure this whole mechanism exists to remove: an instruction nobody receives.
export function resolveTargets(keys) {
  const want = new Set((Array.isArray(keys) ? keys : [])
    .map((k) => String(k || '').trim().toLowerCase()).filter(Boolean));
  const unknown = [...want].filter((k) => !targetByKey(k));
  if (unknown.length) {
    throw new Error(`unknown agent doc target(s): ${unknown.join(', ')} — known: ${TARGET_KEYS.join(', ')}`);
  }
  return AGENT_DOC_TARGETS.filter((t) => want.has(t.key));
}

// What the console renders: the registry minus the prose that is only useful server-side. Served
// from the API rather than duplicated in web/ — a hard-coded copy of this list in the console is a
// second source of truth for filenames, and it goes stale the first time a vendor renames one.
export function targetCatalogue() {
  return AGENT_DOC_TARGETS.map(({ key, path, label, reads, url, default: def, note }) => ({
    key, path, label, reads, url, default: !!def, note,
  }));
}
