import * as assert from 'node:assert/strict';
import { Edge, Graph, Node } from '../source/grapher.js';
import { Host } from './mock.js';
import { test } from 'node:test';

const fixture = async (groups = 6, estimatedNodeSizeThreshold = 10000) => {
    const host = new Host({});
    const document = Object.create(host.document);
    document.activeElement = null;
    document.createElementNS = (...args) => {
        const element = host.document.createElementNS(...args);
        element.parentNode = null;
        const append = element.appendChild.bind(element);
        element.appendChild = (child) => {
            if (child.parentNode) {
                child.parentNode.removeChild(child);
            }
            append(child);
            child.parentNode = element;
        };
        const remove = element.removeChild.bind(element);
        element.removeChild = (child) => {
            remove(child);
            child.parentNode = null;
        };
        element.contains = (child) => child === element || element.childNodes.some((item) => item.contains && item.contains(child));
        element.classList.remove = (...tokens) => {
            element.setAttribute('class', (element.getAttribute('class') || '').split(' ').filter((token) => !tokens.includes(token)).join(' '));
        };
        return element;
    };
    const graph = new Graph(false);
    graph.enableViewportCulling(true, 100);
    graph.configureDeferredRendering({ detachInvisible: true, estimatedNodeSizeThreshold });
    graph._detachedElementLimit = 3;
    const nodes = [];
    const edges = [];
    const makeNode = (name) => {
        const node = new Node();
        node.name = name;
        const header = node.header();
        header.add('', ['node-item-type'], name);
        header.add('', ['node-item-name'], 'name');
        return node;
    };
    for (let i = 0; i < groups * 2; i++) {
        const node = makeNode(`n${i}`);
        node.x = Math.floor(i / 2) * 2000 + i % 2 * 150 + 50;
        node.y = 100;
        if (i === 0) {
            const list = node.list();
            list.add(list.argument('single', makeNode('inner')));
            list.add(list.argument('array', [makeNode('first'), makeNode('second')]));
            node.canvas();
            node._diffClass = 'node-diff-modified';
        }
        graph.setNode(node);
        nodes.push(node);
    }
    for (let i = 0; i < groups; i++) {
        const edge = new Edge(nodes[i * 2], nodes[i * 2 + 1]);
        edge.v = edge.from.name;
        edge.w = edge.to.name;
        edge.label = 'float32';
        edge.points = [{ x: edge.from.x, y: 100 }, { x: edge.to.x, y: 100 }];
        graph.setEdge(edge);
        edges.push(edge);
    }
    const origin = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    graph.build(document, origin);
    await graph.measure();
    nodes.forEach((node) => node.layout());
    graph.update();
    graph.populateTiles();
    graph.hideAllNodes();
    const pan = (i) => {
        const delta = graph.updateViewportVisibility({ x: i * 2000 - 100, y: -200, width: 500, height: 600 });
        graph.updateVisibleElements(document, delta);
    };
    return { graph, document, nodes, edges, pan };
};

test('medium deferred graphs allocate SVG only for the viewport and release distant visuals', async () => {
    const { graph, document, nodes, edges, pan } = await fixture(300, 500);
    assert.equal(graph._nodeGroupElement.childNodes.length, 0);
    assert.equal(graph._renderedNodes.size, 0);
    assert.ok(nodes.every((node) => node.element === null));
    assert.ok(edges.every((edge) => !edge.element));
    const geometry = nodes.map(({ x, y, width, height }) => [x, y, width, height]);
    pan(0);
    assert.equal(nodes.filter((node) => node.element).length, 2);
    pan(150);
    pan(299);
    assert.ok(nodes.filter((node) => node.element).length <= graph._detachedElementLimit + 2);
    assert.equal(nodes[0].element, null);
    assert.deepEqual(nodes.map(({ x, y, width, height }) => [x, y, width, height]), geometry);
    await graph.materializeAll(document);
    assert.ok(nodes.every((node) => node.element));
    assert.deepEqual(nodes.map(({ x, y, width, height }) => [x, y, width, height]), geometry);
});

test('panning bounds detached DOM and rebuilds evicted nodes and edge hit tests', async () => {
    const { graph, nodes, edges, pan } = await fixture();
    pan(0);
    const nodeElement = nodes[0].element;
    const edgeHitTest = edges[0].hitTest;
    const geometry = { x: nodes[0].x, y: nodes[0].y, width: nodes[0].width, height: nodes[0].height };
    let clicks = 0;
    nodes[0]._blocks[0]._entries[0].on('click', () => {
        clicks++;
    });
    for (let i = 1; i < 6; i++) {
        pan(i);
        assert.ok(graph._detachedElements.size <= graph._detachedElementLimit);
        assert.ok(graph._renderedNodes.size + graph._renderedEdges.size <= graph._detachedElementLimit + 3);
    }
    assert.equal(nodes[0].element, null);
    assert.equal(edges[0].element, null);
    assert.equal(edges[0].hitTest, null);
    assert.equal(graph._focusable.has(edgeHitTest), false);
    pan(0);
    assert.notEqual(nodes[0].element, nodeElement);
    assert.notEqual(edges[0].hitTest, edgeHitTest);
    assert.equal(graph._focusable.get(edges[0].hitTest), edges[0]);
    assert.equal(nodes[0].element.classList.contains('node-diff-modified'), true);
    assert.deepEqual({ x: nodes[0].x, y: nodes[0].y, width: nodes[0].width, height: nodes[0].height }, geometry);
    nodes[0]._blocks[0]._entries[0].emit('click');
    assert.equal(clicks, 1);
    assert.equal(nodes[0].element.parentNode, graph._nodeGroupElement);
    assert.equal(edges[0].labelElement.parentNode, graph._edgeLabelGroupElement);
});

