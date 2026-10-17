
import * as force from './force-layout.js';
import { getTextLayoutService } from './text-layout-service.js';

const grapher = {};

const textLayout = getTextLayoutService();
const NODE_FONT = '11px -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", "Ubuntu", "Droid Sans", sans-serif, "PingFang SC"';
const ARGUMENT_FONT = '9px -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", "Ubuntu", "Droid Sans", sans-serif, "PingFang SC"';
const EDGE_FONT = '10px -apple-system, BlinkMacSystemFont, "Segoe WPC", "Segoe UI", "Ubuntu", "Droid Sans", sans-serif, "PingFang SC"';

grapher.Graph = class {

    constructor(compound) {
        this._compound = compound;
        this._nodes = new Map();
        this._edges = new Map();
        this._nodeEdges = new Map(); // nodeId -> Set of edge keys for O(1) adjacency lookup
        this._focusable = new Map();
        this._focused = null;
        this._children = new Map();
        this._children.set('\x00', new Map());
        this._parent = new Map();
        this._tileManager = null;
        this._viewportCulling = false;
        this._visibleNodes = null;
        this._visibleEdges = null;
        this._renderedNodes = new Set();
        this._renderedEdges = new Set();
        this._deferredNodeBuild = false;
        this._deferredEdgeBuild = false;
        this._skipHiddenUpdate = false;
        this._estimatedNodeSizeThreshold = 500;
        this._estimatedNodeWidth = 150;
        this._estimatedNodeHeight = 65;
        this._detachInvisible = false;
        this._detachedElements = new Map();
        this._detachedElementLimit = 256;
        this._pinnedElements = new Map();
        this._visibilityVersion = 0;
        this._mainThreadLayoutThreshold = 5000;
    }

    enableViewportCulling(enabled = true, tileSize = undefined) {
        this._viewportCulling = enabled;
        if (enabled && !this._tileManager) {
            this._tileManager = new grapher.TileManager(tileSize || 300);
        }
    }

    configureDeferredRendering(options = {}) {
        this._deferredNodeBuild = options.deferredNodeBuild !== false;
        this._deferredEdgeBuild = options.deferredEdgeBuild !== false;
        this._skipHiddenUpdate = options.skipHiddenUpdate !== false;
        if (options.detachInvisible !== undefined) {
            this._detachInvisible = Boolean(options.detachInvisible);
        }
        if (Number.isFinite(options.estimatedNodeSizeThreshold)) {
            this._estimatedNodeSizeThreshold = options.estimatedNodeSizeThreshold;
        }
        if (Number.isFinite(options.estimatedNodeWidth)) {
            this._estimatedNodeWidth = options.estimatedNodeWidth;
        }
        if (Number.isFinite(options.estimatedNodeHeight)) {
            this._estimatedNodeHeight = options.estimatedNodeHeight;
        }
    }

    useEstimatedNodeSizes() {
        return this._viewportCulling && this._deferredNodeBuild && this.nodes.size > this._estimatedNodeSizeThreshold;
    }

    _isLeafNode(nodeId) {
        return this.children(nodeId).length === 0;
    }

    _useOverview(node) {
        return this._overview && node._geometryLocked && typeof node._overviewLabel === 'string' && !this._isPinned(node);
    }

    _ensureNodeElement(nodeId, document, allowOverview = false) {
        const entry = this.node(nodeId);
        if (!entry) {
            return null;
        }
        const node = entry.label;
        if (!this._isLeafNode(nodeId) || !this._nodeGroupElement) {
            return node;
        }
        const simplified = Boolean(allowOverview && this._useOverview(node));
        if (node.element && Boolean(node._simplified) === simplified) {
            return node;
        }
        const focused = node.element && document.activeElement && node.element.contains(document.activeElement);
        if (node.element) {
            if (node.element.parentNode) {
                node.element.parentNode.removeChild(node.element);
            }
            node.release();
        }
        node._simplified = simplified;
        if (simplified) {
            node.buildOverview(document, this._nodeGroupElement);
        } else {
            node.build(document, this._nodeGroupElement);
        }
        if (focused) {
            node.element.setAttribute('tabindex', '-1');
            node.element.focus();
        }
        this._renderedNodes.add(nodeId);
        return node;
    }

    _ensureEdgeElement(edge, document) {
        const label = edge.label;
        const edgeKey = `${edge.v}:${edge.w}`;
        if (label.element || !this._deferredEdgeBuild || !this._edgePathGroupElement || !this._edgePathHitTestGroupElement || !this._edgeLabelGroupElement) {
            return label;
        }
        const pathParent = label._tunnel ? this._tunnelGroupElement : this._edgePathGroupElement;
        label.build(document, pathParent, this._edgePathHitTestGroupElement, this._edgeLabelGroupElement);
        if (label.hitTest) {
            this._focusable.set(label.hitTest, label);
        }
        if (label.labelElement) {
            if (label.label) {
                const metrics = textLayout.measureTextElement(label.labelElement, { text: label.label, font: EDGE_FONT });
                label.width = metrics.width;
                label.height = metrics.height;
            } else {
                const box = label.labelElement.getBBox();
                label.width = box.width;
                label.height = box.height;
            }
        }
        this._renderedEdges.add(edgeKey);
        return label;
    }

    _ensureEdgeElementBuildOnly(edge, document) {
        const label = edge.label;
        const edgeKey = `${edge.v}:${edge.w}`;
        if (label.element || !this._deferredEdgeBuild || !this._edgePathGroupElement || !this._edgePathHitTestGroupElement || !this._edgeLabelGroupElement) {
            return label;
        }
        const pathParent = label._tunnel ? this._tunnelGroupElement : this._edgePathGroupElement;
        label.build(document, pathParent, this._edgePathHitTestGroupElement, this._edgeLabelGroupElement);
        if (label.hitTest) {
            this._focusable.set(label.hitTest, label);
        }
        this._renderedEdges.add(edgeKey);
        return label;
    }

    isViewportCullingEnabled() {
        return this._viewportCulling;
    }

    setNode(node) {
        const key = node.name;
        const value = this._nodes.get(key);
        if (value) {
            value.label = node;
        } else {
            this._nodes.set(key, { v: key, label: node });
            if (this._compound) {
                this._parent.set(key, '\x00');
                this._children.set(key, new Map());
                this._children.get('\x00').set(key, true);
            }
        }
    }

    setEdge(edge) {
        if (!this._nodes.has(edge.v)) {
            throw new Error(`Invalid edge '${JSON.stringify(edge.v)}'.`);
        }
        if (!this._nodes.has(edge.w)) {
            throw new Error(`Invalid edge '${JSON.stringify(edge.w)}'.`);
        }
        const key = `${edge.v}:${edge.w}`;
        const entry = this._edges.get(key);
        if (entry) {
            entry.v = edge.v;
            entry.w = edge.w;
            entry.label = edge;
            return;
        }
        this._edges.set(key, { v: edge.v, w: edge.w, label: edge });
        // Maintain adjacency index for O(degree) edge lookup per node.
        if (!this._nodeEdges.has(edge.v)) {
            this._nodeEdges.set(edge.v, new Set());
        }
        this._nodeEdges.get(edge.v).add(key);
        if (!this._nodeEdges.has(edge.w)) {
            this._nodeEdges.set(edge.w, new Set());
        }
        this._nodeEdges.get(edge.w).add(key);
    }

    setParent(node, parent) {
        if (!this._compound) {
            throw new Error("Cannot set parent in a non-compound graph");
        }
        parent = String(parent);
        for (let ancestor = parent; ancestor; ancestor = this.parent(ancestor)) {
            if (ancestor === node) {
                throw new Error(`Setting ${parent} as parent of ${node} would create a cycle`);
            }
        }
        this._children.get(this._parent.get(node)).delete(node);
        this._parent.set(node, parent);
        this._children.get(parent).set(node, true);
        return this;
    }

    get nodes() {
        return this._nodes;
    }

    hasNode(key) {
        return this._nodes.has(key);
    }

    node(key) {
        return this._nodes.get(key);
    }

    edge(v, w) {
        return this._edges.get(`${v}:${w}`);
    }

    get edges() {
        return this._edges;
    }

    parent(key) {
        if (this._compound) {
            const parent = this._parent.get(key);
            if (parent !== '\x00') {
                return parent;
            }
        }
        return null;
    }

    children(key) {
        key = key === undefined ? '\x00' : key;
        if (this._compound) {
            const children = this._children.get(key);
            if (children) {
                return Array.from(children.keys());
            }
        } else if (key === '\x00') {
            return this.nodes.keys();
        } else if (this.hasNode(key)) {
            return [];
        }
        return null;
    }

    _showNode(node) {
        this._detachedElements.delete(node);
        this._pinnedElements.delete(node);
        if (!node.element) {
            return;
        }
        if (this._detachInvisible) {
            const parent = node._parentElement || this._nodeGroupElement;
            if (!node.element.parentNode && parent) {
                parent.appendChild(node.element);
            }
        } else {
            node.element.style.display = '';
        }
    }

    _hideNode(node) {
        if (!node.element) {
            return;
        }
        if (this._isPinned(node)) {
            this._pinnedElements.set(node, false);
            return;
        }
        this._pinnedElements.delete(node);
        if (this._detachInvisible) {
            if (node.element.parentNode) {
                node.element.parentNode.removeChild(node.element);
            }
            this._rememberDetached(node);
        } else {
            node.element.style.display = 'none';
        }
    }

    _showEdge(label) {
        this._detachedElements.delete(label);
        this._pinnedElements.delete(label);
        if (this._detachInvisible) {
            const pathParent = label._pathParentElement || this._edgePathGroupElement;
            const hitTestParent = label._hitTestParentElement || this._edgePathHitTestGroupElement;
            const labelParent = label._labelParentElement || this._edgeLabelGroupElement;
            if (label.element && !label.element.parentNode && pathParent) {
                pathParent.appendChild(label.element);
            }
            if (label.hitTest && !label.hitTest.parentNode && hitTestParent) {
                hitTestParent.appendChild(label.hitTest);
            }
            if (label.labelElement && !label.labelElement.parentNode && labelParent) {
                labelParent.appendChild(label.labelElement);
            }
        } else {
            if (label.element) {
                label.element.style.display = '';
            }
            if (label.hitTest) {
                label.hitTest.style.display = '';
            }
            if (label.labelElement) {
                label.labelElement.style.display = '';
            }
        }
    }

    _hideEdge(label) {
        if (this._isPinned(label)) {
            this._pinnedElements.set(label, true);
            return;
        }
        this._pinnedElements.delete(label);
        if (this._detachInvisible) {
            if (label.element && label.element.parentNode) {
                label.element.parentNode.removeChild(label.element);
            }
            if (label.hitTest && label.hitTest.parentNode) {
                label.hitTest.parentNode.removeChild(label.hitTest);
            }
            if (label.labelElement && label.labelElement.parentNode) {
                label.labelElement.parentNode.removeChild(label.labelElement);
            }
            this._rememberDetached(label);
        } else {
            if (label.element) {
                label.element.style.display = 'none';
            }
            if (label.hitTest) {
                label.hitTest.style.display = 'none';
            }
            if (label.labelElement) {
                label.labelElement.style.display = 'none';
            }
        }
    }

    _isPinned(label) {
        if (this._focused === label) {
            return true;
        }
        const active = this._document && this._document.activeElement;
        return [label.element, label.hitTest, label.labelElement].some((element) => element &&
            (element.classList.contains('select') || element.classList.contains('node-diff-selected') ||
                element.getElementsByClassName('select').length > 0 ||
                element.getElementsByClassName('node-diff-selected').length > 0 ||
                (active && element.contains(active))));
    }

    _rememberDetached(label) {
        if (!this._viewportCulling || !label.element ||
            !(label instanceof grapher.Node || label instanceof grapher.Edge)) {
            return;
        }
        this._detachedElements.delete(label);
        this._detachedElements.set(label, true);
        for (const candidate of this._detachedElements.keys()) {
            if (this._detachedElements.size <= this._detachedElementLimit) {
                break;
            }
            if (this._isPinned(candidate) || [candidate.element, candidate.hitTest, candidate.labelElement].some((element) => element && element.parentNode)) {
                continue;
            }
            this._detachedElements.delete(candidate);
            if (candidate instanceof grapher.Edge) {
                this._focusable.delete(candidate.hitTest);
                this._renderedEdges.delete(`${candidate.v}:${candidate.w}`);
            } else {
                this._renderedNodes.delete(candidate.name);
            }
            candidate.release();
        }
    }

    _buildVisibleNodes(nodeIds, document) {
        const CHUNK = 30;
        const version = this._visibilityVersion;
        const process = (ids, start = 0) => {
            if (version !== this._visibilityVersion) {
                return;
            }
            const batch = ids.slice(start, start + CHUNK);
            // Pass 1: Build/show DOM elements (writes only — no getBBox reads).
            const builtNodes = [];
            for (const nodeId of batch) {
                if (!this._visibleNodes || !this._visibleNodes.has(nodeId)) {
                    continue;
                }
                this._ensureNodeElement(nodeId, document, true);
                const entry = this.node(nodeId);
                if (!entry || !entry.label) {
                    continue;
                }
                const node = entry.label;
                if (node.element) {
                    this._showNode(node);
                    builtNodes.push({ nodeId, node });
                }
            }
            // Pass 2: Measure all built nodes (reads — batched getBBox calls).
            // Because no DOM writes occur between calls, the browser can batch
            // the layout calculation instead of reflowing per-node.
            for (const { node } of builtNodes) {
                if (!node._simplified && !node._geometryLocked) {
                    node.measure();
                }
            }
            // Pass 3: Layout and update (writes only).
            const builtNodeIds = new Set();
            for (const { nodeId, node } of builtNodes) {
                if (node._simplified) {
                    node.updateOverview();
                } else {
                    node.layout();
                    node.update();
                }
                node._needsUpdate = false;
                builtNodeIds.add(nodeId);
            }
            // Re-update edges connected to newly built nodes so that intersectRect
            // uses the actual node sizes rather than the estimated sizes that were
            // in effect when the edge was first rendered.
            // Uses adjacency index for O(degree) lookup instead of O(E) full scan.
            if (builtNodeIds.size > 0) {
                const visited = new Set();
                for (const nodeId of builtNodeIds) {
                    const edgeKeys = this._nodeEdges.get(nodeId);
                    if (!edgeKeys) {
                        continue;
                    }
                    for (const edgeKey of edgeKeys) {
                        if (visited.has(edgeKey)) {
                            continue;
                        }
                        visited.add(edgeKey);
                        const edge = this._edges.get(edgeKey);
                        if (edge && edge.label.element) {
                            edge.label.update();
                        }
                    }
                }
            }
            if (start + CHUNK < ids.length) {
                if (typeof requestIdleCallback === 'undefined') {
                    setTimeout(() => process(ids, start + CHUNK), 0);
                } else {
                    requestIdleCallback(() => process(ids, start + CHUNK), { timeout: 300 });
                }
            }
        };
        process(nodeIds);
    }

    _buildVisibleEdges(edgeKeys, document) {
        const CHUNK = 60;
        const version = this._visibilityVersion;
        const process = (keys, start = 0) => {
            if (version !== this._visibilityVersion) {
                return;
            }
            const batch = keys.slice(start, start + CHUNK);
            // Pass 1: Build edge DOM elements (writes only — no getBBox reads).
            const builtEdges = [];
            for (const edgeKey of batch) {
                if (!this._visibleEdges || !this._visibleEdges.has(edgeKey)) {
                    continue;
                }
                const edgeEntry = this._edges.get(edgeKey);
                if (!edgeEntry) {
                    continue;
                }
                const label = edgeEntry.label;
                const wasBuilt = Boolean(label.element);
                if (!label.element && this._deferredEdgeBuild) {
                    this._ensureEdgeElementBuildOnly(edgeEntry, document);
                }
                builtEdges.push({ label, wasBuilt });
            }
            // Pass 2: Measure all newly built edge labels (batched reads — estimate from text when possible).
            for (const { label } of builtEdges) {
                if (label.labelElement && label.width === undefined) {
                    if (label.label) {
                        const metrics = textLayout.measureTextElement(label.labelElement, { text: label.label, font: EDGE_FONT });
                        label.width = metrics.width;
                        label.height = metrics.height;
                    } else {
                        const box = label.labelElement.getBBox();
                        label.width = box.width;
                        label.height = box.height;
                    }
                }
            }
            // Pass 3: Show and update (writes only).
            for (const { label, wasBuilt } of builtEdges) {
                if (!wasBuilt && label.labelElement && (label.x === undefined || label.y === undefined) &&
                    Array.isArray(label.points) && label.points.length > 0) {
                    const midIndex = Math.floor((label.points.length - 1) / 2);
                    label.x = label.points[midIndex].x;
                    label.y = label.points[midIndex].y;
                }
                this._showEdge(label);
                if (label.element && this._skipHiddenUpdate && label._needsUpdate !== false) {
                    label.update();
                    label._needsUpdate = false;
                }
            }
            if (start + CHUNK < keys.length) {
                if (typeof requestIdleCallback === 'undefined') {
                    setTimeout(() => process(keys, start + CHUNK), 0);
                } else {
                    requestIdleCallback(() => process(keys, start + CHUNK), { timeout: 300 });
                }
            }
        };
        process(edgeKeys);
    }

    updateViewportVisibility(viewportBounds) {
        if (!this._viewportCulling || !this._tileManager) {
            return { addedNodes: new Set(), removedNodes: new Set(), addedEdges: new Set(), removedEdges: new Set() };
        }

        // At distant zoom, skip tiny node text while keeping geometry and hit targets.
        const overview = this.useEstimatedNodeSizes() && Number.isFinite(viewportBounds.zoom) && viewportBounds.zoom < 0.4;
        const detailChanged = overview !== this._overview;
        this._overview = overview;
        const { nodes: visibleNodes, edges: visibleEdges } = this._tileManager.queryViewport(viewportBounds, 1);

        // Locked geometry routes crossing edges without constructing distant endpoint UI.
        for (const edgeKey of visibleEdges) {
            const edgeEntry = this._edges.get(edgeKey);
            if (edgeEntry) {
                if (!edgeEntry.label.from?._geometryLocked) {
                    visibleNodes.add(edgeEntry.v);
                }
                if (!edgeEntry.label.to?._geometryLocked) {
                    visibleNodes.add(edgeEntry.w);
                }
            }
        }

        const previousNodes = this._visibleNodes || new Set();
        const previousEdges = this._visibleEdges || new Set();

        // Efficient set difference — avoids intermediate array allocation
        const addedNodes = new Set();
        for (const n of visibleNodes) {
            if (!previousNodes.has(n)) {
                addedNodes.add(n);
            }
        }
        const removedNodes = new Set();
        for (const n of previousNodes) {
            if (!visibleNodes.has(n)) {
                removedNodes.add(n);
            }
        }
        const addedEdges = new Set();
        for (const e of visibleEdges) {
            if (!previousEdges.has(e)) {
                addedEdges.add(e);
            }
        }
        const removedEdges = new Set();
        for (const e of previousEdges) {
            if (!visibleEdges.has(e)) {
                removedEdges.add(e);
            }
        }

        this._visibleNodes = visibleNodes;
        this._visibleEdges = visibleEdges;

        return { addedNodes, removedNodes, addedEdges, removedEdges, detailChanged };
    }

    updateVisibleElements(document, delta) {
        if (!this._viewportCulling || !this._visibleNodes || this._materializing) {
            return;
        }

        const nodeGroup = this._nodeGroupElement;
        if (!nodeGroup) {
            return;
        }

        for (const [label, edge] of this._pinnedElements) {
            if (edge) {
                this._hideEdge(label);
            } else {
                this._hideNode(label);
            }
        }

        // Fast path: use delta sets to only process nodes/edges that changed visibility.
        // This reduces per-scroll work from O(N) to O(delta).
        if (delta) {
            const { removedNodes, addedEdges, removedEdges } = delta;
            const addedNodes = delta.detailChanged ? this._visibleNodes : delta.addedNodes;

            // Hide nodes that left the viewport
            for (const nodeId of removedNodes) {
                const entry = this.node(nodeId);
                if (entry) {
                    this._hideNode(entry.label);
                }
            }

            // Show or build nodes that entered the viewport
            const newNodeIds = [];
            for (const nodeId of addedNodes) {
                const entry = this.node(nodeId);
                if (!entry) {
                    continue;
                }
                const node = entry.label;
                if (node.element && Boolean(node._simplified) === Boolean(this._useOverview(node))) {
                    this._showNode(node);
                    if (this._isLeafNode(nodeId) && this._skipHiddenUpdate && node._needsUpdate !== false) {
                        if (node._simplified) {
                            node.updateOverview();
                        } else {
                            node.update();
                        }
                        node._needsUpdate = false;
                    }
                    this._renderedNodes.add(nodeId);
                } else if (this._isLeafNode(nodeId)) {
                    newNodeIds.push(nodeId);
                }
            }
            if (newNodeIds.length > 0) {
                this._buildVisibleNodes(newNodeIds, document);
            }

            // Hide edges that left the viewport
            for (const edgeKey of removedEdges) {
                const edgeEntry = this._edges.get(edgeKey);
                if (edgeEntry) {
                    this._hideEdge(edgeEntry.label);
                }
            }

            // Show or build edges that entered the viewport
            if (addedEdges.size > 0) {
                this._buildVisibleEdges(Array.from(addedEdges), document);
            }
            return;
        }

        // Fallback: full scan used when no delta is available (e.g. first render).
        const newNodeIds = [];

        for (const nodeId of this.nodes.keys()) {
            const entry = this.node(nodeId);
            const node = entry.label;
            const isVisible = this._visibleNodes.has(nodeId);

            if (node.element && Boolean(node._simplified) === Boolean(this._useOverview(node))) {
                if (isVisible) {
                    this._showNode(node);
                    if (this._isLeafNode(nodeId) && this._skipHiddenUpdate && node._needsUpdate !== false) {
                        if (node._simplified) {
                            node.updateOverview();
                        } else {
                            node.update();
                        }
                        node._needsUpdate = false;
                    }
                    this._renderedNodes.add(nodeId);
                } else {
                    this._hideNode(node);
                }
            } else if (isVisible && this._isLeafNode(nodeId)) {
                newNodeIds.push(nodeId);
            } else if (node.element) {
                this._hideNode(node);
            }
        }

        // Build newly visible nodes in idle-time chunks to avoid jank
        if (newNodeIds.length > 0) {
            this._buildVisibleNodes(newNodeIds, document);
        }

        const newEdgeKeys = [];

        for (const edge of this.edges.values()) {
            const edgeKey = `${edge.v}:${edge.w}`;
            const isVisible = this._visibleEdges ? this._visibleEdges.has(edgeKey) : false;
            const label = edge.label;

            if (isVisible && !label.element && this._deferredEdgeBuild) {
                newEdgeKeys.push(edgeKey);
                continue;
            }
            if (isVisible) {
                this._showEdge(label);
                if (label.element && this._skipHiddenUpdate && label._needsUpdate !== false) {
                    label.update();
                    label._needsUpdate = false;
                }
            } else {
                this._hideEdge(label);
            }
        }

        if (newEdgeKeys.length > 0) {
            this._buildVisibleEdges(newEdgeKeys, document);
        }
    }

    hideAllNodes() {
        for (const nodeId of this.nodes.keys()) {
            const entry = this.node(nodeId);
            const node = entry.label;
            this._hideNode(node);
            // Mark as needing update so that when the node becomes visible
            // again, update() re-applies all SVG attributes.  Some browsers
            // do not correctly re-render detached-then-reattached SVG elements
            // without a fresh attribute write.
            node._needsUpdate = true;
        }
        for (const edge of this.edges.values()) {
            this._hideEdge(edge.label);
            edge.label._needsUpdate = true;
        }
    }

    markAllNeedsUpdate() {
        for (const entry of this.nodes.values()) {
            entry.label._needsUpdate = true;
        }
        for (const edge of this.edges.values()) {
            edge.label._needsUpdate = true;
        }
    }

    resetViewportVisibility() {
        this._visibilityVersion += 1;
        for (const nodeId of this._visibleNodes || []) {
            const entry = this.node(nodeId);
            if (entry) {
                this._hideNode(entry.label);
            }
        }
        for (const edgeKey of this._visibleEdges || []) {
            const entry = this._edges.get(edgeKey);
            if (entry) {
                this._hideEdge(entry.label);
            }
        }
        this._visibleNodes = new Set();
        this._visibleEdges = new Set();
    }

    async materializeAll(document) {
        // Export and accessibility consumers need a complete SVG even when the
        // interactive view only attaches elements intersecting the viewport.
        this._visibilityVersion += 1;
        this._materializing = (this._materializing || 0) + 1;
        let count = 0;
        try {
        /* eslint-disable no-await-in-loop */
            for (const nodeId of this.nodes.keys()) {
                const entry = this.node(nodeId);
                const node = this._ensureNodeElement(nodeId, document) || (entry && entry.label);
                if (!node || !node.element) {
                    continue;
                }
                this._showNode(node);
                if (this._isLeafNode(nodeId)) {
                    if (!node._geometryLocked) {
                        node.measure();
                    }
                    node.layout();
                    node.update();
                    node._needsUpdate = false;
                }
                if (++count % 250 === 0) {
                    await new Promise((resolve) => {
                        setTimeout(resolve, 0);
                    });
                }
            }
            for (const edge of this.edges.values()) {
                const label = this._ensureEdgeElement(edge, document);
                this._showEdge(label);
                if (label.element) {
                    label.update();
                    label._needsUpdate = false;
                }
                if (++count % 250 === 0) {
                    await new Promise((resolve) => {
                        setTimeout(resolve, 0);
                    });
                }
            }
        /* eslint-enable no-await-in-loop */
        } finally {
            this._materializing--;
        }
    }

    populateTiles() {
        if (!this._tileManager) {
            return;
        }

        this._tileManager.clear();

        // Add all nodes to tile manager
        for (const nodeId of this.nodes.keys()) {
            const entry = this.node(nodeId);
            const node = entry.label;
            if (node.x !== undefined && node.y !== undefined) {
                const bounds = {
                    x: node.x - (node.width || 0) / 2,
                    y: node.y - (node.height || 0) / 2,
                    width: node.width || 0,
                    height: node.height || 0
                };
                this._tileManager.addNode(nodeId, bounds);
            }
        }

        // Add all edges to tile manager
        for (const edge of this.edges.values()) {
            const edgeKey = `${edge.v}:${edge.w}`;
            const label = edge.label;
            if (label.points && label.points.length > 0) {
                const bounds = label.width && label.height && Number.isFinite(label.x) && Number.isFinite(label.y) ?
                    { x: label.x - label.width / 2, y: label.y - label.height / 2, width: label.width, height: label.height } : null;
                this._tileManager.addEdge(edgeKey, label.pathPoints, bounds);
            }
        }
    }

    build(document, originElement) {
        this._document = document;
        this._detachedElements.clear();
        this._pinnedElements.clear();

        const origin = originElement || document.getElementById('origin');

        const createGroup = (name) => {
            const element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            element.setAttribute('id', name);
            element.setAttribute('class', name);
            return element;
        };

        const clusterGroup = createGroup('clusters');
        const edgePathGroup = createGroup('edge-paths');
        const edgePathHitTestGroup = createGroup('edge-paths-hit-test');
        const edgeLabelGroup = createGroup('edge-labels');
        const nodeGroup = createGroup('nodes');
        // Tunnel edges (cross-subgraph connectors) render in a separate layer
        // so they appear behind regular edges and nodes.  Matches Netron's
        // tunnelGroup pattern.
        const tunnelGroup = createGroup('tunnel');
        this._nodeGroupElement = nodeGroup;
        this._edgePathGroupElement = edgePathGroup;
        this._edgePathHitTestGroupElement = edgePathHitTestGroup;
        this._edgeLabelGroupElement = edgeLabelGroup;
        this._tunnelGroupElement = tunnelGroup;

        const edgePathGroupDefs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
        edgePathGroup.appendChild(edgePathGroupDefs);
        const marker = (id) => {
            const element = document.createElementNS('http://www.w3.org/2000/svg', 'marker');
            element.setAttribute('id', id);
            element.setAttribute('viewBox', '0 0 10 10');
            element.setAttribute('refX', 9);
            element.setAttribute('refY', 5);
            element.setAttribute('markerUnits', 'strokeWidth');
            element.setAttribute('markerWidth', 8);
            element.setAttribute('markerHeight', 6);
            element.setAttribute('orient', 'auto');
            const markerPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            markerPath.setAttribute('d', 'M 0 0 L 10 5 L 0 10 L 4 5 z');
            markerPath.style.setProperty('stroke-width', 1);
            element.appendChild(markerPath);
            return element;
        };
        edgePathHitTestGroup.addEventListener('pointerover', (e) => {
            if (this._focused) {
                this._focused.blur();
                this._focused = null;
            }
            const edge = this._focusable.get(e.target);
            if (edge && edge.focus) {
                edge.focus();
                this._focused = edge;
                e.stopPropagation();
            }
        });
        edgePathHitTestGroup.addEventListener('pointerleave', (e) => {
            if (this._focused) {
                this._focused.blur();
                this._focused = null;
                e.stopPropagation();
            }
        });
        edgePathHitTestGroup.addEventListener('click', (e) => {
            const edge = this._focusable.get(e.target);
            if (edge && edge.activate) {
                edge.activate();
                e.stopPropagation();
            }
        });
        edgePathGroupDefs.appendChild(marker("arrowhead"));
        edgePathGroupDefs.appendChild(marker("arrowhead-select"));
        edgePathGroupDefs.appendChild(marker("arrowhead-hover"));

        const deferLeafNodeBuild = this._viewportCulling && this._deferredNodeBuild && this.useEstimatedNodeSizes();
        for (const nodeId of this.nodes.keys()) {
            const entry = this.node(nodeId);
            const node = entry.label;
            if (this._isLeafNode(nodeId)) {
                if (deferLeafNodeBuild) {
                    // Metadata supplies layout dimensions; SVG is needed only on visibility.
                    node.element = null;
                    node._simplified = true;
                } else {
                    node.build(document, nodeGroup);
                    this._renderedNodes.add(nodeId);
                }
            } else {
                // cluster
                node.rectangle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                if (node.rx) {
                    node.rectangle.setAttribute('rx', node.rx);
                }
                if (node.ry) {
                    node.rectangle.setAttribute('ry', node.ry);
                }
                node.element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                node.element.setAttribute('class', 'cluster');
                node.element.appendChild(node.rectangle);
                node._parentElement = clusterGroup;
                clusterGroup.appendChild(node.element);
                this._renderedNodes.add(nodeId);
            }
        }

        this._focusable.clear();
        this._focused = null;

        const deferEdgeBuild = this._viewportCulling && this._deferredEdgeBuild;

        for (const edge of this.edges.values()) {
            if (!deferEdgeBuild) {
                // Tunnel edges go into the dedicated tunnel SVG group so they
                // render behind regular edges and nodes.
                const pathGroup = edge.label._tunnel ? tunnelGroup : edgePathGroup;
                edge.label.build(document, pathGroup, edgePathHitTestGroup, edgeLabelGroup);
                if (edge.label.hitTest) {
                    this._focusable.set(edge.label.hitTest, edge.label);
                }
                this._renderedEdges.add(`${edge.v}:${edge.w}`);
            }
        }
        origin.appendChild(clusterGroup);
        origin.appendChild(tunnelGroup);
        origin.appendChild(edgePathGroup);
        origin.appendChild(edgePathHitTestGroup);
        // Edge labels render below nodes so that node rectangles always appear
        // above edge labels on dense layouts.
        origin.appendChild(edgeLabelGroup);
        origin.appendChild(nodeGroup);
    }

    async measure() {
        for (const edge of this.edges.values()) {
            const label = edge.label;
            if (!label.width) {
                if (label.label) {
                    const metrics = textLayout.measureTextElement(label.labelElement, { text: label.label, font: EDGE_FONT });
                    label.width = metrics.width;
                    label.height = metrics.height;
                } else if (label.labelElement) {
                    const box = label.labelElement.getBBox();
                    label.width = box.width;
                    label.height = box.height;
                }
            }
        }
        const useEstimatedNodeSizes = this.useEstimatedNodeSizes();
        for (const key of this.nodes.keys()) {
            const entry = this.node(key);
            if (this._isLeafNode(key)) {
                const node = entry.label;
                if (useEstimatedNodeSizes) {
                    // Blocks can measure from their stored text without SVG DOM.
                    // Lock these dimensions so materialization cannot invalidate
                    // global placement or edge routing later.
                    node.measure();
                    node._geometryLocked = true;
                    node._needsUpdate = true;
                } else {
                    node.measure();
                }
            }
        }
    }

    async layout(worker) {
        let nodes = [];
        for (const node of this.nodes.values()) {
            nodes.push({
                v: node.v,
                width: node.label.width || 0,
                height: node.label.height || 0,
                parent: this.parent(node.v) });
        }
        let edges = [];
        for (const edge of this.edges.values()) {
            edges.push({
                v: edge.v,
                w: edge.w,
                minlen: edge.label.minlen || 1,
                weight: edge.label.weight || 1,
                width: edge.label.width || 0,
                height: edge.label.height || 0,
                labeloffset: edge.label.labeloffset || 10,
                labelpos: edge.label.labelpos || 'r'
            });
        }
        const layout = {};
        layout.nodesep = 20;
        layout.ranksep = 20;
        const direction = this.options.direction;
        const rotate = edges.length === 0 ? direction === 'vertical' : direction !== 'vertical';
        if (rotate) {
            layout.rankdir = 'LR';
        }
        if (edges.length === 0) {
            nodes.reverse(); // rankdir workaround — in-place to avoid array copy
        }
        if (nodes.length > 3000) {
            layout.ranker = 'longest-path';
        }
        const state = { /* log: true */ };
        const useForce = this.options && this.options.layout === 'force';
        const useElk = this.options && this.options.layout === 'elk';
        const nodeCount = nodes.length;
        const edgeCount = edges.length;
        const edgeDensity = edgeCount / Math.max(1, nodeCount);
        // Keep Dagre for medium-size sparse graphs where it materially improves
        // placement, but keep the fast fallback for huge or dense graphs so
        // loading performance does not regress.
        const FAST_LAYOUT_NODE_THRESHOLD = 9000;
        const FAST_LAYOUT_EDGE_DENSITY = 4;
        // The fast layout changes edge routing and visual emphasis, so it is
        // opt-in. Default rendering always preserves the structural layout.
        const allowFastLayout = this.options && this.options.fastLayout === true;
        const preferFastLayout = allowFastLayout && (nodeCount > FAST_LAYOUT_NODE_THRESHOLD || edgeDensity > FAST_LAYOUT_EDGE_DENSITY);
        // Widen spacing only when using the fast fallback so long edges have
        // room to route between nodes rather than converging into a dense band.
        if (preferFastLayout) {
            layout.nodesep = 40;
            layout.ranksep = 40;
        }
        if (useForce) {
            if (worker) {
                try {
                    const timeoutMs = Math.max(20000, Math.min(60000, (nodeCount * 10) + (edgeCount * 2)));
                    const message = await worker.request({ type: 'force.layout', nodes, edges }, timeoutMs, 'Force graph layout in progress...');
                    if (message.type === 'cancel' || message.type === 'terminate') {
                        return message.type;
                    }
                    if (message.type === 'error') {
                        throw new Error(message.message);
                    }
                    nodes = message.nodes;
                    edges = message.edges;
                } catch {
                    await force.layoutAsync(nodes, edges);
                }
            } else {
                await force.layoutAsync(nodes, edges);
            }
        } else if (useElk && worker) {
            // Opt-4: ELK layered layout via worker. Falls back to dagre on error.
            try {
                const timeoutMs = Math.max(20000, Math.min(60000, (nodeCount * 10) + (edgeCount * 2)));
                const message = await worker.request({ type: 'elk.layout', nodes, edges, layout, state }, timeoutMs, 'ELK graph layout in progress...');
                if (message.type === 'cancel' || message.type === 'terminate') {
                    return message.type;
                }
                nodes = message.nodes;
                edges = message.edges;
            } catch {
                if (allowFastLayout && (preferFastLayout || nodeCount > this._mainThreadLayoutThreshold || edgeDensity > 3)) {
                    this._fastLayout(nodes, edges, rotate, layout);
                } else {
                    const dagre = await import('./dagre.js');
                    dagre.layout(nodes, edges, layout, state);
                }
            }
        } else if (!useForce && !useElk && !worker && preferFastLayout) {
            this._fastLayout(nodes, edges, rotate, layout);
        } else if (worker) {
            if (preferFastLayout) {
                this._fastLayout(nodes, edges, rotate, layout);
            } else {
                try {
                    const timeoutMs = Math.max(20000, Math.min(60000, (nodeCount * 10) + (edgeCount * 2)));
                    const message = await worker.request({ type: 'dagre.layout', nodes, edges, layout, state }, timeoutMs, 'This large graph layout might take a very long time to complete.');
                    if (message.type === 'cancel' || message.type === 'terminate') {
                        return message.type;
                    }
                    if (message.type === 'error') {
                        throw new Error(message.message);
                    }
                    nodes = message.nodes;
                    edges = message.edges;
                    state.log = message.state && message.state.log;
                } catch (error) {
                    // eslint-disable-next-line no-console
                    console.warn(`Worker dagre layout failed, falling back to main thread: ${error && error.message}`);
                    // Preserve responsiveness when the worker is unavailable or
                    // Dagre fails on graphs large enough to threaten interactivity.
                    if (allowFastLayout && (preferFastLayout || nodeCount > this._mainThreadLayoutThreshold || edgeDensity > 3)) {
                        this._fastLayout(nodes, edges, rotate, layout);
                    } else {
                        const dagre = await import('./dagre.js');
                        dagre.layout(nodes, edges, layout, state);
                    }
                }
            }
        } else if (allowFastLayout && nodes.length > this._mainThreadLayoutThreshold) {
            this._fastLayout(nodes, edges, rotate, layout);
        } else {
            const dagre = await import('./dagre.js');
            dagre.layout(nodes, edges, layout, state);
        }
        if (state.log) {
            const fs = await import('fs');
            fs.writeFileSync(`dist/test/${this.identifier}.log`, state.log);
        }
        let boundsMinX = Infinity;
        let boundsMinY = Infinity;
        let boundsMaxX = -Infinity;
        let boundsMaxY = -Infinity;
        for (const node of nodes) {
            const entry = this.node(node.v);
            if (!entry || !entry.label) {
                continue;
            }
            const label = entry.label;
            label.x = node.x;
            label.y = node.y;
            if (this.children(node.v).length) {
                label.width = node.width;
                label.height = node.height;
            }
            const hw = (label.width || 0) / 2;
            const hh = (label.height || 0) / 2;
            boundsMinX = Math.min(boundsMinX, node.x - hw);
            boundsMinY = Math.min(boundsMinY, node.y - hh);
            boundsMaxX = Math.max(boundsMaxX, node.x + hw);
            boundsMaxY = Math.max(boundsMaxY, node.y + hh);
        }
        this._layoutBounds = isFinite(boundsMinX) ? { x: boundsMinX, y: boundsMinY, width: boundsMaxX - boundsMinX, height: boundsMaxY - boundsMinY } : null;
        for (const edge of edges) {
            const entry = this.edge(edge.v, edge.w);
            if (!entry || !entry.label) {
                continue;
            }
            const label = entry.label;
            label.points = edge.points;
            if ('x' in edge) {
                label.x = edge.x;
                label.y = edge.y;
            }
            // Transfer per-edge visual overrides set by _fastLayout so that
            // Edge.update() can apply them as SVG attributes.
            if (edge._strokeOpacity === undefined) {
                delete label._strokeOpacity;
            } else {
                label._strokeOpacity = edge._strokeOpacity;
            }
            if (edge._strokeWidth === undefined) {
                delete label._strokeWidth;
            } else {
                label._strokeWidth = edge._strokeWidth;
            }
            if (edge._pathStyle === undefined) {
                delete label._pathStyle;
            } else {
                label._pathStyle = edge._pathStyle;
            }
        }
        for (const key of this.nodes.keys()) {
            const entry = this.node(key);
            if (this.children(key).length === 0) {
                const node = entry.label;
                node.layout();
            }
        }
        return '';
    }

    compactLayout() {
        let count = 0;
        for (const { label } of this.edges.values()) {
            if (label instanceof grapher.Edge) {
                count += (label.points?.length || 0) * 2;
            }
        }
        const coordinates = new Float64Array(count);
        let offset = 0;
        for (const { label } of this.edges.values()) {
            if (label instanceof grapher.Edge) {
                offset = label.packPoints(coordinates, offset);
            }
        }
    }

    // Opt-1: Snapshot current node positions + edge routing for IndexedDB caching.
    getLayoutSnapshot() {
        const nodes = [];
        for (const node of this.nodes.values()) {
            const label = node.label;
            if (label && typeof label.x === 'number') {
                nodes.push({ v: node.v, x: label.x, y: label.y, width: label.width || 0, height: label.height || 0 });
            }
        }
        const edges = [];
        for (const edge of this.edges.values()) {
            const label = edge.label;
            if (label) {
                const e = {
                    v: edge.v,
                    w: edge.w,
                    width: label.width || 0,
                    height: label.height || 0,
                    points: label.points || []
                };
                if (typeof label.x === 'number') {
                    e.x = label.x;
                    e.y = label.y;
                }
                edges.push(e);
            }
        }
        return { nodes, edges, bounds: this._layoutBounds || null };
    }

    // Opt-1: Apply cached node positions + edge routing, bypassing measure()+layout().
    applyLayout(cachedNodes, cachedEdges, cachedBounds) {
        if (!Array.isArray(cachedNodes) || !Array.isArray(cachedEdges) ||
            cachedNodes.length !== this.nodes.size || cachedEdges.length !== this.edges.size) {
            return false;
        }
        const nodeIds = new Set();
        for (const node of cachedNodes) {
            const entry = node ? this.node(node.v) : null;
            const current = entry && entry.label;
            const leaf = node && this._isLeafNode(node.v);
            const geometryChanged = leaf && current && Number.isFinite(current.width) && Number.isFinite(current.height) &&
                (Math.abs(current.width - node.width) > 0.5 || Math.abs(current.height - node.height) > 0.5);
            if (!node || !entry || nodeIds.has(node.v) || geometryChanged ||
                !Number.isFinite(node.x) || !Number.isFinite(node.y) ||
                !Number.isFinite(node.width) || !Number.isFinite(node.height) ||
                node.width < 0 || node.height < 0) {
                return false;
            }
            nodeIds.add(node.v);
        }
        const edgeIds = new Set();
        for (const edge of cachedEdges) {
            const key = edge ? `${edge.v}:${edge.w}` : '';
            const entry = edge ? this.edge(edge.v, edge.w) : null;
            const current = entry && entry.label;
            const geometryChanged = current && Number.isFinite(current.width) && Number.isFinite(current.height) &&
                (Math.abs(current.width - edge.width) > 0.5 || Math.abs(current.height - edge.height) > 0.5);
            if (!edge || !entry || edgeIds.has(key) || geometryChanged ||
                !Number.isFinite(edge.width) || !Number.isFinite(edge.height) || edge.width < 0 || edge.height < 0 || !Array.isArray(edge.points) ||
                edge.points.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) ||
                ('x' in edge && (!Number.isFinite(edge.x) || !Number.isFinite(edge.y)))) {
                return false;
            }
            edgeIds.add(key);
        }
        if (!cachedBounds || !Number.isFinite(cachedBounds.x) || !Number.isFinite(cachedBounds.y) ||
            !Number.isFinite(cachedBounds.width) || !Number.isFinite(cachedBounds.height) ||
            cachedBounds.width < 0 || cachedBounds.height < 0) {
            return false;
        }
        for (const n of cachedNodes) {
            const entry = this.node(n.v);
            if (!entry || !entry.label) {
                continue;
            }
            const label = entry.label;
            label.x = n.x;
            label.y = n.y;
            label.width = n.width;
            label.height = n.height;
        }
        for (const e of cachedEdges) {
            const entry = this.edge(e.v, e.w);
            if (!entry || !entry.label) {
                continue;
            }
            const label = entry.label;
            label.points = e.points;
            if ('x' in e) {
                label.x = e.x;
                label.y = e.y;
            }
        }
        for (const key of this.nodes.keys()) {
            const entry = this.node(key);
            if (this.children(key).length === 0) {
                entry.label.layout();
            }
        }
        this._layoutBounds = cachedBounds;
        return true;
    }

    _fastLayout(nodes, edges, rotate, layout) {
        const nodeMap = new Map();
        const outgoing = new Map();
        const indegree = new Map();
        for (const node of nodes) {
            nodeMap.set(node.v, node);
            outgoing.set(node.v, []);
            indegree.set(node.v, 0);
        }
        // Build edge minlen lookup for rank enforcement
        const edgeMinlen = new Map();
        for (const edge of edges) {
            if (!nodeMap.has(edge.v) || !nodeMap.has(edge.w)) {
                continue;
            }
            outgoing.get(edge.v).push(edge.w);
            indegree.set(edge.w, indegree.get(edge.w) + 1);
            // Store the maximum minlen for each v→w pair
            const key = `${edge.v}\x00${edge.w}`;
            const ml = edge.minlen || 1;
            if (!edgeMinlen.has(key) || edgeMinlen.get(key) < ml) {
                edgeMinlen.set(key, ml);
            }
        }

        const queue = [];
        const level = new Map();
        for (const [nodeId, degree] of indegree.entries()) {
            if (degree === 0) {
                queue.push(nodeId);
                level.set(nodeId, 0);
            }
        }
        // Index cursor instead of queue.shift(), which is O(n) per call.
        for (let head = 0; head < queue.length; head++) {
            const nodeId = queue[head];
            const base = level.get(nodeId) || 0;
            const children = outgoing.get(nodeId) || [];
            for (const childId of children) {
                const ml = edgeMinlen.get(`${nodeId}\x00${childId}`) || 1;
                const next = base + ml;
                const current = level.has(childId) ? level.get(childId) : -1;
                if (next > current) {
                    level.set(childId, next);
                }
                const nextDegree = indegree.get(childId) - 1;
                indegree.set(childId, nextDegree);
                if (nextDegree === 0) {
                    queue.push(childId);
                }
            }
        }
        for (const node of nodes) {
            if (!level.has(node.v)) {
                level.set(node.v, 0);
            }
        }

        const ranks = new Map();
        for (const node of nodes) {
            const rank = level.get(node.v) || 0;
            if (!ranks.has(rank)) {
                ranks.set(rank, []);
            }
            ranks.get(rank).push(node);
        }
        const rankKeys = Array.from(ranks.keys()).sort((a, b) => a - b);
        // Initial order: sort by node id as a stable baseline.
        for (const rank of rankKeys) {
            ranks.get(rank).sort((a, b) => String(a.v).localeCompare(String(b.v)));
        }
        // Barycenter crossing minimization: for each rank, order nodes by the
        // average position of their neighbors in the adjacent rank.  Forward
        // and backward sweeps are interleaved.  This is O(N+E) per sweep.
        const incoming = new Map();
        for (const node of nodes) {
            incoming.set(node.v, []);
        }
        for (const edge of edges) {
            if (incoming.has(edge.w) && nodeMap.has(edge.v)) {
                incoming.get(edge.w).push(edge.v);
            }
        }
        const SWEEPS = 12;
        for (let sweep = 0; sweep < SWEEPS; sweep++) {
            const keys = sweep % 2 === 0 ? rankKeys : [...rankKeys].reverse();
            for (let ri = 1; ri < keys.length; ri++) {
                const rank = keys[ri];
                const prevRank = keys[ri - 1];
                const prevPositions = new Map();
                const prevNodes = ranks.get(prevRank);
                for (let i = 0; i < prevNodes.length; i++) {
                    prevPositions.set(prevNodes[i].v, i);
                }
                const rankNodes = ranks.get(rank);
                for (const node of rankNodes) {
                    const neighbors = sweep % 2 === 0 ? incoming.get(node.v) : (outgoing.get(node.v) || []);
                    const relevant = neighbors.filter((id) => prevPositions.has(id));
                    if (relevant.length > 0) {
                        let sum = 0;
                        for (const id of relevant) {
                            sum += prevPositions.get(id);
                        }
                        node._bary = sum / relevant.length;
                    } else {
                        node._bary = Infinity;
                    }
                }
                rankNodes.sort((a, b) => a._bary - b._bary);
            }
        }

        const nodeSep = Number.isFinite(layout.nodesep) ? layout.nodesep : 20;
        const rankSep = Number.isFinite(layout.ranksep) ? layout.ranksep : 20;
        const secondarySpan = (node) => rotate ? Math.max(1, node.height || 0) : Math.max(1, node.width || 0);
        const primarySpan = (node) => rotate ? Math.max(1, node.width || 0) : Math.max(1, node.height || 0);
        const rankNodeSep = new Map();
        const rankPrimarySpan = new Map();
        const placeRank = (rankNodes, desired) => {
            const previous = new Map(rankNodes.map((node) => [node.v, Number.isFinite(node._secondary) ? node._secondary : 0]));
            rankNodes.sort((a, b) => {
                const ad = desired.get(a.v);
                const bd = desired.get(b.v);
                const af = Number.isFinite(ad);
                const bf = Number.isFinite(bd);
                if (af && bf && ad !== bd) {
                    return ad - bd;
                }
                if (af !== bf) {
                    return af ? -1 : 1;
                }
                return (previous.get(a.v) || 0) - (previous.get(b.v) || 0);
            });
            const separation = rankNodeSep.get(level.get(rankNodes[0].v) || 0) || nodeSep;
            let cursor = null;
            for (const node of rankNodes) {
                const half = secondarySpan(node) / 2;
                let center = desired.get(node.v);
                if (!Number.isFinite(center)) {
                    center = cursor === null ? half : cursor + separation + half;
                }
                if (cursor !== null) {
                    center = Math.max(center, cursor + separation + half);
                }
                node._secondary = center;
                cursor = center + half;
            }
            const targetCenters = [];
            for (const node of rankNodes) {
                const value = desired.get(node.v);
                if (Number.isFinite(value)) {
                    targetCenters.push(value);
                }
            }
            const reference = targetCenters.length > 0
                ? targetCenters.reduce((sum, value) => sum + value, 0) / targetCenters.length
                : rankNodes.reduce((sum, node) => sum + (previous.get(node.v) || 0), 0) / Math.max(1, rankNodes.length);
            const current = rankNodes.reduce((sum, node) => sum + node._secondary, 0) / Math.max(1, rankNodes.length);
            const shift = reference - current;
            for (const node of rankNodes) {
                node._secondary += shift;
            }
        };
        const desiredFromNeighbors = (rankNodes, neighbors) => {
            const desired = new Map();
            for (const node of rankNodes) {
                const ids = neighbors.get(node.v) || [];
                let total = 0;
                let count = 0;
                for (const id of ids) {
                    const other = nodeMap.get(id);
                    if (other && Number.isFinite(other._secondary)) {
                        total += other._secondary;
                        count++;
                    }
                }
                if (count > 0) {
                    const anchor = Number.isFinite(node._secondary) ? node._secondary : (total / count);
                    desired.set(node.v, ((total / count) * 0.85) + (anchor * 0.15));
                }
            }
            return desired;
        };
        for (const rank of rankKeys) {
            const rankNodes = ranks.get(rank);
            rankPrimarySpan.set(rank, rankNodes.reduce((max, node) => Math.max(max, primarySpan(node)), 0));
            rankNodeSep.set(rank, nodeSep + Math.min(28, Math.max(0, (Math.sqrt(rankNodes.length) - 2) * 6)));
            let cursor = 0;
            for (const node of rankNodes) {
                const half = secondarySpan(node) / 2;
                node._secondary = cursor + half;
                cursor += (half * 2) + rankNodeSep.get(rank);
            }
            const mean = rankNodes.reduce((sum, node) => sum + node._secondary, 0) / Math.max(1, rankNodes.length);
            for (const node of rankNodes) {
                node._secondary -= mean;
            }
        }
        for (let sweep = 0; sweep < 6; sweep++) {
            for (let index = 1; index < rankKeys.length; index++) {
                const rank = rankKeys[index];
                placeRank(ranks.get(rank), desiredFromNeighbors(ranks.get(rank), incoming));
            }
            for (let index = rankKeys.length - 2; index >= 0; index--) {
                const rank = rankKeys[index];
                placeRank(ranks.get(rank), desiredFromNeighbors(ranks.get(rank), outgoing));
            }
        }
        let primary = 0;
        for (const rank of rankKeys) {
            const rankNodes = ranks.get(rank);
            for (const node of rankNodes) {
                if (rotate) {
                    node.x = primary + (primarySpan(node) / 2);
                    node.y = node._secondary;
                } else {
                    node.x = node._secondary;
                    node.y = primary + (primarySpan(node) / 2);
                }
            }
            primary += (rankPrimarySpan.get(rank) || 0) + rankSep;
        }

        // Record the primary-axis start of each rank so we can route edges
        // through inter-rank gaps rather than node centers.
        const rankPrimaryStart = new Map(); // rank -> primary start position
        const rankPrimaryEnd = new Map();   // rank -> primary end position
        {
            let p = 0;
            for (const rank of rankKeys) {
                const maxSpan = rankPrimarySpan.get(rank) || 0;
                rankPrimaryStart.set(rank, p);
                rankPrimaryEnd.set(rank, p + maxSpan);
                p += maxSpan + rankSep;
            }
        }

        // Build per-node edge index to detect parallel edges sharing endpoints.
        const nodeOutEdges = new Map();
        for (const edge of edges) {
            if (!nodeMap.has(edge.v) || !nodeMap.has(edge.w)) {
                continue;
            }
            if (!nodeOutEdges.has(edge.v)) {
                nodeOutEdges.set(edge.v, []);
            }
            nodeOutEdges.get(edge.v).push(edge);
        }
        const edgePairIndex = new Map();
        for (const edgeList of nodeOutEdges.values()) {
            const byTarget = new Map();
            for (const edge of edgeList) {
                if (!byTarget.has(edge.w)) {
                    byTarget.set(edge.w, []);
                }
                byTarget.get(edge.w).push(edge);
            }
            for (const [, group] of byTarget) {
                for (let i = 0; i < group.length; i++) {
                    edgePairIndex.set(`${group[i].v}\x00${group[i].w}`, { index: i, total: group.length });
                }
            }
        }

        // Build per-rank node list for lightweight node-crossing detection.
        const nodesByRank = new Map();
        for (const node of nodes) {
            const r = level.get(node.v) || 0;
            if (!nodesByRank.has(r)) {
                nodesByRank.set(r, []);
            }
            nodesByRank.get(r).push(node);
        }

        for (const edge of edges) {
            const source = nodeMap.get(edge.v);
            const target = nodeMap.get(edge.w);
            if (!source || !target) {
                continue;
            }
            const srcRank = level.get(edge.v) || 0;
            const tgtRank = level.get(edge.w) || 0;
            const rankDiff = Math.abs(tgtRank - srcRank);

            // Subtle lateral offset for parallel edges (same v→w pair).
            const pairInfo = edgePairIndex.get(`${edge.v}\x00${edge.w}`);
            let lateralOff = 0;
            if (pairInfo && pairInfo.total > 1) {
                lateralOff = (pairInfo.index - (pairInfo.total - 1) / 2) * 3;
            }

            if (rankDiff <= 1) {
                // Adjacent or same-rank: clean 3-point straight path.
                const mx = (source.x + target.x) / 2;
                const my = (source.y + target.y) / 2;
                if (lateralOff === 0) {
                    edge.points = [
                        { x: source.x, y: source.y },
                        { x: mx, y: my },
                        { x: target.x, y: target.y }
                    ];
                } else {
                    const dx = target.x - source.x;
                    const dy = target.y - source.y;
                    const len = Math.sqrt(dx * dx + dy * dy) || 1;
                    const px = -dy / len;
                    const py = dx / len;
                    edge.points = [
                        { x: source.x, y: source.y },
                        { x: mx + px * lateralOff, y: my + py * lateralOff },
                        { x: target.x, y: target.y }
                    ];
                }
            } else {
                // Multi-rank edge: route through each inter-rank gap so long
                // edges stay distributed across the graph instead of converging
                // toward a shared midpoint band.
                const lo = Math.min(srcRank, tgtRank);
                const hi = Math.max(srcRank, tgtRank);
                const sP = rotate ? source.x : source.y;
                const tP = rotate ? target.x : target.y;
                const sS = rotate ? source.y : source.x;
                const tS = rotate ? target.y : target.x;
                const points = [{ x: source.x, y: source.y }];
                for (let r = lo + 1; r < hi; r++) {
                    const t = (r - lo) / (hi - lo);
                    const endPrev = rankPrimaryEnd.get(r - 1);
                    const startCur = rankPrimaryStart.get(r);
                    const gapPrimary = endPrev !== undefined && startCur !== undefined
                        ? (endPrev + startCur) / 2
                        : sP + ((tP - sP) * t);
                    const interpSecondary = sS + ((tS - sS) * t) + lateralOff;
                    if (rotate) {
                        points.push({ x: gapPrimary, y: interpSecondary });
                    } else {
                        points.push({ x: interpSecondary, y: gapPrimary });
                    }
                }
                points.push({ x: target.x, y: target.y });
                if (points.length < 3) {
                    const mx = (source.x + target.x) / 2;
                    const my = (source.y + target.y) / 2;
                    points.splice(1, 0, { x: mx, y: my });
                }
                edge.points = points;
                for (let pointIndex = 1; pointIndex < edge.points.length - 1; pointIndex++) {
                    const point = edge.points[pointIndex];
                    const pointRank = lo + pointIndex;
                    const rankList = nodesByRank.get(pointRank);
                    if (!rankList) {
                        continue;
                    }
                    for (const node of rankList) {
                        if (node.v === edge.v || node.v === edge.w) {
                            continue;
                        }
                        const halfWidth = (node.width || 0) / 2 + 4;
                        const halfHeight = (node.height || 0) / 2 + 4;
                        if (point.x > node.x - halfWidth && point.x < node.x + halfWidth &&
                            point.y > node.y - halfHeight && point.y < node.y + halfHeight) {
                            if (rotate) {
                                const distTop = Math.abs(point.y - (node.y - halfHeight));
                                const distBottom = Math.abs(point.y - (node.y + halfHeight));
                                point.y = distTop < distBottom ? node.y - halfHeight - 2 : node.y + halfHeight + 2;
                            } else {
                                const distLeft = Math.abs(point.x - (node.x - halfWidth));
                                const distRight = Math.abs(point.x - (node.x + halfWidth));
                                point.x = distLeft < distRight ? node.x - halfWidth - 2 : node.x + halfWidth + 2;
                            }
                        }
                    }
                }
            }
            if (edge.width || edge.height) {
                const mid = edge.points[Math.floor(edge.points.length / 2)];
                edge.x = mid.x;
                edge.y = mid.y;
            }
            // Scale stroke opacity and width by rank distance so long-distance
            // edges fade into the background while adjacent-rank edges (the
            // structurally important ones) stay fully visible.  This prevents
            // thousands of overlapping long-distance edges from forming an
            // opaque black mass at the center of the graph.
            if (rankDiff > 1) {
                if (rankDiff <= 3) {
                    edge._strokeOpacity = 0.55;
                } else if (rankDiff <= 8) {
                    edge._strokeOpacity = 0.35;
                } else {
                    edge._strokeOpacity = 0.25;
                }
                edge._strokeWidth = 0.5;
            }
        }
    }

    update() {
        const restrictToVisible = this._viewportCulling && this._skipHiddenUpdate && this._visibleNodes instanceof Set;
        for (const nodeId of this.nodes.keys()) {
            if (this._isLeafNode(nodeId)) {
                const entry = this.node(nodeId);
                if (!entry || !entry.label) {
                    continue;
                }
                const node = entry.label;
                const shouldUpdate = !restrictToVisible || this._visibleNodes.has(nodeId);
                if (node.element && shouldUpdate) {
                    if (node._simplified) {
                        node.updateOverview();
                        node._needsUpdate = false;
                    } else {
                        node.update();
                        node._needsUpdate = false;
                    }
                } else if (!shouldUpdate) {
                    node._needsUpdate = true;
                }
            } else {
                // cluster
                const entry = this.node(nodeId);
                if (!entry || !entry.label) {
                    continue;
                }
                const node = entry.label;
                node.element.setAttribute('transform', `translate(${node.x},${node.y})`);
                node.rectangle.setAttribute('x', - node.width / 2);
                node.rectangle.setAttribute('y', - node.height / 2);
                node.rectangle.setAttribute('width', node.width);
                node.rectangle.setAttribute('height', node.height);
            }
        }
        const restrictEdgesToVisible = this._viewportCulling && this._skipHiddenUpdate && this._visibleEdges instanceof Set;
        for (const edge of this.edges.values()) {
            const edgeKey = `${edge.v}:${edge.w}`;
            const shouldUpdate = !restrictEdgesToVisible || this._visibleEdges.has(edgeKey);
            if (edge.label.element && shouldUpdate) {
                edge.label.update();
                edge.label._needsUpdate = false;
            } else if (!shouldUpdate) {
                edge.label._needsUpdate = true;
            }
        }
    }
};

