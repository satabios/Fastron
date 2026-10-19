import * as assert from 'node:assert/strict';
import { patternBlocks } from '../source/pattern-blocks.js';
import { patternIndex } from '../source/pattern-index.mjs';
import { test } from 'node:test';

const reference = (tokens, flags) => {
    const n = tokens.length;
    const prefix = new Uint32Array(n + 1);
    const power = new Uint32Array(n + 1);
    const missing = new Uint32Array(n + 1);
    const forks = new Uint32Array(n + 1);
    power[0] = 1;
    for (let i = 0; i < n; i++) {
        prefix[i + 1] = (Math.imul(prefix[i], 16777619) + tokens[i] + 1) >>> 0;
        power[i + 1] = Math.imul(power[i], 16777619) >>> 0;
        missing[i + 1] = missing[i] + ((flags[i] & 1) ? 0 : 1);
        forks[i + 1] = forks[i] + ((flags[i] & 4) ? 1 : 0);
    }
    const hash = (start, count) => (prefix[start + count] - Math.imul(prefix[start], power[count])) >>> 0;
    return (start) => {
        const result = [];
        if (!(flags[start] & 1)) {
            return result;
        }
        for (let period = 1; period <= 1024 && start + period * 2 <= n; period++) {
            if (missing[start + period] !== missing[start]) {
                break;
            }
            if (tokens[start + period] !== tokens[start] || (period > 1 && !(flags[start] & 2) && forks[start + period] !== forks[start])) {
                continue;
            }
            const token = hash(start, period);
            let repeats = 1;
            while (start + (repeats + 1) * period <= n &&
                missing[start + (repeats + 1) * period] === missing[start + repeats * period] && hash(start + repeats * period, period) === token) {
                repeats++;
            }
            if (repeats > 1) {
                result.push(period, repeats);
            }
        }
        return result;
    };
};

test('Rust candidates match the reference across missing metadata, forks, hashes and motif limits', async () => {
    const tokens = Uint32Array.from({ length: 4096 }, (_, i) => i % 29 === 0 ? 0xffffffff : i % 29);
    const flags = Uint8Array.from(tokens, (_, i) => {
        if (i % 503 === 0) {
            return 0;
        }
        return i % 73 === 0 ? 5 : 3;
    });
    const expected = reference(tokens, flags);
    const index = await patternIndex(tokens, flags);
    try {
        for (let i = 0; i < tokens.length; i++) {
            assert.deepEqual([...index.candidates(i)], expected(i));
        }
        assert.throws(() => index.candidates(-1));
        assert.throws(() => index.candidates(1.5));
        assert.throws(() => index.candidates(tokens.length));
    } finally {
        index.dispose();
    }
    index.dispose();
    assert.throws(() => index.candidates(0));
    await assert.rejects(patternIndex(tokens, flags.subarray(1)), /length/);
    for (const period of [1024, 1025]) {
        const tokens = Uint32Array.from({ length: 4100 }, (_, i) => i % period);
        const flags = new Uint8Array(tokens.length).fill(3);
        // eslint-disable-next-line no-await-in-loop
        const boundary = await patternIndex(tokens, flags);
        try {
            assert.deepEqual([...boundary.candidates(0)], period === 1024 ? [1024, 4] : []);
        } finally {
            boundary.dispose();
        }
    }
});

test('WASM-unavailable fallback preserves full groups and their boundary ports', async () => {
    const type = { dataType: 'float32', shape: { dimensions: [8] } };
    const argument = (name) => ({ name, value: [{ name, type }] });
    let previous = argument('input');
    const graph = { inputs: [previous], outputs: [], nodes: [] };
    for (let i = 0; i < 600; i++) {
        const output = argument(`v${i}`);
        graph.nodes.push({ name: `node${i}`, type: { name: ['A', 'B', 'C'][i % 3] }, attributes: [], inputs: [previous], outputs: [output] });
        previous = output;
    }
    graph.outputs = [previous];
    const native = await patternBlocks(graph);
    const instantiate = Object.getOwnPropertyDescriptor(WebAssembly, 'instantiate');
    let fallback = null;
    try {
        Object.defineProperty(WebAssembly, 'instantiate', { value: async () => {
            throw new Error('WASM disabled');
        } });
        fallback = await patternBlocks(graph);
    } finally {
        Object.defineProperty(WebAssembly, 'instantiate', instantiate);
    }
    assert.deepEqual(native.groups, fallback.groups);
    assert.deepEqual(native.project().inputs, fallback.project().inputs);
    assert.deepEqual(native.project().outputs, fallback.project().outputs);
    assert.equal(native.groups[0].blocks.length, 200);
});

if (process.argv.includes('--benchmark')) {
    test('candidate kernel benchmark (includes WASM setup, excludes metadata signatures and layout)', async () => {
        const tokens = Uint32Array.from({ length: 20000 }, (_, i) => Math.imul(i % 673 + 1, 2654435761));
        const flags = new Uint8Array(tokens.length).fill(3);
        const run = (scan) => {
            let count = 0;
            for (let i = 0; i < tokens.length; i++) {
                count += scan(i).length;
            }
            return count;
        };
        let started = performance.now();
        const count = run(reference(tokens, flags));
        const jsMs = performance.now() - started;
        started = performance.now();
        const index = await patternIndex(tokens, flags);
        try {
            assert.equal(run(index.candidates), count);
        } finally {
            index.dispose();
        }
        process.stdout.write(`${JSON.stringify({ nodes: tokens.length, jsMs, rustWasmMs: performance.now() - started, candidateEntries: count })}\n`);
    });
}
