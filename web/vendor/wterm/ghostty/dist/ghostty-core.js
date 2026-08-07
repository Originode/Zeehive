import { loadGhosttyWasm, parseCell, writeString as wasmWriteString, writeBytes as wasmWriteBytes, allocBuffer, freeBuffer, CELL_BYTES, } from "./wasm-bindings.js";
const DEFAULT_COLOR = 256;
const WTERM_FLAG_BOLD = 0x01;
const WTERM_FLAG_DIM = 0x02;
const WTERM_FLAG_ITALIC = 0x04;
const WTERM_FLAG_UNDERLINE = 0x08;
const WTERM_FLAG_BLINK = 0x10;
const WTERM_FLAG_REVERSE = 0x20;
const WTERM_FLAG_INVISIBLE = 0x40;
const WTERM_FLAG_STRIKETHROUGH = 0x80;
// Our WASM layer packs flags in the same order as wterm (see wasm_api.zig):
//   bold=1, faint=2, italic=4, underline=8, blink=16, inverse=32,
//   invisible=64, strikethrough=128
// This matches wterm's layout exactly, so no remapping is needed.
const _FLAG_SANITY_CHECK = [
    WTERM_FLAG_BOLD,
    WTERM_FLAG_DIM,
    WTERM_FLAG_ITALIC,
    WTERM_FLAG_UNDERLINE,
    WTERM_FLAG_BLINK,
    WTERM_FLAG_REVERSE,
    WTERM_FLAG_INVISIBLE,
    WTERM_FLAG_STRIKETHROUGH,
];
void _FLAG_SANITY_CHECK;
function packRgb(r, g, b) {
    return (r << 16) | (g << 8) | b;
}
const BLANK_CELL = {
    char: 32,
    fg: DEFAULT_COLOR,
    bg: DEFAULT_COLOR,
    flags: 0,
    width: 1,
};
/**
 * Terminal core powered by libghostty built from source. Implements the
 * same `TerminalCore` interface as wterm's built-in Zig core, providing
 * full-featured VT emulation including proper Unicode grapheme handling,
 * all SGR attributes, terminal modes, and more.
 *
 * @example
 * ```ts
 * import { WTerm } from '@wterm/dom';
 * import { GhosttyCore } from '@wterm/ghostty';
 *
 * const core = await GhosttyCore.load();
 * const term = new WTerm(el, { core });
 * await term.init();
 * ```
 */
