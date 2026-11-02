import * as assert from 'node:assert/strict';
import { AnalysisEncoder, GraphAnalysis, instantiateAnalysis } from '../source/graph-analysis.mjs';
import { Context, Host } from './mock.js';
import { NodeCatalog, nodeDescriptions } from '../source/repeated-blocks.js';
import { BinaryStream } from '../source/base.js';
import { Controller } from '../source/comparator.js';
import { ModelFactoryService } from '../source/view.js';
import { hierarchyFixture } from './group-fixtures.mjs';
import { loadIndexModule } from '../source/model-index.mjs';
import { test } from 'node:test';

const node = (name, op = 'Relu', dimensions = [2]) => ({ name,
    type: { name: op, category: 'Activation', module: 'ai.onnx', version: 1 }, attributes: [],
    inputs: [{ name: 'input', value: [{ name: 'x', type: { dataType: 'float32', shape: { dimensions } } }] }],
    outputs: [{ name: 'output', value: [{ name: `${name}:0`, type: { dataType: 'float32', shape: { dimensions } } }] }]
});
const local = async (a, b) => {
    const controller = Object.create(Controller.prototype);
    return new Promise((resolve) => {
        controller._compareNodesPhase2(controller._compareNodesPhase1(a, b), resolve);
    });
};
const comparable = (result) => ({ pairs: result.pairs.map((p) => [p.indexA, p.indexB, p.status]).sort((a, b) => a[0] - b[0]), onlyInA: result.onlyInA, onlyInB: result.onlyInB });
const withAnalysis = async (callback) => {
    const analysis = new GraphAnalysis();
    try {
        return await callback(analysis);
    } finally {
        analysis.dispose();
    }
};

test('ordinary model indexing excludes the deferred analysis engine', async () => {
    const module = await loadIndexModule();
    assert.equal(WebAssembly.Module.exports(module).some((entry) => entry.name.startsWith('analysis_')), false);
    const wasm = await instantiateAnalysis();
    assert.equal(typeof wasm.analysis_new, 'function');
});

test('Rust matching preserves JavaScript classifications, conservative ties, metadata and rewiring', async () => {
    const cases = [];
    for (const change of [
        (b) => {
            b.inputs[0].value[0].type.shape.dimensions = [3];
        },
        (b) => {
            b.outputs[0].value[0].type.dataType = 'float16';
        },
        (b) => {
            b.type.version = 2;
        },
        (b) => {
            b.type.module = 'custom';
        },
        (b) => {
            b.type.name = 'Sigmoid';
        },
        (b) => {
            b.attributes = [{ name: 'alpha', type: 'float32', value: 1 }];
        }
    ]) {
        const a = node('same'); a.attributes = [{ name: 'alpha', type: 'int32', value: 1 }];
        const b = structuredClone(a); change(b); cases.push([[a], [b]]);
    }
    cases.push([[node('a')], [node('b', 'Sigmoid')]], [[node(''), node('')], [node(''), node('')]],
        [[node('same', 'Relu', [2]), node('same', 'Relu', [3])], [node('same', 'Relu', [3]), node('same', 'Relu', [2])]], [[], []]);
    const many = Array.from({ length: 64 }, (_, i) => node('', 'MatMul', [Math.max(i, 1)]));
    cases.push([many, structuredClone(many).reverse()]);
    const a = [node('left'), node('right'), node('sink')]; a[2].inputs[0].value[0].name = 'left:0';
    const b = structuredClone(a); b[2].inputs[0].value[0].name = 'right:0'; cases.push([a, b]);
    const renamed = structuredClone(a); renamed[0].outputs[0].value[0].name = 'renamed'; renamed[2].inputs[0].value[0].name = 'renamed'; cases.push([a, renamed]);
    const fused = structuredClone(a); fused[0].chain = [node('fused')]; fused[2].inputs[0].value[0].name = 'fused:0';
    const fusedB = structuredClone(fused); fusedB[0].chain[0].outputs[0].value[0].name = 'renamed'; fusedB[2].inputs[0].value[0].name = 'renamed'; cases.push([fused, fusedB]);
    const controls = structuredClone(a); controls[2].controlDependencies = [{ name: 'left:0' }];
    const controlsB = structuredClone(controls); controlsB[2].controlDependencies[0].name = 'right:0'; cases.push([controls, controlsB]);
    for (const [nodesA, nodesB] of cases) {
        const ga = { nodes: nodesA }; const gb = { nodes: nodesB };
        // eslint-disable-next-line no-await-in-loop
        const expected = await local(ga, gb);
        // eslint-disable-next-line no-await-in-loop
        await withAnalysis(async (analysis) => assert.deepEqual(comparable(await analysis.compare(ga, gb)), comparable(expected)));
    }
});