grapher.Node = class {

    constructor() {
        this._blocks = [];
    }

    header() {
        const block = new grapher.Node.Header();
        this._blocks.push(block);
        return block;
    }

    list() {
        const block = new grapher.ArgumentList();
        this._blocks.push(block);
        return block;
    }

    canvas() {
        const block = new grapher.Node.Canvas();
        this._blocks.push(block);
        return block;
    }

    build(document, parent) {
        this.element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        if (this.id) {
            this.element.setAttribute('id', this.id);
        }
        this.element.setAttribute('class', this.class ? `node ${this.class}` : 'node');
        if (this._diffClass) {
            this.element.classList.add(this._diffClass);
        }
        this.element.style.opacity = 0;
        this._parentElement = parent;
        parent.appendChild(this.element);
        this.border = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        this.border.setAttribute('class', 'node node-border');
        for (let i = 0; i < this._blocks.length; i++) {
            const block = this._blocks[i];
            block.first = i === 0;
            block.last = i === this._blocks.length - 1;
            block.build(document, this.element);
        }
        this.element.appendChild(this.border);
    }

    release() {
        for (const block of this._blocks) {
            block.release();
        }
        this.element = null;
        this.border = null;
        this._parentElement = null;
        this._needsUpdate = true;
    }

    buildOverview(document, parent) {
        this.element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        if (this.id) {
            this.element.setAttribute('id', this.id);
        }
        this.element.setAttribute('class', `node node-overview ${this.class || ''} ${this._overviewClass || 'node-item-type'} ${this._diffClass || ''}`.trim());
        this.element.setAttribute('role', 'button');
        this.element.setAttribute('tabindex', '0');
        this.element.setAttribute('aria-label', this._overviewLabel);
        this.element.addEventListener('click', (event) => {
            event.stopPropagation();
            this.activateOverview();
        });
        this.element.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                event.stopPropagation();
                this.activateOverview();
            }
        });
        this.border = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        this.border.setAttribute('class', 'node node-border');
        this.element.appendChild(this.border);
        this._parentElement = parent;
        parent.appendChild(this.element);
    }

    updateOverview() {
        this.border.setAttribute('d', grapher.Node.roundedRect(0, 0, this.width, this.height, true, true, true, true));
        this.element.setAttribute('transform', `translate(${grapher.Node.snap(this.x - this.width / 2)},${grapher.Node.snap(this.y - this.height / 2)})`);
        this.element.style.removeProperty('opacity');
    }

    measure() {
        this.height = 0;
        for (const block of this._blocks) {
            block.measure();
            this.height += block.height;
        }
        this.width = Math.max(...this._blocks.map((block) => block.width));
        for (const block of this._blocks) {
            block.width = this.width;
        }
    }

    layout() {
        let y = 0;
        for (const block of this._blocks) {
            block.x = 0;
            block.y = y;
            block.width = this.width;
            block.layout();
            y += block.height;
        }
    }

    update() {
        for (const block of this._blocks) {
            block.update();
        }
        this.border.setAttribute('d', grapher.Node.roundedRect(0, 0, this.width, this.height, true, true, true, true));
        const x = grapher.Node.snap(this.x - (this.width / 2));
        const y = grapher.Node.snap(this.y - (this.height / 2));
        this.element.setAttribute('transform', `translate(${x},${y})`);
        this.element.style.removeProperty('opacity');
    }

    select() {
        if (this.element) {
            this.element.classList.add('select');
            return [this.element];
        }
        return [];
    }

    deselect() {
        if (this.element) {
            this.element.classList.remove('select');
        }
    }

    static roundedRect(x, y, width, height, r1, r2, r3, r4) {
        const radius = 5;
        r1 = r1 ? radius : 0;
        r2 = r2 ? radius : 0;
        r3 = r3 ? radius : 0;
        r4 = r4 ? radius : 0;
        return `M${x + r1},${y}h${width - r1 - r2}a${r2},${r2} 0 0 1 ${r2},${r2}v${height - r2 - r3}a${r3},${r3} 0 0 1 ${-r3},${r3}h${r3 + r4 - width}a${r4},${r4} 0 0 1 ${-r4},${-r4}v${-height + r4 + r1}a${r1},${r1} 0 0 1 ${r1},${-r1}z`;
    }

    static snap(value) {
        return Math.round(Number.isFinite(value) ? value : 0);
    }
};

