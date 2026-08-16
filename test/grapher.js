import { Graph } from '../source/grapher.js';
import { Graph as ViewGraph } from '../source/view.js';
import assert from 'node:assert/strict';

const graph = new Graph(true);
const encoder = 'encoder\ngroup';
const branch = 'encoder/branch\ngroup';
const builtNodes = [];
const builtEdges = [];
const leaf = (name) => ({
    name,
    build(document, parent) {
        this.element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        parent.appendChild(this.element);
        builtNodes.push(name);
    }
});
const edge = (v, w) => ({
    v,
    w,
    build(document, parent) {
        this.element = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        if (this.class) {
            this.element.setAttribute('class', this.class);
        }
        parent.appendChild(this.element);
        builtEdges.push(`${v}:${w}`);
    },
    update() {
    },
    select() {
        return [];
    },
    deselect() {
    }
});
for (const name of ['a', 'b', 'c', 'd', encoder, branch]) {
    graph.setNode(['a', 'b', 'c', 'd'].includes(name) ? leaf(name) : { name });
}
graph.setParent(branch, encoder);
graph.setParent('a', branch);
graph.setParent('b', branch);
graph.setParent('c', encoder);
graph.setEdge(edge('a', 'b'));
graph.setEdge(edge('a', 'd'));
graph.setEdge(edge('c', 'd'));
graph.setEdge(edge('d', 'b'));

const index = graph.createHierarchyIndex();
const group = index.groups.get(encoder);
assert.deepEqual(group.memberNodeIds, ['a', 'b', 'c']);
assert.equal(group.proxyId, '\x00hierarchy:encoder%0Agroup');
assert.equal(group.internalEdgeCount, 1);
assert.deepEqual(group.inputPorts, [{ nodeId: 'b', edgeCount: 1 }]);
assert.deepEqual(group.outputPorts, [{ nodeId: 'a', edgeCount: 1 }, { nodeId: 'c', edgeCount: 1 }]);

const projection = index.project({ collapsedGroupIds: [branch, encoder] });
assert.deepEqual(projection.collapsedGroupIds, [encoder]);
assert.deepEqual(projection.collapsedNodeIds, ['a', 'b', 'c']);
assert.deepEqual(projection.nodes.map((node) => node.id), ['\x00hierarchy:encoder%0Agroup', 'd']);
assert.deepEqual(projection.edges, [
    {
        v: '\x00hierarchy:encoder%0Agroup',
        w: 'd',
        edgeCount: 2,
        sourcePorts: [{ nodeId: 'a', edgeCount: 1 }, { nodeId: 'c', edgeCount: 1 }],
        targetPorts: [{ nodeId: 'd', edgeCount: 2 }]
    },
    {
        v: 'd',
        w: '\x00hierarchy:encoder%0Agroup',
        edgeCount: 1,
        sourcePorts: [{ nodeId: 'd', edgeCount: 1 }],
        targetPorts: [{ nodeId: 'b', edgeCount: 1 }]
    }
]);

const initialProjection = index.createInitialProjection({ minimumGroupSize: 2, minimumSavedNodes: 2 });
assert.deepEqual(initialProjection.collapsedGroupIds, [encoder]);
assert.equal(graph.nodes.size, 6);
assert.equal(graph.edges.size, 4);
assert.equal(graph.parent('a'), branch);
assert.equal(graph.parent(branch), encoder);

const element = () => ({
    children: [],
    style: { setProperty() {}, removeProperty() {} },
    setAttribute() {},
    addEventListener() {},
    appendChild(child) {
        this.children.push(child);
        child.parentNode = this;
    }
});
const document = { createElementNS: () => element() };
graph.build(document, element());
assert.deepEqual(builtNodes.sort(), ['a', 'b', 'c', 'd']);
assert.deepEqual(builtEdges.sort(), ['a:b', 'a:d', 'c:d', 'd:b']);

