import * as assert from 'node:assert/strict';
import * as mock from './mock.js';
import { Edge, TileManager, ViewportObserver } from '../source/grapher.js';
import { Graph as ViewGraph } from '../source/view.js';
import { test } from 'node:test';

test('continuous panning updates once per frame with the latest viewport', () => {
    const frames = new Map();
    let next = 0;
    globalThis.requestAnimationFrame = (callback) => {
        const id = next++;
        frames.set(id, callback);
        return id;
    };
    globalThis.cancelAnimationFrame = (id) => frames.delete(id);
    const updates = [];
    const observer = new ViewportObserver((viewport) => updates.push(viewport));
    const viewport = (x) => ({ x, y: 0, width: 800, height: 600, zoom: 1 });
    const flush = () => {
        const pending = Array.from(frames.values());
        frames.clear();
        pending.forEach((callback) => callback());
    };
    try {
        observer.observe(viewport(0));
        observer.observe(viewport(100));
        observer.observe(viewport(200));
        assert.equal(frames.size, 1);
        flush();
        assert.deepEqual(updates.map((value) => value.x), [200]);
        observer.observe(viewport(300));
        observer.observe(viewport(400));
        flush();
        assert.deepEqual(updates.map((value) => value.x), [200, 400]);
        observer.observe(viewport(410));
        assert.equal(frames.size, 0);
        observer.observe(viewport(500));
        observer.observe(viewport(400));
        flush();
        assert.equal(updates.at(-1).x, 400);
        observer.observe(viewport(600));
        observer.disconnect();
        assert.equal(frames.size, 0);
        observer.observe(viewport(0));
        observer.disconnect();
        assert.equal(frames.size, 0);
    } finally {
        observer.disconnect();
        delete globalThis.requestAnimationFrame;
        delete globalThis.cancelAnimationFrame;
    }
});

test('viewport scheduling works and cancels without animation-frame APIs', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const updates = [];
    const observer = new ViewportObserver((viewport) => updates.push(viewport));
    const viewport = { x: 0, y: 0, width: 800, height: 600, zoom: 1 };
    observer.observe(viewport);
    observer.observe({ ...viewport, x: 200 });
    context.mock.timers.tick(0);
    assert.equal(updates.length, 1);
    assert.equal(updates[0].x, 200);
    observer.observe({ ...viewport, x: 400 });
    observer.disconnect();
    context.mock.timers.tick(0);
    assert.equal(updates.length, 1);
});

test('diagonal edges index path tiles without filling empty bounding-box tiles', () => {
    const manager = new TileManager(100);
    manager.addEdge('diagonal', [{ x: 10, y: 10 }, { x: 30010, y: 30010 }]);
    assert.ok(manager.getTileInfo().tileCount < 1000);
    assert.equal(manager.queryViewport({ x: 15000, y: 15000, width: 100, height: 100 }, 0).edges.has('diagonal'), true);
    assert.equal(manager.queryViewport({ x: 10, y: 15000, width: 100, height: 100 }, 0).edges.has('diagonal'), false);
});

test('curve indexing contains sampled SVG curves, including bends and negative coordinates', () => {
    const paths = [
        [{ x: -800, y: -100 }, { x: 700, y: -600 }, { x: -500, y: 900 }, { x: 900, y: 600 }],
        [{ x: 0, y: 0 }, { x: 0, y: 1000 }, { x: 1000, y: 1000 }],
        [{ x: -200, y: -200 }, { x: -200, y: -200 }],
        [{ x: 10, y: 10 }]
    ];
    for (const points of paths) {
        const manager = new TileManager(50);
        manager.addEdge('curve', points);
        for (const style of ['basis', 'orthogonal']) {
            const path = style === 'basis' ? new Edge.Curve(points).path.data : new Edge.Polyline(points, 30).path.data;
            let start = null;
            for (const match of path.matchAll(/([MLCQ])([^MLCQ]*)/g)) {
                const values = match[2].split(',').map(Number);
                const controls = Array.from({ length: values.length / 2 }, (_, i) => ({ x: values[i * 2], y: values[i * 2 + 1] }));
                if (match[1] === 'M') {
                    start = controls[0];
                } else {
                    for (let sample = 0; sample <= 100; sample++) {
                        const t = sample / 100;
                        let level = [start, ...controls];
                        while (level.length > 1) {
                            const previous = level;
                            level = previous.slice(1).map((point, i) => ({ x: (1 - t) * previous[i].x + t * point.x, y: (1 - t) * previous[i].y + t * point.y }));
                        }
                        const point = level[0];
                        assert.equal(manager.queryViewport({ ...point, width: 0, height: 0 }, 0).edges.has('curve'), true, `${style} missed ${JSON.stringify(point)}`);
                    }
                    start = controls.at(-1);
                }
            }
            assert.equal(manager.queryViewport({ ...points[0], width: 0, height: 0 }, 0).edges.has('curve'), true);
        }
    }
});

