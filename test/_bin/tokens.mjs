// FAKE-TOKEN GENERATOR — every vendor's credential SHAPE, built at runtime so no literal exists.
//
// WHY (2026-08-04 → 07). The repo's credential tests need realistic token SHAPES, and for a long
// time they used hand-written literals. One of those — a fabricated DeepSeek key, `sk-` followed
// by 32 invented HEX characters — was EXACTLY the pattern GitHub's push protection scans for. Every
// push of the repo was refused (GH013) until the literal was replaced, and it keeps threatening to
// come back because a "realistic" fake is one typo from being a vendor pattern.
//
// This module is the durable fix: it GENERATES each vendor's token shape at runtime. A generated
// string is a valid shape to OUR predicates (lib/provider-tokens.js `valid`) but never matches a
// VENDOR's published pattern — by construction, not by care. The two techniques, both inherited
// from the repo's own lint (test/secret-shaped-fixtures.test.mjs):
//   • break the character class — DeepSeek's shape is `sk-` + 32 HEX; an alnum tail with letters
//     past 'f' is accepted by our predicates and can never be hex;
//   • build at runtime — a PAT assembled from a prefix + a repeat() exists only in memory, not as a
//     literal in any file GitHub scans.
//
// Each generator takes a fixed SEED so a test's tokens are stable across runs (and the masking
// assertions in the tests keep working), while the tail is never a hex/known-pattern run.

// A non-hex alnum run: letters past 'f' make it impossible to be 32 hex chars, and it still
// satisfies every `sk-<alnum>` / `xai-<alnum>` / `kc<alnum>` shape predicate.
const ALNUM = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';   // no a-f-hex-only tail risk: has letters > f
const pick = (n) => { let s = ''; for (let i = 0; i < n; i++) s += ALNUM[i % ALNUM.length]; return s; };
const seed = (n) => pick(n);   // deterministic per-call length

export const fakeTokens = {
  // sk-ant-oat01-<base64ish> — claude's shape. Our predicate wants ≥20 tail; GitHub's Anthropic
  // pattern wants ≥80. 24 is comfortably between: satisfies ours, never trips theirs.
  claude: () => `sk-ant-oat01-${seed(24)}-CAAA`,
  // sk-<alnum> — openai/deepseek generic shape. Our predicate wants ≥20; GitHub's generic wants
  // exactly 48 and its DeepSeek wants exactly 32 hex. 28 alnum with letters>f satisfies ours and
  // is neither a 48-char OpenAI nor a 32-hex DeepSeek.
  openai: () => `sk-${seed(28)}`,
  openaiProject: () => `sk-proj-${seed(30)}`,   // ours wants ≥20; GitHub's project wants ≥74 → safe at 30
  deepseek: () => `sk-${seed(28)}`,             // alnum, never 32 hex — the 2026-08-04 shape, fixed
  kimi: () => `kc${seed(24)}`,                  // kimi's shape: "20+ alnum, not sk-ant-"
  github: () => `github_pat_11${'A'.repeat(40)}`,   // fine-grained PAT, built at runtime (repeat())
  // classic PAT: `ghp_` + alnum. The lint scans for EXACTLY 36 chars, so a 24-char alnum tail
  // satisfies our `gh[opus]_` shape (20+) and can never trip the vendor scanner's fixed-length 36.
  githubClassic: () => `ghp_${seed(24)}`,
  grok: () => `xai-${seed(28)}`,                 // xai-<alnum>; ours wants ≥20
  // grok's OTHER shape: the ~/.grok/auth.json a `grok login --device-auth` writes for a SuperGrok /
  // Business seat. Keyed by auth SCOPE, and every entry carries key + auth_mode + create_time +
  // user_id (the CLI's serde names each missing field in turn). Built at runtime like the rest, and
  // the key is a plain alnum run — a seat session has no vendor prefix for a scanner to match.
  grokSession: ({ createTime = '2026-08-01T00:00:00Z' } = {}) => JSON.stringify({
    'https://accounts.x.ai/sign-in': {
      key: seed(40), auth_mode: 'web_login', create_time: createTime, user_id: `u-${seed(8)}`,
    },
  }),
};
