let modulePromise = null;

export const indexSource = async (source, kind) => {
    if (!modulePromise) {
        modulePromise = (async () => {
            const url = new URL('./model-index.wasm', import.meta.url);
            const bytes = typeof process !== 'undefined' && process.versions?.node ? await (await import('node:fs/promises')).readFile(url) : await (await fetch(url)).arrayBuffer();
            return WebAssembly.compile(bytes);
        })();
    }
    const module = await modulePromise;
    let wasm = null;
    let readError = null;
    let bytesRead = 0;
    const instance = await WebAssembly.instantiate(module, {
        source: {
            read_at: (offset, ptr, length) => {
                try {
                    const position = Number(offset);
                    if (!Number.isSafeInteger(position) || position < 0 || length > source.length - position) {
                        throw new Error('Invalid source range.');
                    }
                    source.readSync(position, new Uint8Array(wasm.memory.buffer, ptr, length));
                    bytesRead += length;
                    return length;
                } catch (error) {
                    readError = error;
                    return -1;
                }
            }
        }
    });
    wasm = instance.exports;
    const handle = wasm.index_model(kind, BigInt(source.length));
    try {
        if (!wasm.result_kind(handle)) {
            const message = new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.error_ptr(handle), wasm.error_len(handle)));
            throw readError || new Error(message);
        }
        const metadata = new Uint8Array(wasm.memory.buffer, wasm.metadata_ptr(handle), wasm.metadata_len(handle)).slice();
        const ranges = [];
        const view = new DataView(wasm.memory.buffer);
        for (let i = 0; i < wasm.ranges_len(handle); i++) {
            const start = wasm.ranges_ptr(handle) + (i * 32);
            const range = Array.from({ length: 4 }, (_, j) => Number(view.getBigUint64(start + (j * 8), true)));
            if (range.some((value) => !Number.isSafeInteger(value))) {
                throw new Error('Tensor offset exceeds safe integer range.');
            }
            ranges.push(range);
        }
        return { kind, metadata: metadata.buffer, ranges, length: source.length, bytesRead };
    } finally {
        wasm.free_index(handle);
    }
};

export const formatKind = (name, head) => {
    if (head.length >= 4 && head[0] === 71 && head[1] === 71 && head[2] === 85 && head[3] === 70) {
        return 2;
    }
    if (name.toLowerCase().endsWith('.safetensors') && head.length >= 9 && head[8] === 123) {
        return 3;
    }
    if (name.toLowerCase().endsWith('.onnx') && head[0] === 8) {
        return 1;
    }
    return 0;
};
