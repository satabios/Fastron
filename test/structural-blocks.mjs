import * as assert from 'node:assert/strict';
import { NodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { Host } from './mock.js';
import { View } from '../source/view.js';
import { architectureBlocks } from '../source/architecture-blocks.js';
import { structuralBlocks } from '../source/structural-blocks.js';
import { test } from 'node:test';

const fixture = (count = 3, gap = false, { heads = 2, kvHeads = heads, repeat = '', compact = false, grouped = false,
    normalization = 'LayerNormalization', gated = '', fused = '', unrolled = false, packedHeads = false } = {}) => {
    let sequence = 0;
    const value = (dims, initializer = false) => ({ name: `v${sequence++}`, type: { dataType: normalization === 'rms-cast' ? 'float16' : 'float32', shape: { dimensions: dims } },
        ...(initializer ? { initializer: { get values() {
            throw new Error('Pattern detection must never read payloads.');
        } } } : {}) });
    const nodes = [];
    const activation = [1, 3, 8];
    const input = value(activation);
    const graphInputs = [{ name: 'input', value: [input] }];
    let previous = input;
    const blocks = [];
    const add = (type, inputs, dims, attributes = []) => {
        const output = value(dims);
        nodes.push({ name: `n${nodes.length}`, type: { name: type, domain: '', version: 20 }, attributes,
            inputs: inputs.map((item, i) => ({ name: String(i), value: [item] })), outputs: [{ name: '0', value: [output] }] });
        return output;
    };
    const norm = (x) => {
        if (normalization.startsWith('rms-')) {
            const start = nodes.length;
            const data = normalization === 'rms-cast' ? add('Cast', [x], activation, [{ name: 'to', type: 'int64', value: 1 }]) : x;
            const square = normalization === 'rms-pow' ? add('Pow', [data, value([], true)], activation) : add('Mul', [data, data], activation);
            const mean = add('ReduceMean', [square], [1, 3, 1], [{ name: 'axes', type: 'int64[]', value: [-1] }]);
            const epsilon = add('Add', [mean, value([], true)], [1, 3, 1]);
            const root = add('Sqrt', [epsilon], [1, 3, 1]);
            const normalized = normalization === 'rms-reciprocal'
                ? add('Mul', [data, add('Reciprocal', [root], [1, 3, 1])], activation) : add('Div', [data, root], activation);
            const result = add('Mul', [normalized, value([8], true)], activation);
            if (normalization === 'rms-cast') {
                for (const node of nodes.slice(start)) {
                    for (const item of [...node.outputs.flatMap((arg) => arg.value), ...node.inputs.flatMap((arg) => arg.value).filter((item) => item.initializer)]) {
                        item.type.dataType = 'float32';
                    }
                }
                return add('Cast', [result], activation, [{ name: 'to', type: 'int64', value: 10 }]);
            }
            return result;
        }
        const result = add(normalization, [x, value([8], true)], activation,
            [{ name: 'axis', type: 'int64', value: -1 }, { name: 'epsilon', type: 'float32', value: 1e-6 }]);
        nodes.at(-1).type.version = normalization === 'SimplifiedLayerNormalization' ? 1 : 23;
        return result;
    };
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
        const attention = () => {
            if (packedHeads) {
                const splitConcat = (x, axis, concatAxis, dims, count) => {
                    const first = add('Split', [x], dims, [{ name: 'axis', type: 'int64', value: axis }]);
                    const outputs = [first, ...Array.from({ length: count - 1 }, () => value(dims))];
                    nodes.at(-1).outputs[0].value = outputs;
                    return add('Concat', outputs, dims.map((dim, i) => i === concatAxis ? dim * count : dim),
                        [{ name: 'axis', type: 'int64', value: concatAxis }]);
                };
                const partition = () => splitConcat(add('Reshape', [project(normalized, 8, 8)], [1, 1, 3, 8]), 3, 0, [1, 1, 3, width], heads);
                const q = partition();
                const k = add('Transpose', [partition()], [heads, 1, width, 3], [{ name: 'perm', type: 'int64[]', value: [0, 1, 3, 2] }]);
                const v = partition();
                const scores = add('MatMul', [q, k], [heads, 1, 3, 3]);
                const softmax = nodes.length;
                const probabilities = add('Softmax', [scores], [heads, 1, 3, 3], [{ name: 'axis', type: 'int64', value: -1 }]);
                const product = nodes.length;
                const attended = add('MatMul', [probabilities, v], [heads, 1, 3, width]);
                return { attended: splitConcat(attended, 0, 3, [1, 1, 3, width], heads), softmax, product, tap: probabilities };
            }
            if (unrolled) {
                const split = (input, count) => {
                    const first = add('Split', [input], [1, 1, 3, width], [{ name: 'axis', type: 'int64', value: -1 }]);
                    const outputs = [first, ...Array.from({ length: count - 1 }, () => value([1, 1, 3, width]))];
                    nodes.at(-1).outputs[0].value = outputs;
                    return outputs;
                };
                const qs = split(add('Reshape', [project(normalized, 8, 8)], [1, 1, 3, 8]), heads);
                const ks = split(add('Reshape', [project(normalized, 8, keyValueHeads * width)], [1, 1, 3, keyValueHeads * width]), keyValueHeads);
                const vs = split(add('Reshape', [project(normalized, 8, keyValueHeads * width)], [1, 1, 3, keyValueHeads * width]), keyValueHeads);
                const normalizeHead = (x) => {
                    const dims = [1, 1, 3, width];
                    const square = add('Pow', [x, value([], true)], dims);
                    const mean = add('ReduceMean', [square], [1, 1, 3, 1], [{ name: 'axes', type: 'int64[]', value: [-1] }]);
                    const epsilon = add('Add', [mean, value([], true)], [1, 1, 3, 1]);
                    const root = add('Sqrt', [epsilon], [1, 1, 3, 1]);
                    return add('Mul', [add('Div', [x, root], dims), value([width], true)], dims);
                };
                const results = [];
                let softmax = -1;
                let product = -1;
                let tap = null;
                for (let group = 0; group < keyValueHeads; group++) {
                    let k = null;
                    let v = null;
                    for (let head = 0; head < heads / keyValueHeads; head++) {
                        const q = normalizeHead(qs[group * heads / keyValueHeads + head]);
                        if (head === 0) {
                            const key = add('Transpose', [normalizeHead(ks[group])], [1, 1, width, 3], [{ name: 'perm', type: 'int64[]', value: [0, 1, 3, 2] }]);
                            const shape = value([4], true);
                            shape.type.dataType = 'int64';
                            const indices = add('ConstantOfShape', [shape], [1, 1, width, 3], [{ name: 'value', type: 'tensor',
                                get value() {
                                    throw new Error('Opaque constant payloads must remain unread.');
                                } }]);
                            indices.type.dataType = 'int64';
                            const transposed = add('Transpose', [indices], [1, 1, 3, width], [{ name: 'perm', type: 'int64[]', value: [0, 1, 3, 2] }]);
                            transposed.type.dataType = 'int64';
                            const keyCache = value([1, 1, width, 9]);
                            const valueCache = value([1, 1, 9, width]);
                            graphInputs.push({ name: keyCache.name, value: [keyCache] }, { name: valueCache.name, value: [valueCache] });
                            k = add('ScatterElements', [keyCache, indices, key], [1, 1, width, 9], [{ name: 'axis', type: 'int64', value: -1 }]);
                            v = add('ScatterElements', [valueCache, transposed, vs[group]], [1, 1, 9, width], [{ name: 'axis', type: 'int64', value: 2 }]);
                        }
                        const score = add('MatMul', [q, k], [1, 1, 3, 9]);
                        const sm = nodes.length;
                        const probabilities = add('Softmax', [score], [1, 1, 3, 9], [{ name: 'axis', type: 'int64', value: -1 }]);
                        const av = nodes.length;
                        results.push(add('MatMul', [probabilities, v], [1, 1, 3, width]));
                        if (softmax === -1) {
                            softmax = sm;
                            product = av;
                            tap = probabilities;
                        }
                    }
                }
                return { attended: add('Concat', results, [1, 1, 3, 8], [{ name: 'axis', type: 'int64', value: -1 }]), softmax, product, tap };
            }
            if (fused === 'packed') {
                const result = add('Attention', [normalized, value([8, 24], true)], activation, [{ name: 'num_heads', type: 'int64', value: heads }]);
                nodes.at(-1).type = { name: 'Attention', domain: 'com.microsoft', version: 1 };
                return { attended: result, softmax: -1, product: -1, tap: result };
            }
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
            const rawK = kv();
            const k = fused ? rawK : add('Transpose', [rawK], compact ? [1, width, 3] : [...kvBatches, width, 3],
                [{ name: 'perm', type: 'int64[]', value: grouped ? [0, 1, 2, 4, 3] : permutation }]);
            const v = kv();
            if (fused) {
                const ms = ['MultiHeadAttention', 'GroupQueryAttention'].includes(fused);
                const rank3 = ms || fused === 'rank3';
                const inputs = rank3 ? [add('Reshape', [q], activation), add('Reshape', [k], [1, 3, keyValueHeads * width]),
                    add('Reshape', [v], [1, 3, keyValueHeads * width])] : [q, k, v];
                const attrs = rank3 ? [{ name: ms ? 'num_heads' : 'q_num_heads', type: 'int64', value: heads },
                    ...(fused === 'MultiHeadAttention' ? [] : [{ name: 'kv_num_heads', type: 'int64', value: keyValueHeads }])] : [];
                const result = add(ms ? fused : 'Attention', inputs, rank3 ? activation : [...batches, 3, width], attrs);
                nodes.at(-1).type = { name: ms ? fused : 'Attention', domain: ms ? 'com.microsoft' : '', version: ms ? 1 : 23 };
                return { attended: result, softmax: -1, product: -1, tap: result };
            }
            const scores = add('MatMul', [q, k], [...batches, 3, 3]);
            const scaled = add('Mul', [scores, value([], true)], [...batches, 3, 3]);
            const softmax = nodes.length;
            const probabilities = add('Softmax', [scaled], [...batches, 3, 3], [{ name: 'axis', type: 'int64', value: -1 }]);
            const product = nodes.length;
            const attended = add('MatMul', [probabilities, v], [...batches, 3, width]);
            return { attended, softmax, product, tap: probabilities };
        };
        const { attended, softmax, product, tap } = attention();
        const combined = add('Reshape', [attended], activation);
        const projected = project(combined, 8, 8);
        const attentionAdd = nodes.length;
        const residual = add('Add', [previous, projected], activation);
        const secondNorm = nodes.length;
        const normalizedMlp = norm(residual);
        const hidden = project(normalizedMlp, 8, 16);
        const up = gated ? project(normalizedMlp, 8, 16) : null;
        const activationType = gated === 'Swish' ? 'Swish' : 'Gelu';
        let activated = add(gated === 'SwiGLU' || gated === 'GLU' ? 'Sigmoid' : activationType, [hidden], [1, 3, 16]);
        if (gated === 'SwiGLU') {
            activated = add('Mul', [hidden, activated], [1, 3, 16]);
        }
        if (up) {
            activated = add('Mul', [activated, up], [1, 3, 16]);
        }
        const output = project(activated, 16, 8);
        const end = nodes.length;
        previous = add('Add', [residual, output], activation);
        blocks.push({ start, end, softmax, product, attentionAdd, secondNorm, tap });
    }
    return { nodes, inputs: graphInputs, outputs: [{ name: 'output', value: [previous] }], blocks };
};