test('typed metadata preserves binary types, maps, cycles, shared objects, nonfinite numbers and bigint', async () => {
    const shared = { value: 1 }; const cycle = {}; cycle.self = cycle;
    const cases = [
        [new Uint8Array([1]), new Uint8Array([2]), false], [new Uint8Array([1]), new Int8Array([1]), false],
        [new Map([['a', 1], ['b', 2]]), new Map([['b', 2], ['a', 1]]), true], [cycle, structuredClone(cycle), true],
        [[shared, shared], [{ value: 1 }, { value: 1 }], true], [null, undefined, false], [-0, 0, false],
        [new Map([[shared, 1]]), new Map([[{ value: 1 }, 1]]), false],
        [new Map([[shared, 1]]), new Map([[shared, 1]]), true], [new Date(NaN), new Date(NaN), false],
        ['\ud800', '\ufffd', false],
        [[NaN, Infinity, -Infinity, 2n], [NaN, Infinity, -Infinity, 2n], true], [new Set([1, 2]), new Set([2, 1]), true]
    ];
    const twoCycle = {}; twoCycle.self = { self: twoCycle }; cases.push([cycle, twoCycle, true]);
    for (const [valueA, valueB, same] of cases) {
        const a = node('same'); const b = node('same');
        a.attributes = [{ name: 'a', value: valueA }]; b.attributes = [{ name: 'a', value: valueB }];
        // eslint-disable-next-line no-await-in-loop
        await withAnalysis(async (analysis) => assert.equal((await analysis.compare({ nodes: [a] }, { nodes: [b] })).pairs[0].status, same ? 'identical' : 'modified'));
    }
});

test('hidden function edits, shared callers, recursive pairs and role-preserving graph arrays propagate', async () => withAnalysis(async (analysis) => {
    const bodyA = { name: 'Composite', nodes: [node('inside')], inputs: [], outputs: [] };
    const bodyB = { name: 'Composite', nodes: [node('inside', 'Sigmoid')], inputs: [], outputs: [] };
    const caller = (name, body) => ({ ...node(name), type: { name: 'Composite', type: 'function', nodes: body.nodes, inputs: [], outputs: [] } });
    const a = { nodes: [caller('one', bodyA), caller('two', bodyA)] };
    a.nodes[1].type = a.nodes[0].type;
    const b = { nodes: [caller('one', bodyB), caller('two', bodyB)] }; b.nodes[1].type = b.nodes[0].type;
    const result = await analysis.compare(a, b);
    assert.ok(result.pairs.every((pair) => pair.status === 'modified'));
    assert.equal(result.children[0].pair, result.children[1].pair);
    assert.equal((await analysis.result(result.children[0].pair)).pairs[0].status, 'modified');
    const recursiveA = { name: 'Recursive', type: 'function', nodes: [] };
    recursiveA.nodes = [caller('self', recursiveA)]; recursiveA.nodes[0].type = recursiveA;
    const recursiveB = { name: 'Recursive', type: 'function', nodes: [] };
    recursiveB.nodes = [caller('self', recursiveB)]; recursiveB.nodes[0].type = recursiveB;
    const recursive = await analysis.compare({ nodes: [caller('root', recursiveA)] }, { nodes: [caller('root', recursiveB)] });
    assert.equal(recursive.modified, false);
    const branchA = node('if'); branchA.attributes = [{ name: 'branches', type: 'graph[]', value: [bodyA, bodyB] }];
    const branchB = node('if'); branchB.attributes = [{ name: 'branches', type: 'graph[]', value: [bodyB, bodyA] }];
    const branches = await analysis.compare({ nodes: [branchA] }, { nodes: [branchB] });
    assert.equal(branches.pairs[0].status, 'modified'); assert.equal(branches.children.length, 2);
}));

