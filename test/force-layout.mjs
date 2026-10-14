import * as assert from 'node:assert/strict';
import * as force from '../source/force-layout.js';
import * as mock from './mock.js';
import { Graph } from '../source/grapher.js';
import { Worker } from '../source/view.js';
import { test } from 'node:test';

const fixture = (count = 5) => ({
    nodes: Array.from({ length: count }, (_, i) => ({ v: String(i), width: 80 + (i % 5) * 15, height: 30 + (i % 5) * 5 })),
    edges: count === 5 ? [
        { v: '0', w: '1', width: 20, height: 10 }, { v: '1', w: '2' },
        { v: '2', w: '0' }, { v: '3', w: '3' }, { v: '4', w: 'missing' }
    ] : Array.from({ length: count - 1 }, (_, i) => ({ v: String(i), w: String(i + 1) }))
});

const graphFixture = () => {
    const graph = new Graph(false);
    graph.options = { layout: 'force', direction: 'vertical' };
    const data = fixture();
    for (const node of data.nodes) {
        graph.setNode({ name: node.v, width: node.width, height: node.height, layout() {} });
    }
    for (const edge of data.edges.filter((edge) => edge.w !== 'missing')) {
        graph.setEdge({ ...edge, minlen: 1, weight: 1 });
    }
    return graph;
};

test('force kernel preserves established positions, collision clearance and edge routing', async () => {
    const data = fixture();
    await force.layout(data.nodes, data.edges);
    assert.deepEqual(data.nodes.map(({ x, y }) => [x, y]), [
        [161.3337982492128, 172.39656908241957],
        [213.89407372804328, 57.5],
        [327.2722663445967, 175.6240678152535],
        [102.5, 257.08363810652287],
        [277, 262.6240678152535]
    ]);
    for (const a of data.nodes) {
        for (const b of data.nodes) {
            if (a !== b) {
                assert.ok(Math.abs(a.x - b.x) >= (a.width + b.width) / 2 + 40 || Math.abs(a.y - b.y) >= (a.height + b.height) / 2 + 40);
            }
        }
    }
    const edge = data.edges[0];
    assert.deepEqual(edge.points, [
        { x: data.nodes[0].x, y: data.nodes[0].y },
        { x: edge.x, y: edge.y },
        { x: data.nodes[1].x, y: data.nodes[1].y }
    ]);
    assert.deepEqual(data.edges.at(-1).points, []);
    const empty = { nodes: [], edges: [] };
    await force.layout(empty.nodes, empty.edges);
    assert.deepEqual(empty, { nodes: [], edges: [] });
});

test('force worker returns exactly the serial kernel geometry', async () => {
    const worker = new Worker(new mock.Host({}));
    try {
        const data = fixture();
        const expected = structuredClone(data);
        await force.layout(expected.nodes, expected.edges);
        const message = await worker.request({ type: 'force.layout', ...data }, 20000);
        assert.equal(message.type, 'force.layout');
        assert.deepEqual(message.nodes, expected.nodes);
        assert.deepEqual(message.edges, expected.edges);
        const serial = graphFixture();
        const parallel = graphFixture();
        assert.equal(await serial.layout(null), '');
        assert.equal(await parallel.layout(worker), '');
        assert.deepEqual(parallel.getLayoutSnapshot(), serial.getLayoutSnapshot());
    } finally {
        worker.cancel(true);
    }
});

test('force graph honors cancellation and termination before applying geometry', async () => {
    await Promise.all(['cancel', 'terminate'].map(async (type) => {
        const graph = graphFixture();
        const before = graph.getLayoutSnapshot();
        const status = await graph.layout({ async request(message) {
            assert.equal(message.type, 'force.layout');
            return { type };
        } });
        assert.equal(status, type);
        assert.deepEqual(graph.getLayoutSnapshot(), before);
    }));
});

test('force graph retains serial fallback for unavailable or failed workers', async () => {
    const serial = graphFixture();
    await serial.layout(null);
    const expected = serial.getLayoutSnapshot();
    const unavailable = graphFixture();
    await unavailable.layout({ async request() {
        throw new Error('Worker unavailable');
    } });
    assert.deepEqual(unavailable.getLayoutSnapshot(), expected);
    const failed = graphFixture();
    await failed.layout({ async request() {
        return { type: 'error', message: 'Worker computation failed' };
    } });
    assert.deepEqual(failed.getLayoutSnapshot(), expected);
});

test('worker timeout cancels force computation and permits a fresh request', async () => {
    const worker = new Worker(new mock.Host({}));
    try {
        const message = await worker.request({ type: 'force.layout', ...fixture(2000) }, 5);
        assert.equal(message.type, 'cancel');
        assert.equal(worker._worker, null);
        const retry = await worker.request({ type: 'force.layout', ...fixture() }, 20000);
        assert.equal(retry.type, 'force.layout');
        assert.ok(retry.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y)));
    } finally {
        worker.cancel(true);
    }
});

test('force worker and serial fallback both allow event-loop progress', async () => {
    const worker = new Worker(new mock.Host({}));
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 1);
    try {
        const data = fixture(350);
        await force.layoutAsync(data.nodes, data.edges);
        assert.ok(ticks > 2, `Serial force layout blocked the event loop (${ticks} ticks)`);
        ticks = 0;
        const result = await worker.request({ type: 'force.layout', ...fixture(350) }, 20000);
        assert.equal(result.type, 'force.layout');
        assert.deepEqual(result.nodes, data.nodes);
        assert.deepEqual(result.edges, data.edges);
        assert.ok(ticks > 2, `Force worker blocked the event loop (${ticks} ticks)`);
    } finally {
        clearInterval(heartbeat);
        worker.cancel(true);
    }
});