grapher.Node.Header = class {

    constructor() {
        this._entries = [];
    }

    add(id, classList, content, tooltip, handler) {
        const entry = new grapher.Node.Header.Entry(id, classList, content, tooltip, handler);
        this._entries.push(entry);
        return entry;
    }

    build(document, parent) {
        this._document = document;
        for (const entry of this._entries) {
            entry.build(document, parent);
        }
        if (!this.first) {
            this.line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            parent.appendChild(this.line);
        }
        for (let i = 0; i < this._entries.length; i++) {
            const entry = this._entries[i];
            if (i !== 0) {
                entry.line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                parent.appendChild(entry.line);
            }
        }
    }

    release() {
        for (const entry of this._entries) {
            entry.release();
        }
        this.line = null;
        this._document = null;
    }

    measure() {
        this.width = 0;
        this.height = 0;
        for (const entry of this._entries) {
            entry.measure();
            this.height = Math.max(this.height, entry.height);
            this.width += entry.width;
        }
    }

    layout() {
        let x = this.width;
        for (let i = this._entries.length - 1; i >= 0; i--) {
            const entry = this._entries[i];
            if (i > 0) {
                x -= entry.width;
                entry.x = x;
            } else {
                entry.x = 0;
                entry.width = x;
            }
        }
    }

    update() {
        for (let i = 0; i < this._entries.length; i++) {
            const entry = this._entries[i];
            entry.element.setAttribute('transform', `translate(${grapher.Node.snap(entry.x)},${grapher.Node.snap(this.y)})`);
            const r1 = i === 0 && this.first;
            const r2 = i === this._entries.length - 1 && this.first;
            const r3 = i === this._entries.length - 1 && this.last;
            const r4 = i === 0 && this.last;
            entry.path.setAttribute('d', grapher.Node.roundedRect(0, 0, entry.width, this.height, r1, r2, r3, r4));
            entry.text.setAttribute('x', grapher.Node.snap(entry.tx || 6));
            entry.text.setAttribute('y', grapher.Node.snap(entry.ty));
        }
        for (let i = 1; i < this._entries.length; i++) {
            const entry = this._entries[i];
            const line = entry.line;
            line.setAttribute('class', 'node');
            line.setAttribute('x1', grapher.Node.snap(entry.x));
            line.setAttribute('x2', grapher.Node.snap(entry.x));
            line.setAttribute('y1', grapher.Node.snap(this.y));
            line.setAttribute('y2', grapher.Node.snap(this.y + this.height));
        }
        if (this.line) {
            this.line.setAttribute('class', 'node');
            this.line.setAttribute('x1', 0);
            this.line.setAttribute('x2', grapher.Node.snap(this.width));
            this.line.setAttribute('y1', grapher.Node.snap(this.y));
            this.line.setAttribute('y2', grapher.Node.snap(this.y));
        }
    }
};