test('missing and empty bodies differ, and graph output rewiring changes the containing call', async () => withAnalysis(async (analysis) => {
    const emptyA = node('same'); emptyA.type = { name: 'Function', nodes: [] };
    const emptyB = structuredClone(emptyA);
    assert.equal((await analysis.compare({ nodes: [emptyA] }, { nodes: [emptyB] })).modified, false);
    const absent = node('same'); absent.type = { name: 'Function' };
    assert.equal((await analysis.compare({ nodes: [emptyA] }, { nodes: [absent] })).pairs[0].status, 'modified');
    const body = { name: 'Function', nodes: [node('left'), node('right')], outputs: [{ name: 'out', value: [{ name: 'left:0' }] }] };
    const other = structuredClone(body); other.outputs[0].value[0].name = 'right:0';
    const root = node('call'); root.type = body; const rootB = node('call'); rootB.type = other;
    const result = await analysis.compare({ nodes: [root] }, { nodes: [rootB] });
    assert.equal(result.pairs[0].status, 'modified');
    assert.equal((await analysis.result(result.children[0].pair)).interfaceChanged, true);
    const arrayA = node('array'); arrayA.attributes = [{ name: 'branches', type: 'graph[]', value: [] }];
    const arrayB = node('array');
    assert.equal((await analysis.compare({ nodes: [arrayA] }, { nodes: [arrayB] })).pairs[0].status, 'modified');
    const defaultA = { name: 'Function', nodes: [], attributes: [{ name: 'alpha', type: 'float32', value: 1 }] };
    const defaultB = structuredClone(defaultA); defaultB.attributes[0].value = 2;
    const callA = node('default'); callA.type = defaultA;
    const callB = node('default'); callB.type = defaultB;
    assert.equal((await analysis.compare({ nodes: [callA] }, { nodes: [callB] })).pairs[0].status, 'modified');
    const unavailable = node('array'); unavailable.attributes = [{ name: 'branches', type: 'graph[]', value: null }];
    await assert.rejects(analysis.compare({ nodes: [unavailable] }, { nodes: [arrayB] }), /unavailable/);
}));

test('Rust grouping preserves tensors and raw indices across nested expansion and catalog eviction', async () => withAnalysis(async (analysis) => {
    const graph = hierarchyFixture(); const other = structuredClone(graph);
    other.nodes[0].type = { ...other.nodes[0].type, name: 'Changed' };
    const result = await analysis.compare(graph, other);
    const collapsed = await analysis.project(result.a, new Set(), result.id, 0);
    assert.ok(collapsed._analysisProjection.groups.length > 0);
    assert.ok(collapsed._analysisProjection.groups.some((group) => group.counts[1] > 0));
    const expanded = new Set(collapsed._analysisProjection.groups.map((group) => group.key));
    const full = await analysis.project(result.a, expanded, result.id, 0);
    assert.deepEqual([...nodeDescriptions(full)].map((item) => item._originalIndex), graph.nodes.map((_, i) => i));
    assert.deepEqual(comparable(await analysis.result(result.id)), comparable(result));
    for (const group of collapsed._hierarchy.groups.values()) {
        for (const arg of group.boundary.inputs.concat(group.boundary.outputs)) {
            assert.ok(arg.value[0].type);
        }
    }
}));

test('anonymous repeated groups are verified in Rust and keep original operator boundaries', async () => withAnalysis(async (analysis) => {
    const graph = hierarchyFixture();
    graph.nodes.forEach((item) => {
        item.name = '';
    });
    const result = await analysis.compare(graph, graph);
    const projected = await analysis.project(result.a, new Set(), result.id, 0);
    assert.ok(projected._analysisProjection.groups.length >= 2);
    const expanded = new Set(projected._analysisProjection.groups.map((group) => group.key));
    const full = await analysis.project(result.a, expanded, result.id, 0);
    assert.deepEqual([...nodeDescriptions(full)].map((item) => item._originalIndex), graph.nodes.map((_, i) => i));
}));

