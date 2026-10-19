import * as assert from 'node:assert/strict';
import { NodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { Host } from './mock.js';
import { View } from '../source/view.js';
import { patternBlocks } from '../source/pattern-blocks.js';
import { test } from 'node:test';

const builder = () => {
    let sequence = 0;
    const graph = { nodes: [], inputs: [], outputs: [] };
    const value = (dims, initializer = false) => ({ name: `v${sequence++}`,
        type: { dataType: 'float32', shape: { dimensions: dims } },
        ...(initializer ? { initializer: { get values() {
            throw new Error('Pattern detection must never read weights.');
        } } } : {}) });
    const arg = (item, i = 0) => ({ name: String(i), value: [item] });
    const input = (dims) => {
        const item = value(dims);
        graph.inputs.push(arg(item));
        return item;
    };
    const add = (type, inputs, dims, attributes = []) => {
        const output = value(dims);
        graph.nodes.push({ name: `arbitrary${graph.nodes.length}`, type: { name: type, domain: '', version: 20 },
            attributes, inputs: inputs.map(arg), outputs: [arg(output)] });
        return output;
    };
    return { graph, value, input, add, finish: (...outputs) => {
        graph.outputs = outputs.map(arg);
        return graph;
    } };
};

const cnn = () => {
    const b = builder();
    let x = b.input([null, 8, 8, 8]);
    let channels = 8;
    for (const count of [3, 4]) {
        for (let i = 0; i < count; i++) {
            const projection = i === 0;
            const target = projection ? channels * 2 : channels;
            let y = b.add('Conv', [x, b.value([4, channels, 1, 1], true)], [null, 4, 8, 8]);
            y = b.add('Relu', [y], [null, 4, 8, 8]);
            y = b.add('Conv', [y, b.value([4, 4, 3, 3], true)], [null, 4, 8, 8]);
            y = b.add('Relu', [y], [null, 4, 8, 8]);
            y = b.add('Conv', [y, b.value([target, 4, 1, 1], true)], [null, target, 8, 8]);
            const skip = projection ? b.add('Conv', [x, b.value([target, channels, 1, 1], true)], [null, target, 8, 8]) : x;
            x = b.add('Relu', [b.add('Add', [skip, y], [null, target, 8, 8])], [null, target, 8, 8]);
            channels = target;
        }
    }
    return b.finish(x);
};

const feedforward = (count = 3, parallel = false) => {
    const b = builder();
    let x = b.input([null, 8]);
    const first = x;
    const blocks = [];
    for (let i = 0; i < count; i++) {
        const start = b.graph.nodes.length;
        let y = b.add('MatMul', [parallel ? first : x, b.value([8, 16], true)], [null, 16]);
        y = b.add('Relu', [y], [null, 16]);
        y = b.add('MatMul', [y, b.value([16, 8], true)], [null, 8]);
        x = b.add('Sigmoid', [y], [null, 8]);
        blocks.push({ start, end: b.graph.nodes.length - 1 });
    }
    return { ...b.finish(x), blocks };
};

const recurrent = (type, count = 3) => {
    const b = builder();
    const stateShape = type === 'unrolled' ? [1, 8] : [1, 1, 8];
    let h = b.input(stateShape);
    let c = b.input(stateShape);
    for (let i = 0; i < count; i++) {
        const x = b.input(type === 'unrolled' ? [1, 8] : [1, 1, 8]);
        if (type === 'unrolled') {
            const z = b.add('Add', [b.add('MatMul', [x, b.value([8, 32], true)], [1, 32]),
                b.add('MatMul', [h, b.value([8, 32], true)], [1, 32])], [1, 32]);
            const gates = [b.add('Split', [z], [1, 8])];
            gates.push(...Array.from({ length: 3 }, () => b.value([1, 8])));
            b.graph.nodes.at(-1).outputs[0].value = gates;
            const input = b.add('Sigmoid', [gates[0]], [1, 8]);
            const forget = b.add('Sigmoid', [gates[1]], [1, 8]);
            const cell = b.add('Tanh', [gates[2]], [1, 8]);
            const output = b.add('Sigmoid', [gates[3]], [1, 8]);
            c = b.add('Add', [b.add('Mul', [forget, c], [1, 8]), b.add('Mul', [input, cell], [1, 8])], [1, 8]);
            h = b.add('Mul', [output, b.add('Tanh', [c], [1, 8])], [1, 8]);
        } else {
            const gates = { LSTM: 4, GRU: 3, RNN: 1 }[type];
            b.add(type, [x, b.value([1, gates * 8, 8], true), b.value([1, gates * 8, 8], true),
                b.value([1, gates * 16], true)], [1, 1, 1, 8], [{ name: 'direction', value: 'forward' }, { name: 'hidden_size', value: 8 }]);
            const node = b.graph.nodes.at(-1);
            node.inputs.push({ name: 'sequence_lens', value: [] }, { name: 'initial_h', value: [h] });
            if (type === 'LSTM') {
                node.inputs.push({ name: 'initial_c', value: [c] });
                c = b.value(stateShape);
                node.outputs.push({ name: 'Y_c', value: [c] });
            }
            h = b.value(stateShape);
            node.outputs.splice(1, 0, { name: 'Y_h', value: [h] });
        }
    }
    return b.finish(...(type === 'LSTM' || type === 'unrolled' ? [h, c] : [h]));
};

const transformer = (kvHeads = 2, fused = false) => {
    const b = builder();
    const shape = ['batch', 'tokens', 8];
    let x = b.input(shape);
    const project = (input, width, output) => b.add('MatMul', [input, b.value([width, output], true)], ['batch', 'tokens', output]);
    const norm = (input) => b.add('RMSNormalization', [input, b.value([8], true)], shape, [{ name: 'axis', type: 'int64', value: -1 }]);
    for (let i = 0; i < 3; i++) {
        const n = norm(x);
        const q = project(n, 8, 8);
        const k = project(n, 8, kvHeads * 2);
        const v = project(n, 8, kvHeads * 2);
        let attended = null;
        if (fused) {
            attended = b.add('GroupQueryAttention', [q, k, v], shape,
                [{ name: 'num_heads', value: 4 }, { name: 'kv_num_heads', value: kvHeads }]);
            b.graph.nodes.at(-1).type.domain = 'com.microsoft';
        } else {
            const heads = (input, count) => {
                const split = b.add('Reshape', [input], ['batch', count, 'tokens', 2]);
                return count === 4 ? split : b.add('Tile', [split, b.value([4], true)], ['batch', 4, 'tokens', 2]);
            };
            const query = heads(q, 4);
            const key = b.add('Transpose', [heads(k, kvHeads)], ['batch', 4, 2, 'tokens']);
            const probabilities = b.add('Softmax', [b.add('MatMul', [query, key], ['batch', 4, 'tokens', 'tokens'])], ['batch', 4, 'tokens', 'tokens']);
            attended = b.add('Reshape', [b.add('MatMul', [probabilities, heads(v, kvHeads)], ['batch', 4, 'tokens', 2])], shape);
        }
        const skip = b.add('Add', [x, project(attended, 8, 8)], shape);
        const normalized = norm(skip);
        const gate = project(normalized, 8, 16);
        const up = project(normalized, 8, 16);
        const activated = b.add('Mul', [gate, b.add('Sigmoid', [gate], ['batch', 'tokens', 16])], ['batch', 'tokens', 16]);
        const down = project(b.add('Mul', [activated, up], ['batch', 'tokens', 16]), 16, 8);
        x = b.add('Add', [skip, down], shape);
    }
    return b.finish(x);
};

const checkConnections = (graph) => {
    const nodes = [...nodeDescriptions(graph)];
    const produced = new Set([...graph.inputs, ...nodes.flatMap((node) => node.outputs)].flatMap((arg) => arg.value.map((v) => v.name)));
    for (const value of [...graph.outputs, ...nodes.flatMap((node) => node.inputs)].flatMap((arg) => arg.value)) {
        assert.ok(value.initializer || produced.has(value.name), `Orphan tensor ${value.name}`);
    }
};

test('CNN bottlenecks use topology with anonymous batch metadata and separate stage projections', async () => {
    const graph = cnn();
    const catalog = new NodeCatalog(graph.nodes, () => {
        throw new Error('Pattern detection must never construct rich nodes.');
    }, (node) => node);
    graph.nodes = catalog.nodes;
    const analysis = await patternBlocks(graph);
    assert.deepEqual(analysis.groups.map((g) => g.blocks.length), [1, 2, 1, 3]);
    assert.ok(analysis.groups.every((g) => g.kind === 'pattern'));
    assert.equal(analysis.project().nodes.length, 4);
    checkConnections(analysis.project());
    for (const group of analysis.groups) {
        const display = analysis.project(new Map([[group.id, group.blocks.length - 1]]));
        const summary = [...nodeDescriptions(display)].find((n) => n._repeatGroup === group);
        checkConnections(display);
        checkConnections(summary.type);
        // eslint-disable-next-line no-await-in-loop
        assert.equal(await patternBlocks(summary.type), null, 'A representative must open into its operators.');
    }
    assert.equal(catalog.cache.size, 0);
});

test('generic motifs need no architecture names and preserve canonical expansion and intermediate taps', async () => {
    const graph = feedforward();
    graph.outputs.push({ name: 'tap', value: graph.nodes[5].outputs[0].value });
    const analysis = await patternBlocks(graph);
    assert.deepEqual(analysis.groups.map((g) => g.blocks.length), [3]);
    checkConnections(analysis.project());
    const summary = [...nodeDescriptions(analysis.project())][0];
    assert.ok(summary.outputs.flatMap((arg) => arg.value).includes(graph.outputs[1].value[0]));
    const expanded = analysis.project(new Map(), new Set([0]));
    assert.deepEqual([...nodeDescriptions(expanded)].map((n) => n.name), graph.nodes.map((n) => n.name));
    checkConnections(expanded);
    const last = analysis.subgraph(analysis.groups[0].blocks[2].indices, 'last', '');
    assert.equal([...nodeDescriptions(last)][0], graph.nodes[8]);
});

for (const type of ['LSTM', 'GRU', 'RNN', 'unrolled']) {
    test(`recurrent ${type} patterns retain hidden/cell state ports without payload reads`, async () => {
        const graph = recurrent(type);
        const analysis = await patternBlocks(graph);
        assert.deepEqual(analysis?.groups.map((g) => g.blocks.length), [3]);
        assert.equal(analysis.groups[0].title, 'Repeated pattern');
        checkConnections(analysis.project());
        checkConnections(analysis.subgraph(analysis.groups[0].blocks[2].indices, 'cell', ''));
        const outputs = [...nodeDescriptions(analysis.project())][0].outputs.flatMap((arg) => arg.value);
        assert.ok(graph.outputs.every((arg) => outputs.includes(arg.value[0])));
    });
}

for (const [name, change] of Object.entries({
    attributes: (g) => g.nodes[5].attributes.push({ name: 'alpha', value: 0.2 }),
    dtype: (g) => {
        g.nodes[5].outputs[0].value[0].type.dataType = 'float16';
    },
    quantization: (g) => {
        g.nodes[4].inputs[1].value[0].quantization = { scale: [0.1] };
    },
    dimensions: (g) => {
        g.nodes[4].inputs[1].value[0].type.shape.dimensions = [9, 16];
    },
    'anonymous versus named axes': (g) => {
        g.nodes[5].outputs[0].value[0].type.shape.dimensions[0] = 'batch';
    },
    wiring: (g) => {
        g.nodes[6].inputs[0].value = g.nodes[4].outputs[0].value;
    },
    'parameter sharing': (g) => {
        g.nodes[6].inputs[1].value = g.nodes[4].inputs[1].value;
    },
    domain: (g) => {
        g.nodes[5].type.domain = 'custom';
    },
    'unknown rank': (g) => {
        g.nodes[5].outputs[0].value[0].type.shape = {};
    },
    'nested graph': (g) => {
        g.nodes[5]._hasSubgraphs = true;
    },
    'control dependency': (g) => {
        g.nodes[5].controlDependencies = [{}];
    }
})) {
    test(`changed ${name} cannot disappear inside a generic repeat`, async () => {
        const graph = feedforward(2);
        change(graph);
        assert.equal(await patternBlocks(graph), null);
    });
}

test('disconnected parallel copies, cycles and duplicate producers are not sequential stacks', async () => {
    assert.equal(await patternBlocks(feedforward(3, true)), null);
    const cycle = feedforward();
    cycle.nodes[0].inputs[0].value = cycle.nodes.at(-1).outputs[0].value;
    assert.equal(await patternBlocks(cycle), null);
    const duplicate = feedforward();
    duplicate.nodes[1].outputs = duplicate.nodes[0].outputs;
    assert.equal(await patternBlocks(duplicate), null);
});

test('recurrent direction differences split repeats', async () => {
    const graph = recurrent('LSTM', 4);
    graph.nodes[0].attributes[0].value = 'bidirectional';
    const analysis = await patternBlocks(graph);
    assert.deepEqual(analysis.groups.map((g) => g.blocks.length), [3]);
    assert.equal(analysis.groups[0].anchor, 1);
});

test('optional recurrent input positions remain part of the signature', async () => {
    const graph = recurrent('LSTM', 2);
    const inputs = graph.nodes[1].inputs;
    [inputs[4], inputs[5]] = [inputs[5], inputs[4]];
    assert.equal(await patternBlocks(graph), null);
});

test('unknown operator types and domains preserve the same topology matches', async () => {
    for (const graph of [cnn(), feedforward(), recurrent('unrolled'), recurrent('LSTM'), transformer(), transformer(1, true)]) {
        // eslint-disable-next-line no-await-in-loop
        const before = await patternBlocks(graph);
        for (const node of graph.nodes) {
            node.type = { ...node.type, name: `Custom${node.type.name}`, domain: 'unfamiliar.domain' };
        }
        // eslint-disable-next-line no-await-in-loop
        const after = await patternBlocks(graph);
        assert.deepEqual(after?.groups.map((g) => [...g.members]), before.groups.map((g) => [...g.members]));
    }
});

for (const heads of [1, 2, 4]) {
    test(`generic transformer topology with ${heads} KV heads uses the same finder`, async () => {
        const graph = transformer(heads);
        const analysis = await patternBlocks(graph);
        assert.deepEqual(analysis.groups.map((g) => g.blocks.length), [3]);
        checkConnections(analysis.project());
    });
}

test('different cross-instance state connections cannot form a single repeat run', async () => {
    const graph = recurrent('LSTM', 3);
    graph.nodes[2].inputs[5].value = graph.nodes[1].outputs[2].value;
    const analysis = await patternBlocks(graph);
    assert.ok(!analysis?.groups.some((g) => g.blocks.length === 3));
});

test('tensor attribute metadata is generic and never reads attribute payloads', async () => {
    const graph = feedforward(2);
    for (const index of [0, 4]) {
        graph.nodes[index].attributes.push({ name: 'configuration', type: 'tensor',
            tensorTypes: [{ dataType: 'float32', shape: { dimensions: [8] } }],
            get value() {
                throw new Error('Tensor attribute payload must remain unread.');
            } });
    }
    assert.deepEqual((await patternBlocks(graph)).groups.map((g) => g.blocks.length), [2]);
    graph.nodes[4].attributes[0].tensorTypes[0].shape.dimensions = [9];
    assert.equal(await patternBlocks(graph), null);
});

test('attribute types and operator overload identifiers are part of a match', async () => {
    const graph = feedforward(2);
    graph.nodes[0].attributes.push({ name: 'alpha', type: 'float32', value: 1 });
    graph.nodes[4].attributes.push({ name: 'alpha', type: 'int64', value: 1 });
    assert.equal(await patternBlocks(graph), null);
    graph.nodes[4].attributes[0].type = 'float32';
    graph.nodes[4].type.identifier = 'different_overload';
    assert.equal(await patternBlocks(graph), null);
});

test('toolbar pipeline defers generic scans and caches the projection', async () => {
    const graph = cnn();
    const view = new View(new Host({ serial: true }));
    view.model = { modules: [graph] };
    assert.equal(await view._repeatedPresentation(graph, () => true), graph);
    view.options.foldRepeatedBlocks = true;
    assert.equal((await view._repeatedPresentation(graph, () => true)).nodes.length, 4);
    const analysis = view._repeatStates.get(graph).analysis;
    await view._repeatedPresentation(graph, () => true);
    assert.equal(view._repeatStates.get(graph).analysis, analysis);
});

test('generic scans yield and cancellation never publishes a partial grouping', async () => {
    assert.equal(await patternBlocks(feedforward(), () => false), null);
    let current = true;
    const timer = setTimeout(() => {
        current = false;
    }, 0);
    assert.equal(await patternBlocks(feedforward(512), () => current), null);
    clearTimeout(timer);
});

test('residual closures including their activation respect the operator budget', async () => {
    const b = builder();
    const input = b.input([1, 8]);
    let x = b.add('MatMul', [input, b.value([8, 8], true)], [1, 8]);
    for (let i = 0; i < 1022; i++) {
        x = b.add('Identity', [x], [1, 8]);
    }
    const graph = b.finish(b.add('Relu', [b.add('Add', [input, x], [1, 8])], [1, 8]));
    const analysis = await patternBlocks(graph);
    assert.ok(analysis.groups.every((g) => g.blocks.every((block) => block.indices.length <= 1024)));
    assert.ok(analysis.groups.every((g) => g.members.length < graph.nodes.length));
});