test('application folding counts 24 Transformer blocks across eight recurring three-block variants', async () => {
    const graph = fixture(24);
    for (let i = 2; i < graph.blocks.length; i += 3) {
        graph.nodes[graph.blocks[i].start].attributes.find((attr) => attr.name === 'epsilon').value = 1e-5;
    }
    const original = graph.nodes;
    graph.nodes = new NodeCatalog(original, () => {
        throw new Error('Application analysis must not construct rich nodes.');
    }, (node) => node).nodes;
    const host = new Host({ serial: true });
    const view = new View(host);
    view.model = { modules: [graph] };
    view.options.foldRepeatedBlocks = true;
    const display = await view._repeatedPresentation(graph, () => true);
    const analysis = view._repeatStates.get(graph).analysis;
    assert.deepEqual(analysis.architecture, { blocks: 24, softmax: 24, matchedSoftmax: 24 });
    assert.equal(analysis.groups.filter((group) => group.architecture).reduce((sum, group) => sum + group.blocks.length, 0), 24);
    assert.ok(analysis.groups.every((group) => group.blocks.length <= 2 && !group.presentation.compound));
    assert.ok([...nodeDescriptions(display)].filter((node) => node._repeatHeader).every((node) => node.type.name === 'Transformer blocks'));
    const expanded = analysis.project(new Map(), new Set(analysis.groups.map((group) => group.id)));
    assert.deepEqual([...nodeDescriptions(expanded)].map((node) => node._originalNode || node), original);
    const selected = [...nodeDescriptions(display)].find((node) => node._repeatHeader).type;
    const detail = await architectureBlocks(selected);
    assert.deepEqual([...nodeDescriptions(detail.project())].map((node) => node.type.name), ['LayerNormalization', 'Attention', 'Add', 'LayerNormalization', 'MLP', 'Add']);
});