test('eviction releases nested argument and header DOM while preserving geometry', async () => {
    const { nodes, pan } = await fixture();
    pan(0);
    const header = nodes[0]._blocks[0];
    const list = nodes[0]._blocks[1];
    const single = list._items[0];
    const array = list._items[1];
    const nested = [single.content, ...array.content];
    const nestedGeometry = nested.map((node) => [node.x, node.y, node.width, node.height]);
    nodes[0]._geometryLocked = true;
    nodes[0].measure = () => {
        throw new Error('Estimated layout dimensions must survive eviction');
    };
    pan(1);
    pan(2);
    for (const entry of header._entries) {
        assert.equal(entry.element, null);
        assert.equal(entry.path, null);
        assert.equal(entry.text, null);
        assert.equal(entry.line, null);
    }
    assert.equal(list.element, null);
    assert.equal(list.background, null);
    assert.equal(list.line, null);
    for (const argument of [single, array]) {
        assert.equal(argument.element, null);
        assert.equal(argument.border, null);
        assert.equal(argument.text, null);
    }
    for (const node of nested) {
        assert.equal(node.element, null);
        assert.equal(node.border, null);
        assert.equal(node._parentElement, null);
        assert.equal(node._blocks[0]._entries[0].text, null);
    }
    pan(0);
    assert.deepEqual(nested.map((node) => [node.x, node.y, node.width, node.height]), nestedGeometry);
    assert.ok(nested.every((node) => node.element && node.border && node._blocks[0]._entries[0].text));
});

test('selection, keyboard focus and hovered edges stay attached while offscreen', async () => {
    const { graph, document, nodes, edges, pan } = await fixture();
    pan(0);
    const argument = nodes[0]._blocks[1]._items[0];
    argument.select();
    document.activeElement = nodes[1]._blocks[0]._entries[0].text;
    graph._focused = edges[0];
    for (let i = 1; i < 6; i++) {
        pan(i);
    }
    assert.equal(nodes[0].element.parentNode, graph._nodeGroupElement);
    assert.equal(nodes[1].element.parentNode, graph._nodeGroupElement);
    assert.equal(edges[0].hitTest.parentNode, graph._edgePathHitTestGroupElement);
    assert.equal(graph._detachedElements.has(nodes[0]), false);
    argument.deselect();
    document.activeElement = null;
    graph._focused = null;
    nodes[0].element.classList.add('node-diff-selected');
    graph._hideNode(nodes[0]);
    assert.equal(nodes[0].element.parentNode, graph._nodeGroupElement);
    nodes[0].element.classList.remove('node-diff-selected');
    edges[0].element.classList.add('select');
    graph._hideEdge(edges[0]);
    assert.equal(edges[0].element.parentNode, graph._edgePathGroupElement);
    edges[0].element.classList.remove('select');
    for (let i = 1; i < 4; i++) {
        pan(i);
    }
    assert.equal(nodes[0].element, null);
    assert.equal(nodes[1].element, null);
    assert.equal(edges[0].element, null);
});

test('export materializes all evicted DOM and ignores viewport changes while building', async () => {
    const { graph, document, nodes, edges, pan } = await fixture(130);
    pan(0);
    const exporting = graph.materializeAll(document);
    graph._visibleNodes = new Set();
    graph._visibleEdges = new Set();
    graph.updateVisibleElements(document);
    await exporting;
    assert.ok(nodes.every((node) => node.element && node.element.parentNode === graph._nodeGroupElement));
    assert.ok(edges.every((edge) => edge.element && edge.element.parentNode === graph._edgePathGroupElement));
    assert.equal(graph._focusable.size, edges.length);
    assert.equal(graph._detachedElements.size, 0);
    graph.hideAllNodes();
    graph.resetViewportVisibility();
    pan(0);
    assert.ok(graph._detachedElements.size <= graph._detachedElementLimit);
    assert.ok(graph._focusable.size <= graph._detachedElementLimit + 1);
});

test('queued viewport builds cannot resurrect nodes that have left the viewport', async (context) => {
    const { graph, document, nodes } = await fixture(20);
    const idle = [];
    globalThis.requestIdleCallback = (callback) => idle.push(callback);
    context.after(() => {
        delete globalThis.requestIdleCallback;
    });
    graph._visibleNodes = new Set(nodes.map((node) => node.name));
    graph._visibleEdges = new Set();
    graph.updateVisibleElements(document, { addedNodes: graph._visibleNodes, removedNodes: new Set(), addedEdges: new Set(), removedEdges: new Set() });
    assert.ok(idle.length > 0);
    graph._visibleNodes = new Set([nodes[0].name]);
    graph.updateVisibleElements(document, { addedNodes: new Set(), removedNodes: new Set(nodes.slice(1).map((node) => node.name)), addedEdges: new Set(), removedEdges: new Set() });
    while (idle.length > 0) {
        idle.shift()();
    }
    assert.equal(nodes[0].element.parentNode, graph._nodeGroupElement);
    assert.ok(nodes.slice(1).every((node) => !node.element || !node.element.parentNode));
    assert.ok(graph._detachedElements.size <= graph._detachedElementLimit);
});