export class GhosttyCore {
    constructor(wasm, options) {
        this.termPtr = 0;
        this._viewportBufPtr = 0;
        this._viewportBufSize = 0;
        this._viewportView = null;
        this._viewportStale = true;
        this._cols = 0;
        this._rows = 0;
        // One decoded scrollback row, reused across the per-column reads the
        // renderer does for that row.
        this._scrollbackBufPtr = 0;
        this._scrollbackBufSize = 0;
        this._scrollbackView = null;
        this._scrollbackOffset = -1;
        this._scrollbackLen = 0;
        this.wasm = wasm;
        this._options = options;
    }
    /**
     * Load the ghostty-vt WASM binary and create a new `GhosttyCore`.
     * The returned core is ready to be passed as the `core` option to `WTerm`.
     */
    static async load(options = {}) {
        const wasm = await loadGhosttyWasm(options.wasmPath);
        return new GhosttyCore(wasm, options);
    }
    // -- Lifecycle --
    init(cols, rows) {
        this._cols = cols;
        this._rows = rows;
        const scrollback = this._options.scrollbackLimit ?? 10000;
        this.termPtr = this.wasm.exports.init(cols, rows, scrollback);
        this._allocViewportBuffer();
        this._invalidate();
    }
    resize(cols, rows) {
        this._cols = cols;
        this._rows = rows;
        this.wasm.exports.resize(this.termPtr, cols, rows);
        this._allocViewportBuffer();
        this._invalidate();
    }
    // -- I/O --
    writeString(str) {
        wasmWriteString(this.wasm, this.termPtr, str);
        this._invalidate();
    }
    writeRaw(data) {
        wasmWriteBytes(this.wasm, this.termPtr, data);
        this._invalidate();
    }
    // -- Grid --
    getCell(row, col) {
        this._ensureViewport();
        const view = this._viewportView;
        if (!view)
            return BLANK_CELL;
        const idx = row * this._cols + col;
        const byteOffset = idx * CELL_BYTES;
        if (byteOffset + CELL_BYTES > this._viewportBufSize)
            return BLANK_CELL;
        const cell = parseCell(view, byteOffset);
        // A continuation cell carries no content of its own, so the blank test
        // matches it. Returning BLANK_CELL would hide the width the renderer
        // needs to skip it.
        if (cell.codepoint === 0 &&
            cell.flags === 0 &&
            cell.colorFlags === 0 &&
            cell.width !== 0)
            return BLANK_CELL;
        const result = {
            char: cell.codepoint || 32,
            fg: DEFAULT_COLOR,
            bg: DEFAULT_COLOR,
            flags: cell.flags,
            width: cell.width,
        };
        if (cell.colorFlags & 1)
            result.fgRgb = packRgb(cell.fgR, cell.fgG, cell.fgB);
        if (cell.colorFlags & 2)
            result.bgRgb = packRgb(cell.bgR, cell.bgG, cell.bgB);
        return result;
    }
    isDirtyRow(row) {
        this._ensureViewport();
        return this.wasm.exports.is_dirty_row(this.termPtr, row) !== 0;
    }
    clearDirty() {
        this.wasm.exports.clear_dirty(this.termPtr);
        this._viewportStale = true;
    }
    getCols() {
        return this._cols;
    }
    getRows() {
        return this._rows;
    }
    // -- Cursor --
    getCursor() {
        this._ensureViewport();
        return {
            row: this.wasm.exports.get_cursor_row(this.termPtr),
            col: this.wasm.exports.get_cursor_col(this.termPtr),
            visible: this.wasm.exports.get_cursor_visible(this.termPtr) !== 0,
        };
    }
    // -- Modes --
    cursorKeysApp() {
        return this.wasm.exports.cursor_keys_app(this.termPtr) !== 0;
    }
    bracketedPaste() {
        return this.wasm.exports.bracketed_paste(this.termPtr) !== 0;
    }
    usingAltScreen() {
        return this.wasm.exports.using_alt_screen(this.termPtr) !== 0;
    }
    // -- Side outputs --
    getTitle() {
        // Title changes are delivered through OSC sequences which the
        // ReadonlyStream handler doesn't capture. A full stream handler
        // would be needed for title support.
        return null;
    }
    getResponse() {
        const bufSize = 4096;
        const bufPtr = allocBuffer(this.wasm, bufSize);
        if (bufPtr === 0)
            return null;
        const len = this.wasm.exports.read_response(this.termPtr, bufPtr, bufSize);
        if (len === 0) {
            freeBuffer(this.wasm, bufPtr, bufSize);
            return null;
        }
        const bytes = new Uint8Array(this.wasm.exports.memory.buffer, bufPtr, len);
        const text = new TextDecoder().decode(bytes);
        freeBuffer(this.wasm, bufPtr, bufSize);
        return text;
    }
    // -- Scrollback --
    getScrollbackCount() {
        return this.wasm.exports.get_scrollback_count(this.termPtr);
    }
    getScrollbackCell(offset, col) {
        const len = this._ensureScrollbackLine(offset);
        const view = this._scrollbackView;
        if (!view || col >= len)
            return BLANK_CELL;
        const cell = parseCell(view, col * CELL_BYTES);
        const result = {
            char: cell.codepoint || 32,
            fg: DEFAULT_COLOR,
            bg: DEFAULT_COLOR,
            flags: cell.flags,
            width: cell.width,
        };
        if (cell.colorFlags & 1)
            result.fgRgb = packRgb(cell.fgR, cell.fgG, cell.fgB);
        if (cell.colorFlags & 2)
            result.bgRgb = packRgb(cell.bgR, cell.bgG, cell.bgB);
        return result;
    }
    getScrollbackLineLen(offset) {
        return this._ensureScrollbackLine(offset);
    }
    // -- Debug --
    getUnhandledSequences() {
        return [];
    }
    // -- Internal helpers --
    _invalidate() {
        this._viewportStale = true;
        this._scrollbackOffset = -1;
    }
    _allocViewportBuffer() {
        if (this._viewportBufPtr !== 0) {
            freeBuffer(this.wasm, this._viewportBufPtr, this._viewportBufSize);
        }
        this._viewportBufSize = this._cols * this._rows * CELL_BYTES;
        this._viewportBufPtr = allocBuffer(this.wasm, this._viewportBufSize);
        this._viewportView = null;
        this._viewportStale = true;
        if (this._scrollbackBufPtr !== 0) {
            freeBuffer(this.wasm, this._scrollbackBufPtr, this._scrollbackBufSize);
        }
        this._scrollbackBufSize = this._cols * CELL_BYTES;
        this._scrollbackBufPtr = allocBuffer(this.wasm, this._scrollbackBufSize);
        this._scrollbackView = null;
        this._scrollbackOffset = -1;
    }
    /**
     * Decode one scrollback row into the shared buffer, at most once per row
     * per invalidation, and return its length. The renderer reads a row column
     * by column, so without this each cell would cost a page-list walk.
     */
    _ensureScrollbackLine(offset) {
        if (this._scrollbackBufPtr === 0)
            return 0;
        if (this._scrollbackOffset !== offset) {
            this._scrollbackLen = this.wasm.exports.get_scrollback_line(this.termPtr, offset, this._scrollbackBufPtr, this._cols);
            this._scrollbackOffset = offset;
        }
        // Growing WASM memory detaches the view, and a cached row outlives any
        // grow an unrelated read triggers in between, so check on hits too.
        if (this._scrollbackView?.buffer !== this.wasm.exports.memory.buffer) {
            this._scrollbackView = new DataView(this.wasm.exports.memory.buffer, this._scrollbackBufPtr, this._scrollbackBufSize);
        }
        return this._scrollbackLen;
    }
    _ensureViewport() {
        if (!this._viewportStale)
            return;
        this.wasm.exports.update(this.termPtr);
        this.wasm.exports.get_viewport(this.termPtr, this._viewportBufPtr);
        this._viewportView = new DataView(this.wasm.exports.memory.buffer, this._viewportBufPtr, this._viewportBufSize);
        this._viewportStale = false;
    }
}
//# sourceMappingURL=ghostty-core.js.map