test('architectural counts remain independent of explicit Softmax inventory', async () => {
    const fused = await architectureBlocks(fixture(3, false, { fused: 'rank4' }));
    assert.deepEqual(fused.architecture, { blocks: 3, softmax: 0, matchedSoftmax: 0 });
    const unrolled = await architectureBlocks(fixture(3, false, { heads: 4, kvHeads: 2, unrolled: true, normalization: 'rms-pow' }));
    assert.deepEqual(unrolled.architecture, { blocks: 3, softmax: 12, matchedSoftmax: 12 });
    const invalid = fixture(3);
    for (const block of invalid.blocks) {
        invalid.nodes[block.attentionAdd].inputs[0] = invalid.nodes[block.attentionAdd].inputs[1];
    }
    assert.equal((await architectureBlocks(invalid))?.architecture, undefined, 'Softmaxes without the verified residual recipe cannot establish Transformer blocks.');
    assert.equal(await architectureBlocks(fixture(), () => false), null);
});

for (const [name, options, expected] of [
    ['classic dense recipe', {}, ['LayerNorm', 'MHA', 'GELU MLP', 'shared feature match']],
    ['fused gated GQA recipe', { normalization: 'RMSNormalization', gated: 'SwiGLU', fused: 'rank3', heads: 4, kvHeads: 2 }, ['RMSNorm', 'GQA', 'SwiGLU', 'shared feature match']],
    ['unresolved normalization stays a partial reference', { normalization: 'rms-pow', gated: 'SwiGLU', unrolled: true, heads: 4, kvHeads: 2 }, ['Unresolved normalization', 'GQA', 'SwiGLU', 'partial feature match']]
]) {
    test(`architecture profile: ${name}`, async () => {
        const analysis = await architectureBlocks(fixture(3, false, options));
        const profile = analysis.groups[0].blocks[0].profile;
        assert.deepEqual([profile.normalization, profile.attention.kind, profile.feedforward.kind, profile.reference.matches[0].status], expected);
        assert.deepEqual([profile.feedforward.hiddenWidth, profile.feedforward.intermediateWidth], [8, 16]);
        assert.ok(profile.unresolved.includes('Source model identity'));
        const other = await architectureBlocks(fixture(3, false, { ...options, gated: 'GEGLU' }));
        assert.equal(other.groups[0].blocks[0].profile.feedforward.kind, 'GEGLU');
    });
}