grapher.Node.Header.Entry = class {

    constructor(id, classList, content, tooltip, handler) {
        this.id = id;
        this.classList = classList;
        this.content = content;
        this.tooltip = tooltip;
        this.handler = handler;
        this._events = {};
    }

    on(event, callback) {
        this._events[event] = this._events[event] || [];
        this._events[event].push(callback);
    }

    emit(event, data) {
        if (this._events && this._events[event]) {
            for (const callback of this._events[event]) {
                callback(this, data);
            }
        }
    }

    build(document, parent) {
        this.element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        parent.appendChild(this.element);
        this.path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        this.text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        this.element.appendChild(this.path);
        this.element.appendChild(this.text);
        const classList = ['node-item'];
        if (this.classList) {
            classList.push(...this.classList);
        }
        this.element.setAttribute('class', classList.join(' '));
        if (this.id) {
            this.element.setAttribute('id', this.id);
        }
        if (this._events.click) {
            this.element.addEventListener('click', (e) => {
                e.stopPropagation();
                this.emit('click');
            });
        }
        if (this.tooltip) {
            const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            title.textContent = this.tooltip;
            this.element.appendChild(title);
        }
        this.text.textContent = this.content || '\u00A0';
    }

    release() {
        this.element = null;
        this.path = null;
        this.text = null;
        this.line = null;
    }

    measure() {
        const yPadding = 4;
        const xPadding = 7;
        const content = this.content || '\u00A0';
        const boundingBox = textLayout.measureTextElement(this.text, { text: content, font: NODE_FONT });
        this.width = boundingBox.width + xPadding + xPadding;
        this.height = boundingBox.height + yPadding + yPadding;
        this.tx = xPadding;
        this.ty = yPadding - boundingBox.y;
    }

    layout() {
    }
};