Object.assign(graph.node('a').label, { x: 10, y: 20, width: 4, height: 6 });
Object.assign(graph.node('b').label, { x: 30, y: 40, width: 4, height: 6 });
Object.assign(graph.node('c').label, { x: 50, y: 60, width: 4, height: 6 });
index.updateBounds();
assert.deepEqual(group.bounds, { x: 8, y: 17, width: 44, height: 46 });

const viewGraph = new ViewGraph({
    model: { identifier: 'nested-groups' },
    options: { weights: false, names: false, attributes: false }
}, true);
viewGraph.add({
    groups: true,
    inputs: [],
    outputs: [],
    nodes: [
        { name: 'outer', group: 'encoder/branch', type: { name: 'Test' }, inputs: [], outputs: [], attributes: [] },
        { name: 'inner', group: 'encoder/branch/deep', type: { name: 'Test' }, inputs: [], outputs: [], attributes: [] }
    ]
});
assert.equal(viewGraph.parent('0'), 'encoder/branch\ngroup');
assert.equal(viewGraph.parent('1'), 'encoder/branch/deep\ngroup');
assert.equal(viewGraph.parent('encoder/branch\ngroup'), 'encoder\ngroup');
assert.equal(viewGraph.parent('encoder/branch/deep\ngroup'), 'encoder/branch\ngroup');

const svgElement = () => {
    const attributes = new Map();
    return {
        children: [],
        get lastChild() {
            return this.children.length > 0 ? this.children[this.children.length - 1] : null;
        },
        style: {
            setProperty() {},
            removeProperty() {}
        },
        classList: {
            add() {},
            remove() {},
            contains() {
                return false;
            }
        },
        setAttribute(name, value) {
            attributes.set(name, String(value));
        },
        getAttribute(name) {
            return attributes.get(name) || null;
        },
        addEventListener() {},
        appendChild(child) {
            this.children.push(child);
            child.parentNode = this;
        },
        removeChild(child) {
            this.children.splice(this.children.indexOf(child), 1);
            child.parentNode = null;
        }
    };
};
const hierarchyDocument = {
    createElementNS: () => svgElement(),
    createDocumentFragment: () => svgElement(),
    createTextNode: (text) => ({ textContent: text })
};
const hierarchyLeaf = (name) => ({
    name,
    build(document, parent) {
        this.element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        parent.appendChild(this.element);
    },
    measure() {
        this.width = 80;
        this.height = 40;
    },
    layout() {},
    update() {}
});
const hierarchyGraph = new ViewGraph({
    model: { identifier: 'hierarchy-projection' },
    options: { direction: 'vertical' },
    host: {
        document: hierarchyDocument,
        event() {}
    }
}, true);
for (const name of ['a', 'b', 'd', 'e', 'block\ngroup']) {
    hierarchyGraph.setNode(name === 'block\ngroup' ? { name } : hierarchyLeaf(name));
}
hierarchyGraph.setParent('a', 'block\ngroup');
hierarchyGraph.setParent('b', 'block\ngroup');
const controlEdge = Object.assign(edge('a', 'd'), {
    id: 'edge-control-a-d',
    label: 'control',
    class: 'edge-path-control-dependency'
});
hierarchyGraph.setEdge(controlEdge);
hierarchyGraph.setEdge(edge('b', 'd'));
hierarchyGraph.setEdge(edge('e', 'd'));
hierarchyGraph.enableViewportCulling(true);
hierarchyGraph.configureDeferredRendering({
    deferredNodeBuild: true,
    deferredEdgeBuild: true,
    estimatedNodeSizeThreshold: 1
});
hierarchyGraph.requestHierarchyRendering({
    minimumNodeCount: 3,
    minimumGroupSize: 2,
    minimumSavedNodes: 1
});
hierarchyGraph.build(hierarchyDocument, svgElement());
const proxyId = '\x00hierarchy:block%0Agroup';
assert.deepEqual(Array.from(hierarchyGraph.nodes.keys()), [proxyId, 'd', 'e']);
assert.equal(hierarchyGraph.hasNode('a'), false);
assert.equal(hierarchyGraph._hierarchy.canonical.nodes.has('a'), true);
const bundledEdge = hierarchyGraph.edge(proxyId, 'd');
assert.equal(bundledEdge.label.bundle.edgeCount, 2);
assert.equal(bundledEdge.label._hierarchyBundle, true);
assert.equal(hierarchyGraph._projectedEdge('a', 'd'), bundledEdge);
assert.ok(hierarchyGraph.node(proxyId).label.element);
assert.ok(bundledEdge.label.element);