test('attention profiles preserve uncertainty about KV repetition and distinguish MQA', async () => {
    const repeated = await architectureBlocks(fixture(3, false, { heads: 4, kvHeads: 2, repeat: 'Expand' }));
    const profile = repeated.groups[0].blocks[0].profile;
    assert.equal(profile.attention.kind, 'SDPA');
    assert.equal(profile.attention.kvHeads, undefined, 'Repeated KV tensors cannot establish original KV head counts.');
    const mqa = await architectureBlocks(fixture(3, false, { heads: 4, kvHeads: 1 }));
    assert.deepEqual(mqa.groups[0].blocks[0].profile.attention, { kind: 'MQA', implementation: 'explicit', queryHeads: 4, kvHeads: 1 });
});

test('packed-head profiles follow Split/Concat provenance instead of interpreting batch axes as heads', async () => {
    const graph = fixture(3, false, { packedHeads: true, heads: 4 });
    const analysis = await architectureBlocks(graph);
    assert.deepEqual(analysis.groups[0].blocks[0].profile.attention,
        { kind: 'MHA', implementation: 'heads packed into batch', queryHeads: 4, kvHeads: 4 });
    const concat = graph.nodes.find((node) => node.type.name === 'Concat');
    concat.inputs[1] = concat.inputs[0];
    const invalid = await architectureBlocks(graph);
    assert.equal(invalid.groups[0].blocks[0].profile.attention.kind, 'SDPA', 'Repeated slices do not establish separate heads.');
});

