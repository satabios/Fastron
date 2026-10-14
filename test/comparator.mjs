import * as assert from 'node:assert/strict';
import { Controller } from '../source/comparator.js';
import { Host } from './mock.js';
import { test } from 'node:test';

const node = (name, op = 'Relu', dimensions = [2]) => ({ name,
    type: { name: op, category: 'Activation', module: 'ai.onnx', version: 1 }, attributes: [],
    inputs: [{ name: 'input', value: [{ name: 'x', type: { dataType: 'float32', shape: { dimensions } } }] }],
    outputs: [{ name: 'output', value: [{ name: `${name}:0`, type: { dataType: 'float32', shape: { dimensions } } }] }]
});
const compare = async (a, b) => {
    const controller = Object.create(Controller.prototype);
    const state = controller._compareNodesPhase1({ nodes: a }, { nodes: b });
    return new Promise((resolve) => {
        controller._compareNodesPhase2(state, resolve);
    });
};

test('comparator initializes without eager decoder imports', () => {
    assert.doesNotThrow(() => new Controller(new Host({ serial: true })));
});

test('shape, dtype, operator version and attribute type changes are modified', async () => {
    await Promise.all([
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
            b.attributes[0].type = 'float32';
        }
    ].map(async (change) => {
        const a = node('same');
        a.attributes = [{ name: 'alpha', type: 'int32', value: 1 }];
        const b = structuredClone(a);
        change(b);
        const result = await compare([a], [b]);
        assert.equal(result.pairs[0].status, 'modified');
    }));
});

test('unrelated operators in the same category remain unmatched', async () => {
    const result = await compare([node('a')], [node('b', 'Sigmoid')]);
    assert.equal(result.pairs.length, 0);
    assert.deepEqual(result.onlyInA, [0]);
    assert.deepEqual(result.onlyInB, [0]);
});

test('duplicate names use distinguishing metadata instead of array order', async () => {
    const result = await compare([node('same', 'Relu', [2]), node('same', 'Relu', [3])],
        [node('same', 'Relu', [3]), node('same', 'Relu', [2])]);
    assert.deepEqual(result.pairs.map((p) => [p.indexA, p.indexB]).sort(), [[0, 1], [1, 0]]);
});

test('ambiguous anonymous nodes are not arbitrarily paired', async () => {
    const result = await compare([node(''), node('')], [node(''), node('')]);
    assert.equal(result.pairs.length, 0);
});

test('rewired edges are modified, renamed internal tensors are unchanged', async () => {
    const a = [node('left'), node('right'), node('sink')];
    a[2].inputs[0].value[0].name = 'left:0';
    const b = structuredClone(a);
    b[2].inputs[0].value[0].name = 'right:0';
    assert.equal((await compare(a, b)).pairs.find((p) => p.indexA === 2).status, 'modified');
    b[2].inputs[0].value[0].name = 'renamed';
    b[0].outputs[0].value[0].name = 'renamed';
    assert.equal((await compare(a, b)).pairs.find((p) => p.indexA === 2).status, 'identical');
});

test('attribute equality preserves binary types, maps and cyclic values', () => {
    const c = Object.create(Controller.prototype);
    assert.equal(c._valuesEqual(new Uint8Array([1]), new Uint8Array([2])), false);
    assert.equal(c._valuesEqual(new Uint8Array([1]), new Int8Array([1])), false);
    assert.equal(c._valuesEqual(new Map([['a', 1]]), new Map([['a', 2]])), false);
    assert.equal(c._valuesEqual(null, undefined), false);
    const a = {}; a.self = a;
    const b = {}; b.self = b;
    assert.equal(c._valuesEqual(a, b), true);
});

test('empty graphs retain adjacency and scalar shape scores are finite', () => {
    const c = Object.create(Controller.prototype);
    assert.ok(c._compareNodesPhase1({ nodes: [] }, { nodes: [] }).adjA);
    assert.ok(Number.isFinite(c._calculateSimilarity(node('a', 'Relu', []), node('b', 'Relu', []))));
});

test('stable names expose operator and domain replacements as modified', async () => {
    await Promise.all([(b) => {
        b.type.name = 'Sigmoid';
    }, (b) => {
        b.type.module = 'custom';
    }].map(async (change) => {
        const a = node('stable');
        const b = structuredClone(a);
        change(b);
        assert.equal((await compare([a], [b])).pairs[0].status, 'modified');
    }));
});