grapher.ArgumentList = class {

    constructor() {
        this._items = [];
        this._events = {};
    }

    argument(name, value) {
        return new grapher.Argument(name, value);
    }

    add(value) {
        this._items.push(value);
    }

    on(event, callback) {
        this._events[event] = this._events[event] || [];
        this._events[event].push(callback);
    }

    emit(event, data) {
        if (this._events && this._events[event]) {
            for (const callback of this._events[event]) {
                callback(this, data);
            }
        }
    }

    build(document, parent) {
        this._document = document;
        this.element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.element.setAttribute('class', 'node-argument-list');
        if (this._events.click) {
            this.element.addEventListener('click', (e) => {
                e.stopPropagation();
                this.emit('click');
            });
        }
        this.background = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        this.element.appendChild(this.background);
        parent.appendChild(this.element);
        for (const item of this._items) {
            item.build(document, this.element);
        }
        if (!this.first) {
            this.line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            this.line.setAttribute('class', 'node');
            this.element.appendChild(this.line);
        }
    }

    release() {
        for (const item of this._items) {
            item.release();
        }
        this.element = null;
        this.background = null;
        this.line = null;
        this._document = null;
    }

    measure() {
        this.width = 75;
        this.height = 3;
        for (let i = 0; i < this._items.length; i++) {
            const item = this._items[i];
            item.measure();
            this.height += item.height;
            this.width = Math.max(this.width, item.width);
            if (item.type === 'node' || item.type === 'node[]') {
                if (i === this._items.length - 1) {
                    this.height += 3;
                }
            }
        }
        for (const item of this._items) {
            item.width = this.width;
        }
        this.height += 3;
    }

    layout() {
        let y = 3;
        for (const item of this._items) {
            item.x = this.x;
            item.y = y;
            item.width = this.width;
            item.layout();
            y += item.height;
        }
    }

    update() {
        this.element.setAttribute('transform', `translate(${grapher.Node.snap(this.x)},${grapher.Node.snap(this.y)})`);
        this.background.setAttribute('d', grapher.Node.roundedRect(0, 0, this.width, this.height, this.first, this.first, this.last, this.last));
        for (const item of this._items) {
            item.update();
        }
        if (this.line) {
            this.line.setAttribute('x1', 0);
            this.line.setAttribute('x2', grapher.Node.snap(this.width));
            this.line.setAttribute('y1', 0);
            this.line.setAttribute('y2', 0);
        }
    }
};