test('adjacent independent Transformer blocks cannot become a serial stack', async () => {
    const graph = fixture(2);
    graph.nodes[graph.blocks[1].start].inputs[0] = graph.inputs[0];
    graph.nodes[graph.blocks[1].attentionAdd].inputs[0] = graph.inputs[0];
    const analysis = await architectureBlocks(graph);
    assert.equal(analysis.architecture.blocks, 2);
    assert.deepEqual(analysis.groups.map((group) => group.blocks.length), [1, 1]);
});

test('generic fallback folds unclaimed operators without crossing Transformer boundaries', async () => {
    const graph = fixture(3);
    let previous = graph.outputs[0].value[0];
    for (let i = 0; i < 4; i++) {
        const output = { ...previous, name: `tail${i}` };
        graph.nodes.push({ name: `tail${i}`, type: { name: 'Relu', version: 20 }, attributes: [],
            inputs: [{ name: 'input', value: [previous] }], outputs: [{ name: 'output', value: [output] }] });
        previous = output;
    }
    graph.outputs = [{ name: 'output', value: [previous] }];
    const analysis = await architectureBlocks(graph);
    assert.deepEqual(analysis.groups.map((group) => [group.architecture || 'generic', group.blocks.length]), [['transformer', 3], ['generic', 4]]);
    const members = analysis.groups.flatMap((group) => [...group.members]);
    assert.equal(new Set(members).size, members.length);
    const expanded = analysis.project(new Map(), new Set(analysis.groups.map((group) => group.id)));
    assert.deepEqual([...nodeDescriptions(expanded)].map((node) => node._originalNode || node), graph.nodes);
});

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
    assert.deepEqual(other.groups.map((group) => group.blocks.map((block) => block.profile)), analysis.groups.map((group) => group.blocks.map((block) => block.profile)));
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

for (const normalization of ['RMSNormalization', 'SimplifiedLayerNormalization', 'rms-div', 'rms-reciprocal', 'rms-cast']) {
    test(`normalization pattern: ${normalization}`, async () => {
        const graph = fixture(3, false, { normalization });
        const analysis = await structuralBlocks(graph);
        assert.deepEqual(analysis?.groups.map((group) => group.blocks.length), [3]);
        const nested = await structuralBlocks([...nodeDescriptions(analysis.project())][0].type);
        const name = normalization.startsWith('rms-') ? 'RMSNorm' : normalization;
        assert.deepEqual([...nodeDescriptions(nested.project())].map((node) => node.type.name), [name, 'Attention', 'Add', name, 'MLP', 'Add']);
    });
}