test('large ambiguous groups stay unmatched without a dense assignment matrix', async () => {
    const nodes = Array.from({ length: 201 }, () => node(''));
    assert.equal((await compare(nodes, structuredClone(nodes))).pairs.length, 0);
});

test('tensor comparisons do not access remote payload getters', async () => {
    const a = node('same');
    const b = structuredClone(a);
    for (const n of [a, b]) {
        const tensor = { type: n.inputs[0].value[0].type, encoding: '<' };
        Object.defineProperty(tensor, 'values', { get: () => {
            throw new Error('Unexpected weight fetch');
        } });
        n.inputs[0].value[0].initializer = tensor;
        n.attributes = [{ name: 'tensor', type: 'tensor', value: tensor }];
    }
    assert.equal((await compare([a], [b])).pairs[0].status, 'identical');
});

test('shared references, cyclic values and reordered primitive map keys compare equally', () => {
    const c = Object.create(Controller.prototype);
    const shared = { value: 1 };
    assert.equal(c._valuesEqual([shared, shared], [{ value: 1 }, { value: 1 }]), true);
    assert.equal(c._valuesEqual(new Map([['a', 1], ['b', 2]]), new Map([['b', 2], ['a', 1]])), true);
});

test('completed matching clears provisional modified highlights', () => {
    const c = Object.create(Controller.prototype);
    const n = node('same');
    const classes = new Set();
    const rendered = { element: { classList: {
        add: (name) => classes.add(name),
        remove: (...names) => {
            names.forEach((name) => classes.delete(name));
        }
    } } };
    const graph = { _table: new Map([[n, rendered]]) };
    const target = { nodes: [n] };
    const result = { pairs: [{ indexA: 0, indexB: 0, status: 'modified' }], onlyInA: [], onlyInB: [] };
    c._applyDiffHighlighting(graph, graph, target, target, result);
    assert.equal(classes.has('node-diff-modified'), true);
    result.pairs[0].status = 'identical';
    c._applyDiffHighlighting(graph, graph, target, target, result);
    assert.equal(classes.has('node-diff-modified'), false);
    assert.equal(rendered._diffClass, null);
});

test('alignment keeps graph inputs and outputs clear of clickable operators', () => {
    const c = Object.create(Controller.prototype);
    const operator = node('same');
    const input = { name: 'x' };
    const output = { name: 'y' };
    const rendered = { height: 60, y: 100 };
    const renderedInput = { height: 24, y: 20 };
    const renderedOutput = { height: 24, y: 40 };
    const graph = { _table: new Map([[operator, rendered], [input, renderedInput], [output, renderedOutput]]), edges: new Map() };
    const target = { inputs: [input], outputs: [output] };
    c._applyYAlignment(graph, graph, [operator], [operator], [{ indexA: 0, indexB: 0 }], target, target);
    assert.ok(renderedInput.y + renderedInput.height / 2 < rendered.y - rendered.height / 2);
    assert.ok(renderedOutput.y - renderedOutput.height / 2 > rendered.y + rendered.height / 2);
});

test('fused node metadata and control dependency changes are modified', async () => {
    const a = [node('left'), node('right'), node('sink')];
    a[2].chain = [node('activation')];
    a[2].controlDependencies = [{ name: 'left:0' }];
    const b = structuredClone(a);
    b[2].chain[0].type.name = 'Sigmoid';
    assert.equal((await compare(a, b)).pairs.find((p) => p.indexA === 2).status, 'modified');
    b[2].chain[0].type.name = 'Relu';
    b[2].controlDependencies[0].name = 'right:0';
    assert.equal((await compare(a, b)).pairs.find((p) => p.indexA === 2).status, 'modified');
});

test('renamed fused outputs preserve their producer identity', async () => {
    const a = [node('left'), node('sink')];
    a[0].chain = [node('fused')];
    a[1].inputs[0].value[0].name = 'fused:0';
    const b = structuredClone(a);
    b[0].chain[0].outputs[0].value[0].name = 'renamed';
    b[1].inputs[0].value[0].name = 'renamed';
    assert.ok((await compare(a, b)).pairs.every((p) => p.status === 'identical'));
});