grapher.Argument = class {

    constructor(name, content) {
        this.name = name;
        this.content = content;
        this.tooltip = '';
        this.separator = '';
        if (content instanceof grapher.Node) {
            this.type = 'node';
        } else if (Array.isArray(content) && content.every((value) => value instanceof grapher.Node)) {
            this.type = 'node[]';
        }
    }

    build(document, parent) {
        this.element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        this.element.setAttribute('class', 'node-argument');
        this.border = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        this.border.setAttribute('rx', 3);
        this.border.setAttribute('ry', 3);
        this.element.appendChild(this.border);
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        text.setAttribute('xml:space', 'preserve');
        if (this.tooltip) {
            const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
            title.textContent = this.tooltip;
            text.appendChild(title);
        }
        const colon = this.type === 'node' || this.type === 'node[]';
        const name = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
        name.textContent =  colon ? `${this.name}:` : this.name;
        if (this.separator.trim() !== '=' && !colon) {
            name.style.fontWeight = 'bold';
        }
        if (this.focus) {
            this.element.addEventListener('pointerover', (e) => {
                this.focus();
                e.stopPropagation();
            });
        }
        if (this.blur) {
            this.element.addEventListener('pointerleave', (e) => {
                this.blur();
                e.stopPropagation();
            });
        }
        if (this.activate) {
            this.element.addEventListener('click', (e) => {
                this.activate();
                e.stopPropagation();
            });
        }
        text.appendChild(name);
        this.element.appendChild(text);
        parent.appendChild(this.element);
        this.text = text;
        switch (this.type) {
            case 'node': {
                const node = this.content;
                node.build(document, this.element);
                break;
            }
            case 'node[]': {
                for (const node of this.content) {
                    node.build(document, this.element);
                }
                break;
            }
            default: {
                const tspan = document.createElementNS('http://www.w3.org/2000/svg', 'tspan');
                tspan.textContent = (this.separator || '') + this.content;
                this.text.appendChild(tspan);
                break;
            }
        }
    }

    release() {
        if (this.type === 'node') {
            this.content.release();
        } else if (this.type === 'node[]') {
            for (const node of this.content) {
                node.release();
            }
        }
        this.element = null;
        this.border = null;
        this.text = null;
    }

    measure() {
        const yPadding = 1;
        const xPadding = 6;
        let size = null;
        if (this.text) {
            size = textLayout.measureTextElement(this.text, { font: ARGUMENT_FONT });
        } else {
            const colon = this.type === 'node' || this.type === 'node[]';
            const name = colon ? `${this.name}:` : this.name;
            const bold = this.separator.trim() !== '=' && !colon;
            const nameMetrics = textLayout.measureTextElement(null, { text: name, font: bold ? `bold ${ARGUMENT_FONT}` : ARGUMENT_FONT });
            const content = this.content === undefined || this.content === null ? '' : this.content;
            const value = colon ? '' : `${this.separator || ''}${content}`;
            const valueMetrics = textLayout.measureTextElement(null, { text: value, font: ARGUMENT_FONT });
            size = {
                width: nameMetrics.width + valueMetrics.width,
                height: Math.max(nameMetrics.height, valueMetrics.height),
                y: Math.min(nameMetrics.y, valueMetrics.y)
            };
        }
        this.width = xPadding + size.width + xPadding;
        this.bottom = yPadding + size.height + yPadding;
        this.offset = size.y;
        this.height = this.bottom;
        if (this.type === 'node') {
            const node = this.content;
            node.measure();
            this.width = Math.max(150, this.width, node.width + (2 * xPadding));
            this.height += node.height + yPadding + yPadding + yPadding + yPadding;
        } else if (this.type === 'node[]') {
            for (const node of this.content) {
                node.measure();
                this.width = Math.max(150, this.width, node.width + (2 * xPadding));
                this.height += node.height + yPadding + yPadding + yPadding + yPadding;
            }
        }
    }

    layout() {
        const yPadding = 1;
        const xPadding = 6;
        let y = this.y + this.bottom;
        if (this.type === 'node') {
            const node = this.content;
            node.width = this.width - xPadding - xPadding;
            node.layout();
            node.x = this.x + xPadding + (node.width / 2);
            node.y = y + (node.height / 2) + yPadding + yPadding;
        } else if (this.type === 'node[]') {
            for (const node of this.content) {
                node.width = this.width - xPadding - xPadding;
                node.layout();
                node.x = this.x + xPadding + (node.width / 2);
                node.y = y + (node.height / 2) + yPadding + yPadding;
                y += node.height + yPadding + yPadding + yPadding + yPadding;
            }
        }
    }

    update() {
        const yPadding = 1;
        const xPadding = 6;
        this.text.setAttribute('x', grapher.Node.snap(this.x + xPadding));
        this.text.setAttribute('y', grapher.Node.snap(this.y + yPadding - this.offset));
        this.border.setAttribute('x', grapher.Node.snap(this.x + 3));
        this.border.setAttribute('y', grapher.Node.snap(this.y));
        this.border.setAttribute('width', grapher.Node.snap(this.width - 6));
        this.border.setAttribute('height', grapher.Node.snap(this.height));
        if (this.type === 'node') {
            const node = this.content;
            node.update();
        } else if (this.type === 'node[]') {
            for (const node of this.content) {
                node.update();
            }
        }
    }

    select() {
        if (this.element) {
            this.element.classList.add('select');
            return [this.element];
        }
        return [];
    }

    deselect() {
        if (this.element) {
            this.element.classList.remove('select');
        }
    }
};