test('a Pow exponent that would require a payload read cannot establish RMSNorm', async () => {
    assert.equal(await structuralBlocks(fixture(1, false, { normalization: 'rms-pow' })), null);
});

const unrolledOptions = { normalization: 'rms-pow', gated: 'SwiGLU', unrolled: true, heads: 4, kvHeads: 2 };

test('a verified attention half does not upgrade an unresolved MLP normalizer to a verified stack', async () => {
    const graph = fixture(1, false, { normalization: 'rms-pow' });
    const end = graph.nodes.findIndex((node) => node.type.name === 'MatMul') - 1;
    const norm = graph.nodes[end];
    graph.nodes.splice(0, end + 1, { name: 'norm', type: { name: 'LayerNormalization', version: 17 },
        attributes: [{ name: 'axis', type: 'int64', value: -1 }],
        inputs: [graph.inputs[0], norm.inputs[1]], outputs: norm.outputs });
    const analysis = await structuralBlocks(graph);
    assert.equal(analysis?.groups[0].kind, 'pattern');
});

test('unrolled decoder patterns expose normalization, GQA and gated MLP without reading constants', async () => {
    const graph = fixture(3, false, unrolledOptions);
    let created = 0;
    graph.nodes = new NodeCatalog(graph.nodes, () => {
        created++;
    }, (node) => node).nodes;
    const analysis = await structuralBlocks(graph);
    assert.deepEqual(analysis?.groups.map((group) => [group.kind, group.blocks.length]), [['pattern', 3]]);
    const opened = await structuralBlocks([...nodeDescriptions(analysis.project())][0].type);
    const parts = [...nodeDescriptions(opened.project())];
    assert.deepEqual(parts.map((node) => node.type.name), ['Normalization', 'Attention (GQA)', 'Add', 'Normalization', 'MLP', 'Add']);
    assert.deepEqual(parts[1].attributes.filter((attr) => attr.name !== 'operators').map((attr) => [attr.name, attr.value]), [['query heads', 4], ['KV heads', 2]]);
    const attention = await structuralBlocks(parts[1].type);
    assert.deepEqual(attention.groups.map((group) => group.blocks.length), [2]);
    const kv = [...nodeDescriptions(attention.project())].find((node) => node._repeatHeader);
    assert.equal([...nodeDescriptions(kv.type)].filter((node) => node.type.name === 'Softmax').length, 2);
    assert.equal([...nodeDescriptions(kv.type)].filter((node) => node.type.name === 'ScatterElements').length, 2);
    const expanded = attention.project(new Map(), new Set([0]));
    assert.deepEqual([...nodeDescriptions(expanded)].map((node) => node.name), [...nodeDescriptions(parts[1].type)].map((node) => node.name));
    assert.equal(created, 0);
});

for (const [name, mutate] of [
    ['cache updates use the wrong projection', (graph) => {
        const caches = graph.nodes.filter((node) => node.type.name === 'ScatterElements');
        caches[0].inputs[2] = caches[1].inputs[2];
    }],
    ['a head is omitted from the output merge', (graph) => {
        const concat = graph.nodes.find((node) => node.type.name === 'Concat');
        concat.inputs[1] = concat.inputs[0];
    }],
    ['two heads use the same softmax result', (graph) => {
        const products = graph.nodes.filter((node) => node.type.name === 'MatMul' && !node.inputs[1].value[0].initializer);
        products[3].inputs[0] = products[1].inputs[0];
    }],
    ['cache update along the wrong axis', (graph) => {
        graph.nodes.find((node) => node.type.name === 'ScatterElements').attributes[0].value = 0;
    }],
    ['missing head shape metadata', (graph) => {
        graph.nodes.find((node) => node.type.name === 'Softmax').outputs[0].value[0].type.shape.dimensions = null;
    }]
]) {
    test(`unrolled decoder rejects inconsistent wiring: ${name}`, async () => {
        const graph = fixture(1, false, unrolledOptions);
        mutate(graph);
        assert.equal(await structuralBlocks(graph), null);
    });
}