test('ONNX descriptor tensor attributes retain headers without materializing nodes', async () => withAnalysis(async (analysis) => {
    const bytes = (size) => new TextEncoder().encode(JSON.stringify({ ir_version: 8, opset_import: [{ domain: '', version: 20 }], graph: {
        name: 'Tensor attribute', input: [], output: [], node: [{ name: 'constant', op_type: 'Constant', input: [], output: ['y'],
            attribute: [{ name: 'value', type: 4, t: { data_type: 1, dims: [size], float_data: Array(size).fill(1) } }] }]
    } }));
    const load = async (size) => {
        const host = new Host({ serial: true });
        const context = new Context(host, '.', 'tensor.onnx', new BinaryStream(bytes(size)));
        return (await new ModelFactoryService(host).open(context)).modules[0];
    };
    const a = await load(2); const b = await load(3);
    const result = await analysis.compare(a, b);
    assert.equal(result.pairs[0].status, 'modified');
    const same = await load(2);
    const materialized = { ...same, nodes: [...same.nodes] };
    assert.equal((await analysis.compare(a, materialized)).pairs[0].status, 'identical');
}));

test('packing visits native body owners lazily and never reads tensor payloads', async () => withAnalysis(async (analysis) => {
    let materialized = 0;
    const tensor = { type: { dataType: 'float32', shape: { dimensions: [2] } }, encoding: '<' };
    Object.defineProperty(tensor, 'values', { enumerable: true, get: () => {
        throw new Error('Weight payload read');
    } });
    const nodes = [node('a'), node('call')]; nodes[0].inputs[0].value[0].initializer = tensor;
    nodes[0].attributes = [{ name: 'tensor', type: 'tensor', value: tensor }];
    const real = { ...nodes[1], type: { name: 'Function', nodes: [] } };
    nodes[1]._hasSubgraphs = true;
    const catalog = new NodeCatalog(nodes, (record) => {
        materialized++; return record === nodes[1] ? real : record;
    }, (record) => record);
    const graph = { nodes: catalog.nodes };
    assert.equal((await analysis.compare(graph, graph)).modified, false);
    assert.equal(materialized, 1);
}));

test('worker cancellation rejects pending work and drops stale progress', async () => {
    const analysis = new GraphAnalysis();
    const nodes = Array.from({ length: 1200 }, () => node('', 'MatMul'));
    let progress = false;
    analysis.onprogress = () => {
        progress = true; analysis.dispose();
    };
    await assert.rejects(analysis.compare({ nodes }, { nodes: structuredClone(nodes) }), /closed/);
    assert.equal(progress, true);
    await assert.rejects(analysis.result(0), /closed/);
});

test('WASM validates malformed buffers and remains usable after memory growth', async () => {
    const wasm = await instantiateAnalysis(); const handle = wasm.analysis_new();
    try {
        assert.equal(wasm.analysis_input(handle, 0x10000001), 0);
        const pointer = wasm.analysis_input(handle, 8); new Uint8Array(wasm.memory.buffer, pointer, 8).fill(255);
        assert.equal(wasm.analysis_upload(handle) >>> 0, 0xffffffff);
        const encoder = new AnalysisEncoder(); const id = encoder.register({ nodes: [node('ok')] });
        const { bytes } = await encoder.encode(id);
        wasm.analysis_input(handle, 4 * 1024 * 1024);
        const ptr = wasm.analysis_input(handle, bytes.length); new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
        assert.equal(wasm.analysis_upload(handle), id);
        const pair = wasm.analysis_start(handle, id, id);
        while (!wasm.analysis_step(handle, 1)) { /* Exercise bounded preprocessing and matching. */ }
        assert.equal(wasm.analysis_result(handle, pair), 0);
        const result = JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.analysis_output(handle), wasm.analysis_output_len(handle))));
        assert.equal(result.pairs[0].status, 'identical');
    } finally {
        wasm.analysis_free(handle);
    }
});
