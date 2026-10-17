import * as assert from 'node:assert/strict';
import { NodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { structuralBlocks } from '../source/structural-blocks.js';
import { test } from 'node:test';

const fixture = (count = 3, gap = false, { heads = 2, kvHeads = heads, repeat = '', compact = false, grouped = false } = {}) => {
    let sequence = 0;
    const value = (dims, initializer = false) => ({ name: `v${sequence++}`, type: { dataType: 'float32', shape: { dimensions: dims } },
        ...(initializer ? { initializer: { get values() {
            throw new Error('Pattern detection must never read payloads.');
        } } } : {}) });
    const nodes = [];
    const activation = [1, 3, 8];
    const input = value(activation);
    let previous = input;
    const blocks = [];
    const add = (type, inputs, dims, attributes = []) => {
        const output = value(dims);
        nodes.push({ name: `n${nodes.length}`, type: { name: type, domain: '', version: 20 }, attributes,
            inputs: inputs.map((item, i) => ({ name: String(i), value: [item] })), outputs: [{ name: '0', value: [output] }] });
        return output;
    };
    const norm = (x) => add('LayerNormalization', [x, value([8], true)], activation, [{ name: 'axis', type: 'int64', value: -1 }, { name: 'epsilon', type: 'float32', value: 1e-6 }]);
    const project = (x, c, f) => add('MatMul', [x, value([c, f], true)], [1, 3, f]);
    for (let i = 0; i < count; i++) {
        if (gap && i === 1) {
            previous = add('Identity', [previous], activation);
        }
        const start = nodes.length;
        const normalized = norm(previous);
        const width = 8 / heads;
        const keyValueHeads = Array.isArray(kvHeads) ? kvHeads[i] : kvHeads;
        const batches = grouped ? [1, keyValueHeads, heads / keyValueHeads] : [1, heads];
        const q = add('Reshape', [project(normalized, 8, 8)], [...batches, 3, width]);
        const kv = () => {
            let x = add('Reshape', [project(normalized, 8, keyValueHeads * width)], [1, keyValueHeads, 3, width]);
            if (repeat) {
                x = add('Unsqueeze', [x, value([1], true)], [1, keyValueHeads, 1, 3, width]);
                x = add(repeat, [x, value([5], true)], [1, keyValueHeads, heads / keyValueHeads, 3, width]);
                x = add('Reshape', [x, value([4], true)], [1, heads, 3, width]);
            } else if (grouped) {
                x = add('Unsqueeze', [x, value([1], true)], [1, keyValueHeads, 1, 3, width]);
            } else if (compact) {
                x = add('Squeeze', [x, value([1], true)], [1, 3, width]);
            }
            return x;
        };
        const kvBatches = grouped ? [1, keyValueHeads, 1] : [1, repeat ? heads : keyValueHeads];
        const permutation = compact ? [0, 2, 1] : [0, 1, 3, 2];
        const k = add('Transpose', [kv()], compact ? [1, width, 3] : [...kvBatches, width, 3],
            [{ name: 'perm', type: 'int64[]', value: grouped ? [0, 1, 2, 4, 3] : permutation }]);
        const v = kv();
        const scores = add('MatMul', [q, k], [...batches, 3, 3]);
        const scaled = add('Mul', [scores, value([], true)], [...batches, 3, 3]);
        const softmax = nodes.length;
        const probabilities = add('Softmax', [scaled], [...batches, 3, 3], [{ name: 'axis', type: 'int64', value: -1 }]);
        const product = nodes.length;
        const attended = add('MatMul', [probabilities, v], [...batches, 3, width]);
        const combined = add('Reshape', [attended], activation);
        const projected = project(combined, 8, 8);
        const attentionAdd = nodes.length;
        const residual = add('Add', [previous, projected], activation);
        const secondNorm = nodes.length;
        const hidden = project(norm(residual), 8, 16);
        const activated = add('Gelu', [hidden], [1, 3, 16]);
        const output = project(activated, 16, 8);
        const end = nodes.length;
        previous = add('Add', [residual, output], activation);
        blocks.push({ start, end, softmax, product, attentionAdd, secondNorm, tap: probabilities });
    }
    return { nodes, inputs: [{ name: 'input', value: [input] }], outputs: [{ name: 'output', value: [previous] }], blocks };
};

test('transformer detection uses operations, shapes and residual wiring with arbitrary names and no rich nodes or payload reads', async () => {
    const graph = fixture();
    let created = 0;
    const catalog = new NodeCatalog(graph.nodes, (node) => {
        created++;
        return node;
    }, (node) => node);
    graph.nodes = catalog.nodes;
    const analysis = await structuralBlocks(graph);
    assert.ok(analysis);
    assert.deepEqual(analysis.groups.map((group) => group.blocks.map((block) => block.index)), [[0, 1, 2]]);
    const display = analysis.project(new Map([[0, 2]]));
    const summary = [...nodeDescriptions(display)][0];
    assert.equal(display.nodes.length, 1);
    assert.equal(summary._repeatGroup.kind, 'structural');
    const selected = summary.type;
    assert.equal([...nodeDescriptions(selected)][0].name, catalog.records[graph.blocks[2].start].name);
    const children = await structuralBlocks(selected);
    assert.deepEqual([...nodeDescriptions(children.project())].map((node) => node.type.name), ['LayerNormalization', 'Attention', 'Add', 'LayerNormalization', 'MLP', 'Add']);
    assert.equal([...nodeDescriptions(children.project())].some((node) => node._repeatHeader), false);
    const attention = [...nodeDescriptions(children.project())][1].type;
    assert.equal(await structuralBlocks(attention), null);
    const expanded = analysis.project(new Map(), new Set([0]));
    assert.deepEqual([...nodeDescriptions(expanded)].map((node) => node._originalNode || node), catalog.records);
    assert.equal(created, 0);
});

test('renaming every node and tensor preserves detected member indices, and external taps remain connected', async () => {
    const graph = fixture(4, true);
    graph.outputs.push({ name: 'tap', value: [graph.blocks[2].tap] });
    const analysis = await structuralBlocks(graph);
    assert.deepEqual(analysis.groups.map((group) => group.blocks.length), [1, 3]);
    const projected = [...nodeDescriptions(analysis.project())];
    assert.ok(projected.some((node) => node.outputs.some((arg) => arg.value.some((value) => value.name === graph.blocks[2].tap.name))));
    const ids = new Map();
    const rename = (value) => {
        if (!ids.has(value.name)) {
            ids.set(value.name, `renamed_${ids.size}`);
        }
        return { ...value, name: ids.get(value.name) };
    };
    const args = (items) => items.map((arg) => ({ ...arg, value: arg.value.map(rename) }));
    const renamed = { nodes: graph.nodes.map((node, i) => ({ ...node, name: `unrelated_${i}`, inputs: args(node.inputs), outputs: args(node.outputs) })),
        inputs: args(graph.inputs), outputs: args(graph.outputs) };
    const other = await structuralBlocks(renamed);
    assert.deepEqual(other.groups.map((group) => [...group.members]), analysis.groups.map((group) => [...group.members]));
    assert.ok(projected.filter((node) => node._repeatHeader).every((node) => node._repeatGroup.blocks.length > 1));
});

test('metadata changes split stacks without merging different normalization settings', async () => {
    const graph = fixture();
    graph.nodes[graph.blocks[1].start].attributes.find((attr) => attr.name === 'epsilon').value = 1e-5;
    const analysis = await structuralBlocks(graph);
    assert.deepEqual(analysis.groups.map((group) => group.blocks.length), [1, 1, 1]);
    assert.equal(analysis.project().nodes.some((node) => node._repeatHeader), false);
});

for (const [name, options] of Object.entries({
    MHA: { heads: 4 },
    'MQA broadcasting one KV head': { heads: 4, kvHeads: 1 },
    'MQA broadcasting a lower-rank KV tensor': { heads: 4, kvHeads: 1, compact: true },
    'GQA with Expand': { heads: 4, kvHeads: 2, repeat: 'Expand' },
    'GQA with Tile': { heads: 4, kvHeads: 2, repeat: 'Tile' },
    'GQA with a broadcast group axis': { heads: 4, kvHeads: 2, grouped: true }
})) {
    test(`attention pattern is independent of head sharing: ${name}`, async () => {
        const graph = fixture(3, false, options);
        const analysis = await structuralBlocks(graph);
        assert.deepEqual(analysis?.groups.map((group) => group.blocks.length), [3]);
        const nested = await structuralBlocks([...nodeDescriptions(analysis.project())][0].type);
        assert.deepEqual([...nodeDescriptions(nested.project())].map((node) => node.type.name),
            ['LayerNormalization', 'Attention', 'Add', 'LayerNormalization', 'MLP', 'Add']);
    });
}

test('different KV head counts share the attention category but retain separate stacks', async () => {
    const graph = fixture(3, false, { heads: 4, kvHeads: [4, 2, 2], repeat: 'Expand' });
    const analysis = await structuralBlocks(graph);
    assert.deepEqual(analysis?.groups.map((group) => group.blocks.length), [1, 2]);
});

test('non-broadcastable query and KV head counts cannot form an attention group', async () => {
    assert.equal(await structuralBlocks(fixture(1, false, { heads: 4, kvHeads: 3 })), null);
});

const failures = {
    'broadcast residual': (graph) => {
        graph.nodes[graph.blocks[0].end].inputs[0].value[0] = { ...graph.nodes[graph.blocks[0].end].inputs[0].value[0], type: { dataType: 'float32', shape: { dimensions: [1, 1, 8] } } };
    },
    'wrong softmax axis': (graph) => {
        graph.nodes[graph.blocks[0].softmax].attributes[0].value = 0;
    },
    'softmax disconnected from value product': (graph) => {
        const input = graph.nodes[graph.blocks[0].product].inputs[0].value[0];
        graph.nodes[graph.blocks[0].product].inputs[0].value = [{ ...input, name: 'unrelated_scores' }];
    },
    'incompatible attention shape': (graph) => {
        const input = graph.nodes[graph.blocks[0].product].inputs[1].value[0];
        graph.nodes[graph.blocks[0].product].inputs[1].value = [{ ...input, type: { dataType: 'float32', shape: { dimensions: [1, 2, 7, 4] } } }];
    },
    'wrong MLP expansion weights': (graph) => {
        graph.nodes[graph.blocks[0].end - 1].inputs[1].value[0].type.shape.dimensions = [12, 8];
    },
    'query projection bypasses normalization': (graph) => {
        graph.nodes[graph.blocks[0].start + 1].inputs[0].value = graph.inputs[0].value;
    },
    'incorrect second skip connection': (graph) => {
        graph.nodes[graph.blocks[0].end].inputs[0].value = graph.inputs[0].value;
    },
    'unknown shapes': (graph) => {
        graph.inputs[0].value[0].type.shape.dimensions = [1, 'tokens', 8];
    },
    'foreign operator domain': (graph) => {
        graph.nodes[graph.blocks[0].softmax].type.domain = 'custom';
    },
    'nested graph': (graph) => {
        graph.nodes[0]._hasSubgraphs = true;
    },
    'duplicate producer': (graph) => {
        graph.nodes[1].outputs = graph.nodes[0].outputs;
    },
    'non-topological source': (graph) => {
        graph.nodes.reverse();
    },
    'oversized attributes': (graph) => {
        graph.nodes[0].attributes.push({ name: 'invalid', type: 'int64[]', value: Array(4097).fill(0) });
    }
};
for (const [name, mutate] of Object.entries(failures)) {
    test(`unsupported transformer candidate remains unfolded: ${name}`, async () => {
        const graph = fixture(1);
        mutate(graph);
        assert.equal(await structuralBlocks(graph), null);
    });
}

test('structural scans can yield and cancel without publishing a partial stack', async () => {
    const graph = fixture(256);
    let current = true;
    const timer = setTimeout(() => {
        current = false;
    }, 0);
    assert.equal(await structuralBlocks(graph, () => current), null);
    clearTimeout(timer);
    assert.equal(await structuralBlocks(fixture(), () => false), null);
});