for (const gated of ['SwiGLU', 'GEGLU', 'GLU', 'Swish']) {
    test(`gated MLP pattern: ${gated}`, async () => {
        const analysis = await structuralBlocks(fixture(3, false, { gated, normalization: 'RMSNormalization' }));
        assert.deepEqual(analysis?.groups.map((group) => group.blocks.length), [3]);
    });
}

for (const fused of ['rank4', 'rank3', 'MultiHeadAttention', 'GroupQueryAttention', 'packed']) {
    test(`fused attention pattern: ${fused}`, async () => {
        const analysis = await structuralBlocks(fixture(3, false, { fused, heads: 4,
            kvHeads: fused === 'MultiHeadAttention' || fused === 'packed' ? 4 : 2 }));
        assert.deepEqual(analysis?.groups.map((group) => group.blocks.length), [3]);
    });
}

const symbolize = (graph, batch = 'batch', tokens = 'tokens') => {
    const seen = new Set();
    for (const arg of [...graph.inputs, ...graph.outputs, ...graph.nodes.flatMap((node) => [...node.inputs, ...node.outputs])]) {
        for (const value of arg.value) {
            if (!value.initializer && !seen.has(value)) {
                seen.add(value);
                value.type.shape.dimensions = value.type.shape.dimensions.map((dim, i) => {
                    if (i === 0 && dim === 1) {
                        return batch;
                    }
                    return dim === 3 ? tokens : dim;
                });
            }
        }
    }
    return graph;
};

test('dynamic batch/sequence shapes combine with RMSNorm, gated MLP and fused GQA', async () => {
    const graph = symbolize(fixture(3, false, { normalization: 'rms-div', gated: 'SwiGLU', fused: 'rank3', heads: 4, kvHeads: 2 }));
    const analysis = await structuralBlocks(graph);
    assert.deepEqual(analysis?.groups.map((group) => group.blocks.length), [3]);
});

test('symbolic MatMul broadcasting accepts equal constraints but rejects unrelated names and anonymous dimensions', async () => {
    const graph = symbolize(fixture(3));
    assert.deepEqual((await structuralBlocks(graph))?.groups.map((group) => group.blocks.length), [3]);
    for (const dimension of ['other_tokens', null, '?', 0]) {
        const invalid = symbolize(fixture(1));
        const product = invalid.nodes[invalid.blocks[0].product];
        const value = product.inputs[1].value[0];
        product.inputs[1].value[0] = { ...value, type: { dataType: 'float32', shape: { dimensions: ['batch', 2, dimension, 4] } } };
        // eslint-disable-next-line no-await-in-loop
        assert.equal(await structuralBlocks(invalid), null);
    }
});

test('generated symbolic equality patterns survive renaming without altering original metadata', async () => {
    const a = symbolize(fixture(3), 'unk__1', 'unk__2');
    const b = symbolize(fixture(3), 'unk__100', 'unk__200');
    const aa = await structuralBlocks(a);
    const bb = await structuralBlocks(b);
    assert.deepEqual(aa?.groups.map((group) => [...group.members]), bb?.groups.map((group) => [...group.members]));
    assert.deepEqual(a.inputs[0].value[0].type.shape.dimensions, ['unk__1', 'unk__2', 8]);
});

