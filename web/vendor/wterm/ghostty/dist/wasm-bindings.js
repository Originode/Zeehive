/**
 * Low-level typed bindings to the ghostty-vt WASM module built from
 * our Zig export layer (zig/src/wasm_api.zig).
 *
 * Each exported Zig function maps 1:1 to a property on GhosttyExports.
 * This module handles WASM loading, memory management, and cell parsing.
 */
const CELL_BYTES = 16;
const REMEDY = "Serve the binary from your app and pass its URL: " +
    'GhosttyCore.load({ wasmPath: "/ghostty-vt.wasm" }). The file ships with ' +
    "the package as @wterm/ghostty/ghostty-vt.wasm. See the Bundlers section " +
    "of the @wterm/ghostty README.";
/**
 * Resolve the binary that ships with the package.
 *
 * Bundlers that implement the `new URL(..., import.meta.url)` asset pattern
 * rewrite this to an emitted asset. Ones that do not leave `import.meta.url`
 * pointing at the build machine's copy of this file.
 */
function defaultWasmUrl() {
    return new URL("../wasm/ghostty-vt.wasm", import.meta.url).href;
}
/** `\0asm`. A 404 HTML page otherwise dies as "expected magic word". */
function hasWasmMagic(bytes) {
    if (bytes.byteLength < 4)
        return false;
    const head = new Uint8Array(bytes, 0, 4);
    return (head[0] === 0x00 && head[1] === 0x61 && head[2] === 0x73 && head[3] === 0x6d);
}
/**
 * Load the ghostty-vt WASM module.
 *
 * @param wasmUrl - URL or path to the .wasm file. Defaults to the
 *   committed binary at `../wasm/ghostty-vt.wasm`.
 */
export async function loadGhosttyWasm(wasmUrl) {
    const url = wasmUrl ?? defaultWasmUrl();
    // A file: URL in a browser is a build-machine path that survived bundling.
    // fetch() reports it as a bare "Failed to fetch", which names neither the
    // cause nor the fix.
    if (wasmUrl === undefined &&
        url.startsWith("file:") &&
        typeof document !== "undefined") {
        throw new Error(`@wterm/ghostty: your bundler resolved the WASM URL to ${url}, a path ` +
            `on the machine that built the bundle, so the browser cannot fetch ` +
            `it. ${REMEDY}`);
    }
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`@wterm/ghostty: fetching ${url} returned ${response.status} ` +
            `${response.statusText}. ${REMEDY}`);
    }
    const bytes = await response.arrayBuffer();
    if (!hasWasmMagic(bytes)) {
        throw new Error(`@wterm/ghostty: ${url} did not return a WASM module. ${REMEDY}`);
    }
    let wasmMemory;
    const { instance } = await WebAssembly.instantiate(bytes, {
        env: {
            log(ptr, len) {
                const text = new TextDecoder().decode(new Uint8Array(wasmMemory.buffer, ptr, len));
                console.log("[ghostty-vt]", text);
            },
        },
    });
    wasmMemory = instance.exports.memory;
    const exports = instance.exports;
    return { exports, instance };
}
/**
 * Parse a single cell from the viewport buffer at the given byte offset.
 * The buffer layout matches the 16-byte struct from wasm_api.zig.
 */
export function parseCell(view, byteOffset) {
    return {
        codepoint: view.getUint32(byteOffset, true),
        fgR: view.getUint8(byteOffset + 4),
        fgG: view.getUint8(byteOffset + 5),
        fgB: view.getUint8(byteOffset + 6),
        bgR: view.getUint8(byteOffset + 7),
        bgG: view.getUint8(byteOffset + 8),
        bgB: view.getUint8(byteOffset + 9),
        flags: view.getUint8(byteOffset + 10),
        width: view.getUint8(byteOffset + 11),
        colorFlags: view.getUint8(byteOffset + 12),
    };
}
/** Byte size of one cell in the viewport buffer. */
export { CELL_BYTES };
/**
 * Allocate a buffer in WASM memory and return its pointer.
 * The caller must free it with freeBuffer when done.
 */
export function allocBuffer(wasm, size) {
    return wasm.exports.alloc_buffer(size);
}
/** Free a buffer previously allocated with allocBuffer. */
export function freeBuffer(wasm, ptr, size) {
    wasm.exports.free_buffer(ptr, size);
}
/**
 * Write a UTF-8 string into WASM memory and call the terminal's write
 * function. Handles allocation/deallocation of the transfer buffer.
 */
export function writeString(wasm, termPtr, str) {
    const encoded = new TextEncoder().encode(str);
    writeBytes(wasm, termPtr, encoded);
}
/**
 * Write raw bytes into the terminal. Handles allocation/deallocation
 * of the transfer buffer.
 */
export function writeBytes(wasm, termPtr, data) {
    if (data.length === 0)
        return;
    const bufPtr = allocBuffer(wasm, data.length);
    if (bufPtr === 0)
        return;
    new Uint8Array(wasm.exports.memory.buffer, bufPtr, data.length).set(data);
    wasm.exports.write(termPtr, bufPtr, data.length);
    freeBuffer(wasm, bufPtr, data.length);
}
//# sourceMappingURL=wasm-bindings.js.map