grapher.Node.Canvas = class {

    constructor() {
        this.width = 0;
        this.height = 80;
    }

    build(/* document, parent */) {
    }

    release() {
    }

    measure() {
    }

    layout() {
    }

    update(/* parent, top, width , first, last */) {
    }
};

grapher.Edge = class {

    constructor(from, to) {
        this.from = from;
        this.to = to;
    }

    build(document, edgePathGroupElement, edgePathHitTestGroupElement, edgeLabelGroupElement) {
        const createElement = (name) => {
            return document.createElementNS('http://www.w3.org/2000/svg', name);
        };
        this.element = createElement('path');
        if (this.id) {
            this.element.setAttribute('id', this.id);
        }
        this.element.setAttribute('class', this.class ? `edge-path ${this.class}` : 'edge-path');
        this._pathParentElement = edgePathGroupElement;
        edgePathGroupElement.appendChild(this.element);
        this.hitTest = createElement('path');
        this._hitTestParentElement = edgePathHitTestGroupElement;
        edgePathHitTestGroupElement.appendChild(this.hitTest);
        if (this.label) {
            const tspan = createElement('tspan');
            tspan.setAttribute('xml:space', 'preserve');
            tspan.setAttribute('dy', '1em');
            tspan.setAttribute('x', '1');
            tspan.appendChild(document.createTextNode(this.label));
            this.labelElement = createElement('text');
            this.labelElement.appendChild(tspan);
            this.labelElement.style.opacity = 0;
            this.labelElement.setAttribute('class', 'edge-label');
            this._labelParentElement = edgeLabelGroupElement;
            if (this.id) {
                this.labelElement.setAttribute('id', `edge-label-${this.id}`);
            }
            edgeLabelGroupElement.appendChild(this.labelElement);
        }
    }

    release() {
        this.element = null;
        this.hitTest = null;
        this.labelElement = null;
        this._pathParentElement = null;
        this._hitTestParentElement = null;
        this._labelParentElement = null;
        this._needsUpdate = true;
        if (this._pointBuffer && this._points) {
            const sameLength = this._points.length === this._pointCount;
            this.packPoints(sameLength ? this._pointBuffer : new Float64Array(this._points.length * 2), sameLength ? this._pointOffset : 0);
        }
    }

    get points() {
        if (!this._points && this._pointBuffer) {
            this._points = Array.from({ length: this._pointCount }, (_, i) => ({
                x: this._pointBuffer[this._pointOffset + i * 2],
                y: this._pointBuffer[this._pointOffset + i * 2 + 1]
            }));
        }
        return this._points;
    }

    set points(points) {
        this._pointBuffer = null;
        this._points = points;
    }

    packPoints(buffer, offset) {
        const points = this.points || [];
        const start = offset;
        for (const point of points) {
            buffer[offset++] = point.x;
            buffer[offset++] = point.y;
        }
        this._pointBuffer = buffer;
        this._pointOffset = start;
        this._pointCount = points.length;
        this._points = null;
        return offset;
    }

    get pathPoints() {
        const intersectRect = (node, point) => {
            const x = node.x;
            const y = node.y;
            const dx = point.x - x;
            const dy = point.y - y;
            let h = node.height / 2;
            let w = node.width / 2;
            if (Math.abs(dy) * w > Math.abs(dx) * h) {
                if (dy < 0) {
                    h = -h;
                }
                return { x: x + (dy === 0 ? 0 : h * dx / dy), y: y + h };
            }
            if (dx < 0) {
                w = -w;
            }
            return { x: x + w, y: y + (dx === 0 ? 0 : w * dy / dx) };
        };
        const sourcePoints = Array.isArray(this.points) ? this.points : [];
        if (sourcePoints.length === 0) {
            return [];
        }
        if (sourcePoints.length === 1) {
            const p = sourcePoints[0];
            return [p];
        }
        const points = sourcePoints.slice(1, sourcePoints.length - 1);
        if (points.length === 0) {
            const start = sourcePoints[0];
            const end = sourcePoints[sourcePoints.length - 1];
            points.push({ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 });
        }
        points.unshift(intersectRect(this.from, points[0]));
        points.push(intersectRect(this.to, points[points.length - 1]));
        return points;
    }

    update() {
        const points = this.pathPoints;
        const edgePath = this._pathStyle === 'orthogonal' ?
            new grapher.Edge.Polyline(points, 30).path.data : new grapher.Edge.Curve(points).path.data;
        this.element.setAttribute('d', edgePath);
        this.hitTest.setAttribute('d', edgePath);
        // Apply per-edge visual overrides for large-graph readability.
        if (this._strokeOpacity !== undefined) {
            this.element.setAttribute('stroke-opacity', this._strokeOpacity);
        }
        if (this._strokeWidth !== undefined) {
            this.element.setAttribute('stroke-width', this._strokeWidth);
        }
        if (this.labelElement) {
            const labelX = this.x;
            const labelY = this.y;
            this.labelElement.setAttribute('transform', `translate(${labelX - (this.width / 2)},${labelY - (this.height / 2)})`);
            this.labelElement.style.opacity = 1;
        }
    }

    select() {
        if (this.element) {
            if (!this.element.classList.contains('select')) {
                const path = this.element;
                path.classList.add('select');
                this.element = path.cloneNode(true);
                if (path.parentNode) {
                    path.parentNode.replaceChild(this.element, path);
                }
            }
            return [this.element];
        }
        return [];
    }

    deselect() {
        if (this.element && this.element.classList.contains('select')) {
            const path = this.element;
            path.classList.remove('select');
            this.element = path.cloneNode(true);
            if (path.parentNode) {
                path.parentNode.replaceChild(this.element, path);
            }
        }
    }
};

grapher.Edge.Curve = class {

    constructor(points) {
        this._path = new grapher.Edge.Path();
        this._x0 = NaN;
        this._x1 = NaN;
        this._y0 = NaN;
        this._y1 = NaN;
        this._state = 0;
        for (let i = 0; i < points.length; i++) {
            const point = points[i];
            this.point(point.x, point.y);
            if (i === points.length - 1) {
                switch (this._state) {
                    case 3:
                        this.curve(this._x1, this._y1);
                        this._path.lineTo(this._x1, this._y1);
                        break;
                    case 2:
                        this._path.lineTo(this._x1, this._y1);
                        break;
                    default:
                        break;
                }
                if (this._line || (this._line !== 0 && this._point === 1)) {
                    this._path.closePath();
                }
                this._line = 1 - this._line;
            }
        }
    }

    get path() {
        return this._path;
    }

    point(x, y) {
        x = Number(x);
        y = Number(y);
        switch (this._state) {
            case 0:
                this._state = 1;
                if (this._line) {
                    this._path.lineTo(x, y);
                } else {
                    this._path.moveTo(x, y);
                }
                break;
            case 1:
                this._state = 2;
                break;
            case 2:
                this._state = 3;
                this._path.lineTo((5 * this._x0 + this._x1) / 6, (5 * this._y0 + this._y1) / 6);
                this.curve(x, y);
                break;
            default:
                this.curve(x, y);
                break;
        }
        this._x0 = this._x1;
        this._x1 = x;
        this._y0 = this._y1;
        this._y1 = y;
    }

    curve(x, y) {
        this._path.bezierCurveTo(
            (2 * this._x0 + this._x1) / 3,
            (2 * this._y0 + this._y1) / 3,
            (this._x0 + 2 * this._x1) / 3,
            (this._y0 + 2 * this._y1) / 3,
            (this._x0 + 4 * this._x1 + x) / 6,
            (this._y0 + 4 * this._y1 + y) / 6
        );
    }
};

