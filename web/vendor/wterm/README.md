# Vendored wterm (xterm alternative)

Snapshot of [@wterm](https://wterm.dev) packages used by the console's optional
DOM terminal engine (`web/src/termHost.js`).

| path | upstream |
|---|---|
| `dom/` | `@wterm/dom@0.3.2` |
| `core/` | `@wterm/core@0.3.2` |
| `ghostty/` | `@wterm/ghostty@0.3.2` (+ `wasm/ghostty-vt.wasm`) |

**Why vendored, not npm.** A Zeehive spinoff webapp is a `runner: process` role.
The fleet's `start-xell-process.sh` only re-runs `npm ci` when `node_modules` is
missing (or incomplete). A branch that *adds* packages to an already-warmed
worktree used to boot vite against a stale tree and die on
`Failed to resolve import "@wterm/dom"`. Vendoring keeps the engine in the
worktree so a collect+build needs no host install.

Vite resolves the package names via aliases in `web/vite.config.js`
(`@wterm/dom`, `@wterm/core`, `@wterm/ghostty`, `@wterm/dom/css`).

To refresh: install the desired versions somewhere, copy `dist/` / `src/` /
`wasm/` / `package.json` in, drop nested `node_modules`, point each package's
`@wterm/core` dependency at `file:../core`, and bump this note.