test('fused attention auxiliary cache outputs remain connected across folded instances', async () => {
    const graph = fixture(3, false, { fused: 'rank4' });
    for (const [i, node] of graph.nodes.filter((node) => node.type.name === 'Attention').entries()) {
        const cache = { name: `cache_${i}`, type: { dataType: 'float32', shape: { dimensions: [1, 2, 3, 4] } } };
        node.outputs.push({ name: 'present_key', value: [cache] });
        graph.outputs.push({ name: `cache_${i}`, value: [cache] });
    }
    const analysis = await structuralBlocks(graph);
    assert.deepEqual(analysis?.groups.map((group) => group.blocks.length), [3]);
    const summary = [...nodeDescriptions(analysis.project())][0];
    const outputs = summary.outputs.flatMap((arg) => arg.value.map((value) => value.name));
    assert.ok(['cache_0', 'cache_1', 'cache_2'].every((name) => outputs.includes(name)));
});

test('legacy MultiHeadAttention does not borrow the GQA head-count schema', async () => {
    assert.equal(await structuralBlocks(fixture(1, false, { fused: 'MultiHeadAttention', heads: 4, kvHeads: 2 })), null);
});

test('two-projection Swish MLP remains supported without inventing a gated branch', async () => {
    const graph = fixture();
    for (const node of graph.nodes.filter((node) => node.type.name === 'Gelu')) {
        node.type = { name: 'Swish', domain: '', version: 24 };
    }
    assert.deepEqual((await structuralBlocks(graph))?.groups.map((group) => group.blocks.length), [3]);
});

test('packed Attention accepts an omitted/default QKV width attribute without reading weights', async () => {
    const graph = fixture(3, false, { fused: 'packed' });
    for (const node of graph.nodes.filter((node) => node.type.name === 'Attention')) {
        node.attributes.push({ name: 'qkv_hidden_sizes', type: 'int64[]', value: [] });
    }
    assert.deepEqual((await structuralBlocks(graph))?.groups.map((group) => group.blocks.length), [3]);
});

for (const [name, options, mutate] of [
    ['non-multiplicative gate', { gated: 'GEGLU' }, (graph) => {
        graph.nodes[graph.blocks[0].end - 2].type.name = 'Add';
    }],
    ['SwiGLU sigmoid on the wrong branch', { gated: 'SwiGLU' }, (graph) => {
        const sigmoid = graph.nodes.find((node) => node.type.name === 'Sigmoid');
        sigmoid.inputs[0].value = graph.inputs[0].value;
    }],
    ['incompatible gate width', { gated: 'GLU' }, (graph) => {
        graph.nodes[graph.blocks[0].end - 1].inputs[1].value[0].type.shape.dimensions = [15, 8];
    }],
    ['RMSNorm reduction on the wrong axis', { normalization: 'rms-div' }, (graph) => {
        graph.nodes.find((node) => node.type.name === 'ReduceMean').attributes[0].value = [1];
    }],
    ['RMSNorm with a different squared input', { normalization: 'rms-div' }, (graph) => {
        graph.nodes[0].inputs[1].value = [{ ...graph.inputs[0].value[0], name: 'unrelated' }];
    }],
    ['fused operator in an unknown domain', { fused: 'rank4' }, (graph) => {
        graph.nodes.find((node) => node.type.name === 'Attention').type.domain = 'unknown';
    }],
    ['fused head count not divisible', { fused: 'rank3' }, (graph) => {
        graph.nodes.find((node) => node.type.name === 'Attention').attributes[0].value = 3;
    }],
    ['fused attention with different K/V lengths', { fused: 'rank4' }, (graph) => {
        graph.nodes.find((node) => node.type.name === 'Attention').inputs[2].value[0].type.shape.dimensions = [1, 2, 7, 4];
    }],
    ['packed attention with wrong weight width', { fused: 'packed' }, (graph) => {
        graph.nodes.find((node) => node.type.name === 'Attention').inputs[1].value[0].type.shape.dimensions = [7, 24];
    }]
]) {
    test(`invalid extended pattern remains unfolded: ${name}`, async () => {
        const graph = fixture(1, false, options);
        mutate(graph);
        assert.equal(await structuralBlocks(graph), null);
    });
}

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