grapher.Edge.Polyline = class {

    constructor(points, radius = 0) {
        this._path = new grapher.Edge.Path();
        const list = [];
        for (const point of points) {
            const x = Number(point.x);
            const y = Number(point.y);
            const last = list.length > 0 ? list[list.length - 1] : null;
            if (!last || last.x !== x || last.y !== y) {
                list.push({ x, y });
            }
        }
        if (list.length === 0) {
            return;
        }
        this._path.moveTo(list[0].x, list[0].y);
        if (list.length === 1) {
            return;
        }
        if (radius <= 0 || list.length < 3) {
            for (let i = 1; i < list.length; i++) {
                this._path.lineTo(list[i].x, list[i].y);
            }
            return;
        }
        for (let i = 1; i < list.length - 1; i++) {
            const a = list[i - 1];
            const b = list[i];
            const c = list[i + 1];
            const abx = b.x - a.x;
            const aby = b.y - a.y;
            const bcx = c.x - b.x;
            const bcy = c.y - b.y;
            const abLen = Math.sqrt((abx * abx) + (aby * aby));
            const bcLen = Math.sqrt((bcx * bcx) + (bcy * bcy));
            if (!abLen || !bcLen) {
                this._path.lineTo(b.x, b.y);
                continue;
            }
            const cross = (abx * bcy) - (aby * bcx);
            if (Math.abs(cross) < 0.001) {
                this._path.lineTo(b.x, b.y);
                continue;
            }
            const corner = Math.min(radius, abLen / 2, bcLen / 2);
            const startX = b.x - ((abx / abLen) * corner);
            const startY = b.y - ((aby / abLen) * corner);
            const endX = b.x + ((bcx / bcLen) * corner);
            const endY = b.y + ((bcy / bcLen) * corner);
            this._path.lineTo(startX, startY);
            this._path.quadraticCurveTo(b.x, b.y, endX, endY);
        }
        this._path.lineTo(list[list.length - 1].x, list[list.length - 1].y);
    }

    get path() {
        return this._path;
    }
};

grapher.Edge.Path = class {

    constructor() {
        this._x0 = null;
        this._y0 = null;
        this._x1 = null;
        this._y1 = null;
        this._data = '';
    }

    moveTo(x, y) {
        this._x0 = x;
        this._x1 = x;
        this._y0 = y;
        this._y1 = y;
        this._data += `M${x},${y}`;
    }

    lineTo(x, y) {
        this._x1 = x;
        this._y1 = y;
        this._data += `L${x},${y}`;
    }

    bezierCurveTo(x1, y1, x2, y2, x, y) {
        this._x1 = x;
        this._y1 = y;
        this._data += `C${x1},${y1},${x2},${y2},${x},${y}`;
    }

    quadraticCurveTo(x1, y1, x, y) {
        this._x1 = x;
        this._y1 = y;
        this._data += `Q${x1},${y1},${x},${y}`;
    }

    closePath() {
        if (this._x1 !== null) {
            this._x1 = this._x0;
            this._y1 = this._y0;
            this._data += "Z";
        }
    }

    get data() {
        return this._data;
    }
};

grapher.TileManager = class {

    constructor(tileSize = 300) {
        if (!Number.isFinite(tileSize) || tileSize <= 0) {
            throw new Error('Invalid tile size.');
        }
        this._tileSize = tileSize;
        // Integer-keyed tile map: key = (tileX + 0x8000) | ((tileY + 0x8000) << 16)
        // Avoids string allocation on every addNode/addEdge/queryViewport call.
        // Larger coordinates use strings to avoid wrapping onto unrelated tiles.
        this._tiles = new Map(); // intKey -> { nodes: Set, edges: Set }
        this._nodeTiles = new Map(); // nodeKey -> Set of int tile keys
        this._edgeTiles = new Map(); // edgeKey -> Set of int tile keys
        this._bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    }

    clear() {
        this._tiles.clear();
        this._nodeTiles.clear();
        this._edgeTiles.clear();
        this._bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    }

    _getTileKey(tileX, tileY) {
        // Pack two signed 16-bit integers into one 32-bit integer key.
        // Bias by 0x8000 so negative coordinates map to positive integers.
        if (tileX < -32768 || tileX > 32767 || tileY < -32768 || tileY > 32767) {
            return `${tileX},${tileY}`;
        }
        return ((tileX + 0x8000) & 0xFFFF) | (((tileY + 0x8000) & 0xFFFF) << 16);
    }

    _getTileCoords(x, y) {
        const tileX = Math.floor(x / this._tileSize);
        const tileY = Math.floor(y / this._tileSize);
        if (!Number.isSafeInteger(tileX) || !Number.isSafeInteger(tileY)) {
            throw new Error('Invalid tile coordinates.');
        }
        return { tileX, tileY };
    }

    _ensureTile(tileKey) {
        if (!this._tiles.has(tileKey)) {
            this._tiles.set(tileKey, { nodes: new Set(), edges: new Set() });
        }
        return this._tiles.get(tileKey);
    }

    addNode(nodeKey, bounds) {
        // bounds: { x, y, width, height }
        const { x, y, width, height } = bounds;

        // Update global bounds
        this._bounds.minX = Math.min(this._bounds.minX, x);
        this._bounds.minY = Math.min(this._bounds.minY, y);
        this._bounds.maxX = Math.max(this._bounds.maxX, x + width);
        this._bounds.maxY = Math.max(this._bounds.maxY, y + height);

        // Calculate which tiles this node overlaps
        const topLeft = this._getTileCoords(x, y);
        const bottomRight = this._getTileCoords(x + width, y + height);

        const tileset = new Set();
        for (let tileX = topLeft.tileX; tileX <= bottomRight.tileX; tileX++) {
            for (let tileY = topLeft.tileY; tileY <= bottomRight.tileY; tileY++) {
                const tileKey = this._getTileKey(tileX, tileY);
                this._ensureTile(tileKey).nodes.add(nodeKey);
                tileset.add(tileKey);
            }
        }
        this._nodeTiles.set(nodeKey, tileset);
    }

    addEdge(edgeKey, points, bounds = null) {
        // points: array of {x, y} coordinates for edge path
        if (!points || points.length === 0) {
            return;
        }

        let singleTile = true;
        const first = this._getTileCoords(points[0].x, points[0].y);
        for (const point of points) {
            const tile = this._getTileCoords(point.x, point.y);
            singleTile = singleTile && tile.tileX === first.tileX && tile.tileY === first.tileY;
        }
        const tileset = new Set();
        const ts = this._tileSize;
        if (singleTile) {
            const key = this._getTileKey(first.tileX, first.tileY);
            this._ensureTile(key).edges.add(edgeKey);
            tileset.add(key);
        }

        // Basis and rounded curves stay inside the convex hull of neighboring waypoints.
        // Scan that hull by tile row instead of filling each segment's bounding box.
        const segments = singleTile ? 0 : points.length - 1;
        for (let i = 0; i < segments; i++) {
            const hull = points.slice(Math.max(0, i - 1), Math.min(points.length, i + 3));
            const minY = Math.floor(Math.min(...hull.map((point) => point.y)) / ts);
            const maxY = Math.floor(Math.max(...hull.map((point) => point.y)) / ts);
            const minTileX = Math.floor(Math.min(...hull.map((point) => point.x)) / ts);
            const maxTileX = Math.floor(Math.max(...hull.map((point) => point.x)) / ts);
            if (minY === maxY || minTileX === maxTileX || (maxY - minY + 1) * (maxTileX - minTileX + 1) <= 4) {
                for (let x = minTileX; x <= maxTileX; x++) {
                    for (let y = minY; y <= maxY; y++) {
                        const key = this._getTileKey(x, y);
                        if (!tileset.has(key)) {
                            this._ensureTile(key).edges.add(edgeKey);
                            tileset.add(key);
                        }
                    }
                }
                continue;
            }
            for (let ty = minY; ty <= maxY; ty++) {
                const low = ty * ts;
                const high = low + ts;
                let minX = Infinity;
                let maxX = -Infinity;
                const include = (x) => {
                    minX = Math.min(minX, x);
                    maxX = Math.max(maxX, x);
                };
                for (let j = 0; j < hull.length; j++) {
                    const a = hull[j];
                    if (a.y >= low && a.y <= high) {
                        include(a.x);
                    }
                    for (let k = j + 1; k < hull.length; k++) {
                        const b = hull[k];
                        if (a.y !== b.y) {
                            for (const y of [low, high]) {
                                const t = (y - a.y) / (b.y - a.y);
                                if (t >= 0 && t <= 1) {
                                    include(a.x + t * (b.x - a.x));
                                }
                            }
                        }
                    }
                }
                for (let tx = Math.floor(minX / ts); tx <= Math.floor(maxX / ts); tx++) {
                    const key = this._getTileKey(tx, ty);
                    if (!tileset.has(key)) {
                        this._ensureTile(key).edges.add(edgeKey);
                        tileset.add(key);
                    }
                }
            }
        }

        if (bounds) {
            const topLeft = this._getTileCoords(bounds.x, bounds.y);
            const bottomRight = this._getTileCoords(bounds.x + bounds.width, bounds.y + bounds.height);
            for (let x = topLeft.tileX; x <= bottomRight.tileX; x++) {
                for (let y = topLeft.tileY; y <= bottomRight.tileY; y++) {
                    const key = this._getTileKey(x, y);
                    this._ensureTile(key).edges.add(edgeKey);
                    tileset.add(key);
                }
            }
        }
        this._edgeTiles.set(edgeKey, tileset);
    }

    queryViewport(viewportBounds, bufferTiles = 1) {
        // viewportBounds: { x, y, width, height }
        const { x, y, width, height } = viewportBounds;

        const topLeft = this._getTileCoords(x, y);
        const bottomRight = this._getTileCoords(x + width, y + height);

        const visibleNodes = new Set();
        const visibleEdges = new Set();

        const left = topLeft.tileX - bufferTiles;
        const right = bottomRight.tileX + bufferTiles;
        const top = topLeft.tileY - bufferTiles;
        const bottom = bottomRight.tileY + bufferTiles;
        const collect = (tile) => {
            tile.nodes.forEach((node) => visibleNodes.add(node));
            tile.edges.forEach((edge) => visibleEdges.add(edge));
        };
        // At overview zoom, scan occupied tiles rather than a mostly empty grid.
        if ((right - left + 1) * (bottom - top + 1) > this._tiles.size) {
            for (const [key, tile] of this._tiles) {
                const [tileX, tileY] = typeof key === 'number' ?
                    [(key & 0xFFFF) - 0x8000, (key >>> 16) - 0x8000] : key.split(',').map(Number);
                if (tileX >= left && tileX <= right && tileY >= top && tileY <= bottom) {
                    collect(tile);
                }
            }
        } else {
            for (let tileX = left; tileX <= right; tileX++) {
                for (let tileY = top; tileY <= bottom; tileY++) {
                    const tile = this._tiles.get(this._getTileKey(tileX, tileY));
                    if (tile) {
                        collect(tile);
                    }
                }
            }
        }

        return { nodes: visibleNodes, edges: visibleEdges };
    }

    static adaptiveSize(nodeCount) {
        if (nodeCount < 100) {
            return 200;
        }
        if (nodeCount < 500) {
            return 300;
        }
        if (nodeCount < 2000) {
            return 500;
        }
        return 800;
    }

    getTileInfo() {
        return {
            tileSize: this._tileSize,
            tileCount: this._tiles.size,
            nodeCount: this._nodeTiles.size,
            edgeCount: this._edgeTiles.size,
            bounds: { ...this._bounds }
        };
    }
};

grapher.ViewportObserver = class {

    constructor(callback) {
        this._callback = callback;
        this._timer = null;
        this._pendingViewport = null;
        this._lastViewport = null;
        this._threshold = 50; // pixels - minimum movement to trigger update
        this._rafId = null;
    }

    observe(viewport) {
        if (this._rafId !== null || this._timer !== null) {
            this._pendingViewport = { ...viewport };
            return;
        }

        // Check if viewport changed significantly
        if (this._lastViewport) {
            const dx = Math.abs(viewport.x - this._lastViewport.x);
            const dy = Math.abs(viewport.y - this._lastViewport.y);
            const dw = Math.abs(viewport.width - this._lastViewport.width);
            const dh = Math.abs(viewport.height - this._lastViewport.height);
            const dz = Math.abs(viewport.zoom - this._lastViewport.zoom);

            // Skip if change is below threshold
            if (dx < this._threshold && dy < this._threshold &&
                dw < this._threshold && dh < this._threshold && dz < 0.01) {
                return;
            }
        }

        this._pendingViewport = { ...viewport };
        const update = () => {
            this._timer = null;
            this._rafId = null;
            const current = this._pendingViewport;
            this._pendingViewport = null;
            this._lastViewport = current;
            this._callback(current);
        };
        if (typeof requestAnimationFrame === 'undefined') {
            this._timer = setTimeout(update, 0);
        } else {
            this._rafId = requestAnimationFrame(update);
        }
    }

    disconnect() {
        if (this._timer !== null) {
            clearTimeout(this._timer);
            this._timer = null;
        }
        if (this._rafId !== null) {
            if (typeof cancelAnimationFrame !== 'undefined') {
                cancelAnimationFrame(this._rafId);
            }
            this._rafId = null;
        }
        this._pendingViewport = null;
        this._lastViewport = null;
    }
};

export const { Graph, Node, Edge, Argument, TileManager, ViewportObserver } = grapher;