hierarchyGraph._canvasElement = null;
hierarchyGraph._containerElement = null;
hierarchyGraph._getViewportBounds = () => ({ x: -10000, y: -10000, width: 20000, height: 20000, zoom: 1 });
await hierarchyGraph._rebuildHierarchyRendering();
const persistentEdge = hierarchyGraph.edge('e', 'd').label;
const persistentEdgeElement = persistentEdge.element;
assert.ok(persistentEdgeElement);
assert.ok(hierarchyGraph._visibleEdges.has('e:d'));

await hierarchyGraph.toggleHierarchyGroup('block\ngroup');
const controlId = '\x00hierarchy-control:block%0Agroup';
assert.equal(hierarchyGraph.hasNode(proxyId), false);
assert.equal(hierarchyGraph.hasNode('a'), true);
assert.equal(hierarchyGraph.hasNode('b'), true);
assert.equal(hierarchyGraph.hasNode(controlId), true);
assert.equal(hierarchyGraph.edge('a', 'd').label, controlEdge);
assert.equal(hierarchyGraph.edge('a', 'd').label.id, 'edge-control-a-d');
assert.equal(hierarchyGraph.edge('a', 'd').label.label, 'control');
assert.equal(hierarchyGraph.edge('a', 'd').label.class, 'edge-path-control-dependency');
assert.ok(persistentEdge.element);
assert.notEqual(persistentEdge.element, persistentEdgeElement);
assert.equal(hierarchyGraph._projectedEdge('a', 'd'), hierarchyGraph.edge('a', 'd'));
assert.ok(hierarchyGraph.node(controlId).label.element);

await hierarchyGraph.toggleHierarchyGroup('block\ngroup');
assert.deepEqual(Array.from(hierarchyGraph.nodes.keys()), [proxyId, 'd', 'e']);
assert.equal(hierarchyGraph.edge(proxyId, 'd').label.bundle.edgeCount, 2);
assert.ok(hierarchyGraph.node(proxyId).label.element);

const makeValue = (name) => ({ name, type: {} });
const productionGraph = new ViewGraph({
    model: { identifier: 'hierarchy-after-values' },
    options: { direction: 'vertical', weights: false, names: false, attributes: false },
    host: { document: hierarchyDocument }
}, true);
const aToD = makeValue('a-to-d');
const bToD = makeValue('b-to-d');
productionGraph.enableViewportCulling(true);
productionGraph.configureDeferredRendering({
    deferredNodeBuild: true,
    deferredEdgeBuild: true,
    estimatedNodeSizeThreshold: 1
});
productionGraph.add({
    groups: true,
    inputs: [],
    outputs: [],
    nodes: [
        { name: 'a', group: 'block', type: { name: 'Test' }, inputs: [], outputs: [{ value: [aToD] }], attributes: [] },
        { name: 'b', group: 'block', type: { name: 'Test' }, inputs: [], outputs: [{ value: [bToD] }], attributes: [] },
        { name: 'd', type: { name: 'Test' }, inputs: [{ value: [aToD, bToD] }], outputs: [], attributes: [] }
    ]
});
productionGraph.requestHierarchyRendering({
    minimumNodeCount: 3,
    minimumGroupSize: 2,
    minimumSavedNodes: 1
});
productionGraph.build(hierarchyDocument, svgElement());
assert.equal(productionGraph.hasNode(proxyId), true);
assert.equal(productionGraph.edge(proxyId, '2').label.bundle.edgeCount, 2);
