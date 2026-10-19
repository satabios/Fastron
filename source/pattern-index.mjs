import { loadIndexModule } from './model-index.mjs';

export const patternIndex = async (tokens, flags) => {
    if (tokens.length !== flags.length || tokens.length > 10000000) {
        throw new Error('Invalid pattern index length.');
    }
    const module = await loadIndexModule();
    const { exports: wasm } = await WebAssembly.instantiate(module, { source: { read_at: () => -1 } });
    if (!wasm.pattern_new) {
        return null;
    }
    let handle = wasm.pattern_new(tokens.length);
    if (!handle) {
        throw new Error('Cannot allocate pattern index.');
    }
    try {
        const input = new Uint32Array(wasm.memory.buffer, wasm.pattern_input(handle), tokens.length * 2);
        for (let i = 0; i < tokens.length; i++) {
            input[i * 2] = tokens[i] ?? 0;
            input[i * 2 + 1] = flags[i];
        }
        wasm.pattern_prepare(handle);
    } catch (error) {
        wasm.pattern_free(handle);
        throw error;
    }
    return {
        candidates: (start) => {
            if (!handle || !Number.isInteger(start) || start < 0 || start >= tokens.length) {
                throw new Error('Invalid pattern index position.');
            }
            const length = wasm.pattern_scan(handle, start);
            return new Uint32Array(wasm.memory.buffer, wasm.pattern_output(handle), length);
        },
        dispose: () => {
            if (handle) {
                wasm.pattern_free(handle);
                handle = 0;
            }
        }
    };
};