test('tile coordinates do not alias outside the packed range and overview scans occupied tiles', () => {
    const manager = new TileManager(1);
    manager.addNode('near', { x: 0, y: 0, width: 0, height: 0 });
    manager.addNode('far', { x: 65536, y: -65536, width: 0, height: 0 });
    assert.deepEqual(Array.from(manager.queryViewport({ x: 0, y: 0, width: 0, height: 0 }, 0).nodes), ['near']);
    assert.deepEqual(Array.from(manager.queryViewport({ x: 65536, y: -65536, width: 0, height: 0 }, 0).nodes), ['far']);
    let lookups = 0;
    const get = manager._tiles.get.bind(manager._tiles);
    manager._tiles.get = (key) => {
        lookups++; return get(key);
    };
    assert.deepEqual(Array.from(manager.queryViewport({ x: -100000, y: -100000, width: 200000, height: 200000 }, 0).nodes).sort(), ['far', 'near']);
    assert.equal(lookups, 0);
    assert.throws(() => new TileManager(0), /tile size/);
    assert.throws(() => manager.addEdge('invalid', [{ x: Infinity, y: 0 }]), /coordinates/);
});

test('tile indexing reuses the rendered boundary points without changing SVG routing', () => {
    const curve = 'M13.275862068965518,15L44.39655172413793,62.5C75.51724137931035,110,137.75862068965517,205,235.54597701149427,285.8333333333333C333.3333333333333,366.6666666666667,466.6666666666667,433.3333333333333,582.8333333333334,549.1666666666666C699,665,798,830,847.5,912.5L897,995';
    const orthogonal = 'M13.275862068965518,15L183.55921228067382,274.9061661126074Q200,300,226.83281572999746,313.41640786499875L573.1671842700025,486.58359213500125Q600,500,615.4348726628258,525.7247877713763L897,995';
    const edge = new Edge({ x: 10, y: 10, width: 20, height: 10 }, { x: 900, y: 1000, width: 20, height: 10 });
    edge.points = [{ x: 20, y: 15 }, { x: 200, y: 300 }, { x: 600, y: 500 }, { x: 890, y: 995 }];
    let path = '';
    edge.element = { setAttribute(name, value) {
        if (name === 'd') {
            path = value;
        }
    } };
    edge.hitTest = { setAttribute() {} };
    edge.update();
    assert.equal(path, curve);
    edge._pathStyle = 'orthogonal';
    edge.update();
    assert.equal(path, orthogonal);
});

test('metadata-based graph measurement waits for fonts without forced frames or DOM reflow', async () => {
    let frames = 0;
    let fontsReady = false;
    const graph = {
        host: { document: { fonts: { ready: Promise.resolve().then(() => {
            fontsReady = true;
        }) } },
        window: { requestAnimationFrame() {
            frames++;
        }, getComputedStyle() {
            throw new Error('Unexpected style measurement');
        } } },
        edges: new Map(), nodes: new Map(), useEstimatedNodeSizes: () => true,
        _containerElement: {}, _canvasElement: { getBBox() {
            throw new Error('Unexpected canvas reflow');
        } }
    };
    await ViewGraph.prototype.measure.call(graph);
    assert.equal(fontsReady, true);
    assert.equal(frames, 0);
});

test('edge labels remain visible when their bounds extend beyond the curve tiles', () => {
    const manager = new TileManager(100);
    manager.addEdge('labelled', [{ x: 10, y: 10 }, { x: 10, y: 500 }], { x: 200, y: 200, width: 400, height: 30 });
    assert.equal(manager.queryViewport({ x: 550, y: 210, width: 20, height: 10 }, 0).edges.has('labelled'), true);
    assert.equal(manager.queryViewport({ x: 700, y: 210, width: 20, height: 10 }, 0).edges.has('labelled'), false);
});

test('model validation DOM provides a finite viewport through zoom and scrolling', () => {
    const host = new mock.Host({});
    const container = host.document.getElementById('target');
    const origin = host.document.createElementNS('http://www.w3.org/2000/svg', 'g');
    origin.setAttribute('transform', 'translate(100, 100) scale(1)');
    const graph = {
        view: { options: { direction: 'vertical' } },
        _containerElement: container, _originElement: origin,
        _canvasElement: { style: {} }, _width: 2000, _height: 3000, _zoom: 1
    };
    ViewGraph.prototype._updateZoom.call(graph, 0.5);
    const viewport = ViewGraph.prototype._getViewportBounds.call(graph);
    assert.ok(Object.values(viewport).every(Number.isFinite));
    assert.equal(viewport.width, 2048);
    assert.equal(viewport.height, 1536);
    graph._getOriginTranslate = ViewGraph.prototype._getOriginTranslate;
    ViewGraph.prototype._scrollToGraphBounds.call(graph, { x: 2000, y: 3000, width: 100, height: 100 }, 'auto');
    assert.equal(container.scrollLeft, 563);
    assert.equal(container.scrollTop, 1191);
    container.scrollTo({ left: -100 });
    assert.equal(container.scrollLeft, 0);
    assert.equal(container.scrollTop, 1191);
    assert.ok(Object.values(ViewGraph.prototype._getViewportBounds.call(graph)).every(Number.isFinite));
});
