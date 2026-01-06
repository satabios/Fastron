
import { SpatialIndex } from './spatial-index.js';
import { LazyGraphManager } from './lazy-graph.js';
import { LODManager } from './lod-manager.js';
import { MemoryManager } from './memory-manager.js';
import { CanvasGraphRenderer } from './canvas-renderer.js';
import { PerformanceMonitor } from './performance-monitor.js';

const grapher = {};

grapher.Graph = class {

    constructor(compound) {
        this._compound = compound;
        this._nodes = new Map();
        this._edges = new Map();
        this._focusable = new Map();
        this._focused = null;
        this._children = new Map();
        this._children.set('\x00', new Map());
        this._parent = new Map();
        
        // NEW: Initialize optimization systems
        this._spatialIndex = new SpatialIndex(1000);
        this._memoryManager = new MemoryManager(500);
        this._lodManager = new LODManager();
        this._lazyManager = null; // Initialized later
        this._canvasRenderer = null;
        this._performanceMonitor = new PerformanceMonitor();
        this._useCanvas = false;
        this._useLazyLoading = false;
        this._viewport = { x: 0, y: 0, width: 0, height: 0, zoom: 1 };
        this._document = null;
        this._nodeGroup = null;
        this._edgePathGroup = null;
        this._edgePathHitTestGroup = null;
        this._edgeLabelGroup = null;
        this._worker = null;
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
        if (!this._edges.has(key)) {
            this._edges.set(key, { v: edge.v, w: edge.w, label: edge });
        }
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

    async build(document, origin) {
        this._document = document;
        this._performanceMonitor.startMetric('buildTime');
        
        // Use standard SVG rendering for all graphs
        await this._buildSVG(document, origin);
        
        this._performanceMonitor.endMetric('buildTime');
        this._performanceMonitor.updateMetric('totalNodes', this.nodes.size);
        this._performanceMonitor.updateMetric('totalEdges', this.edges.size);
    }
    
    async _buildCanvas(document, origin) {
        // Create canvas element
        const canvas = document.createElement('canvas');
        canvas.id = 'graph-canvas';
        canvas.width = origin.clientWidth || 1920;
        canvas.height = origin.clientHeight || 1080;
        canvas.style.cssText = 'position: absolute; top: 0; left: 0; width: 100%; height: 100%;';
        origin.appendChild(canvas);
        
        this._canvasRenderer = new CanvasGraphRenderer(canvas);
        
        // Initialize lazy loading
        this._lazyManager = new LazyGraphManager(this, this._spatialIndex, this._memoryManager);
        await this._lazyManager.initialize();
        
        // Set up viewport tracking
        this._setupViewportTracking(origin);
        
        // Render initial viewport
        await this.updateViewport();
    }
    
    async _buildLazy(document, origin) {
        // Store document reference for lazy loading
        this._document = document;
        
        // Use SVG but with lazy loading
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
        
        this._nodeGroup = nodeGroup;
        this._edgePathGroup = edgePathGroup;
        this._edgePathHitTestGroup = edgePathHitTestGroup;
        this._edgeLabelGroup = edgeLabelGroup;
        
        // Set up edge markers
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
        
        edgePathGroupDefs.appendChild(marker("arrowhead"));
        edgePathGroupDefs.appendChild(marker("arrowhead-select"));
        edgePathGroupDefs.appendChild(marker("arrowhead-hover"));
        
        // Set up event handlers
        this._setupEdgeEventHandlers(edgePathHitTestGroup);
        
        origin.appendChild(clusterGroup);
        origin.appendChild(edgePathGroup);
        origin.appendChild(edgePathHitTestGroup);
        origin.appendChild(edgeLabelGroup);
        origin.appendChild(nodeGroup);
        
        // Initialize lazy loading
        this._lazyManager = new LazyGraphManager(this, this._spatialIndex, this._memoryManager);
        await this._lazyManager.initialize();
        
        // For lazy loading, we need to manually trigger initial render
        // Set a default viewport based on the graph bounds
        const bounds = this._calculateGraphBounds();
        this._viewport = {
            x: bounds.minX,
            y: bounds.minY,
            width: bounds.width || 2000,
            height: bounds.height || 2000,
            zoom: 1
        };
        
        // Load and render initial viewport
        await this.updateViewport();
        
        // Set up viewport tracking for future updates
        this._setupViewportTracking(origin);
    }
    
    async _buildSVG(document, origin) {
        // Original SVG build method
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
        for (const nodeId of this.nodes.keys()) {
            const entry = this.node(nodeId);
            const node = entry.label;
            if (this.children(nodeId).length === 0) {
                node.build(document, nodeGroup);
            } else {
                // cluster
                node.rectangle = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                if (node.rx) {
                    node.rectangle.setAttribute('rx', entry.rx);
                }
                if (node.ry) {
                    node.rectangle.setAttribute('ry', entry.ry);
                }
                node.element = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                node.element.setAttribute('class', 'cluster');
                node.element.appendChild(node.rectangle);
                clusterGroup.appendChild(node.element);
            }
        }

        this._focusable.clear();
        this._focused = null;
        for (const edge of this.edges.values()) {
            edge.label.build(document, edgePathGroup, edgePathHitTestGroup, edgeLabelGroup);
            this._focusable.set(edge.label.hitTest, edge.label);
        }
        origin.appendChild(clusterGroup);
        origin.appendChild(edgePathGroup);
        origin.appendChild(edgePathHitTestGroup);
        origin.appendChild(edgeLabelGroup);
        origin.appendChild(nodeGroup);
        for (const edge of this.edges.values()) {
            if (edge.label && edge.label.labelElement) {
                try {
                    const label = edge.label;
                    const box = label.labelElement.getBBox();
                    label.width = box.width;
                    label.height = box.height;
                } catch (e) {
                    // Element may not be attached to DOM yet
                    console.warn('Failed to get edge label bounding box:', e);
                }
            }
        }
    }

    measure() {
        for (const key of this.nodes.keys()) {
            const entry = this.node(key);
            if (this.children(key).length === 0) {
                const node = entry.label;
                node.measure();
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
            nodes = nodes.reverse(); // rankdir workaround
        }
        if (nodes.length > 3000) {
            layout.ranker = 'longest-path';
        }
        const state = { /* log: true */ };
        if (worker) {
            const message = await worker.request({ type: 'dagre.layout', nodes, edges, layout, state }, 2500, 'This large graph layout might take a very long time to complete.');
            if (message.type === 'cancel') {
                return 'graph-layout-cancelled';
            }
            nodes = message.nodes;
            edges = message.edges;
            state.log = message.state.log;
        } else {
            const dagre = await import('./dagre.js');
            dagre.layout(nodes, edges, layout, state);
        }
        if (state.log) {
            const fs = await import('fs');
            fs.writeFileSync(`dist/test/${this.identifier}.log`, state.log);
        }
        for (const node of nodes) {
            const label = this.node(node.v).label;
            label.x = node.x;
            label.y = node.y;
            if (this.children(node.v).length) {
                label.width = node.width;
                label.height = node.height;
            }
        }
        for (const edge of edges) {
            const label = this.edge(edge.v, edge.w).label;
            label.points = edge.points;
            if ('x' in edge) {
                label.x = edge.x;
                label.y = edge.y;
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

    update() {
        for (const nodeId of this.nodes.keys()) {
            if (this.children(nodeId).length === 0) {
                // node
                const entry = this.node(nodeId);
                const node = entry.label;
                if (node && node.update) {
                    try {
                        node.update();
                    } catch (e) {
                        console.warn(`Failed to update node ${nodeId}:`, e);
                    }
                }
            } else {
                // cluster
                const entry = this.node(nodeId);
                const node = entry.label;
                if (node && node.element && node.rectangle) {
                    try {
                        node.element.setAttribute('transform', `translate(${node.x},${node.y})`);
                        node.rectangle.setAttribute('x', - node.width / 2);
                        node.rectangle.setAttribute('y', - node.height / 2);
                        node.rectangle.setAttribute('width', node.width);
                        node.rectangle.setAttribute('height', node.height);
                    } catch (e) {
                        console.warn(`Failed to update cluster ${nodeId}:`, e);
                    }
                }
            }
        }
        for (const edge of this.edges.values()) {
            if (edge.label && edge.label.update) {
                try {
                    edge.label.update();
                } catch (e) {
                    console.warn(`Failed to update edge:`, e);
                }
            }
        }
    }
    
    // NEW: Calculate graph bounds from layout data
    _calculateGraphBounds() {
        if (!this._lazyManager || !this._lazyManager.layoutData) {
            return { minX: 0, minY: 0, width: 2000, height: 2000 };
        }
        
        const nodes = this._lazyManager.layoutData.nodes;
        if (Object.keys(nodes).length === 0) {
            return { minX: 0, minY: 0, width: 2000, height: 2000 };
        }
        
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        
        for (const nodeData of Object.values(nodes)) {
            const halfWidth = nodeData.width / 2;
            const halfHeight = nodeData.height / 2;
            minX = Math.min(minX, nodeData.x - halfWidth);
            minY = Math.min(minY, nodeData.y - halfHeight);
            maxX = Math.max(maxX, nodeData.x + halfWidth);
            maxY = Math.max(maxY, nodeData.y + halfHeight);
        }
        
        return {
            minX: minX - 100, // Add padding
            minY: minY - 100,
            width: maxX - minX + 200,
            height: maxY - minY + 200
        };
    }
    
    // NEW: Setup viewport tracking
    _setupViewportTracking(container) {
        let rafId = null;
        let lastUpdate = 0;
        const throttleMs = 100; // Update viewport every 100ms max
        
        const updateViewport = () => {
            const now = Date.now();
            if (now - lastUpdate < throttleMs) {
                return;
            }
            lastUpdate = now;
            
            const rect = container.getBoundingClientRect();
            const transform = this._getTransform(container);
            
            this._viewport = {
                x: -transform.x / transform.scale,
                y: -transform.y / transform.scale,
                width: rect.width / transform.scale,
                height: rect.height / transform.scale,
                zoom: transform.scale
            };
            
            this.updateViewport();
        };
        
        // Throttled viewport updates
        const throttledUpdate = () => {
            if (rafId) {
                cancelAnimationFrame(rafId);
            }
            rafId = requestAnimationFrame(updateViewport);
        };
        
        container.addEventListener('scroll', throttledUpdate);
        container.addEventListener('wheel', throttledUpdate);
        
        // Handle window resize
        window.addEventListener('resize', throttledUpdate);
    }
    
    // NEW: Get transform from container
    _getTransform(container) {
        // Try to get transform from SVG or canvas
        const svg = container.querySelector('svg');
        if (svg) {
            const g = svg.querySelector('g');
            if (g) {
                const transform = g.getAttribute('transform');
                if (transform) {
                    const match = transform.match(/translate\(([^,]+),([^)]+)\).*scale\(([^)]+)\)/);
                    if (match) {
                        return {
                            x: parseFloat(match[1]),
                            y: parseFloat(match[2]),
                            scale: parseFloat(match[3])
                        };
                    }
                }
            }
        }
        
        return { x: 0, y: 0, scale: 1 };
    }
    
    // NEW: Update viewport and render visible content
    async updateViewport() {
        if (!this._lazyManager) {
            return;
        }
        
        const { x, y, width, height, zoom } = this._viewport;
        
        this._performanceMonitor.startMetric('viewportUpdate');
        
        // Update lazy manager
        const result = await this._lazyManager.updateViewport(x, y, width, height, zoom);
        
        this._performanceMonitor.endMetric('viewportUpdate');
        this._performanceMonitor.updateMetric('visibleNodes', result.nodes.size);
        this._performanceMonitor.updateMetric('visibleEdges', result.edges.size);
        
        // Render if using canvas
        if (this._canvasRenderer) {
            this._renderCanvas();
        }
        
        // Cleanup memory
        const visibleItems = new Set([...result.nodes, ...result.edges]);
        this._memoryManager.cleanup(visibleItems);
        
        // Record frame for FPS tracking
        this._performanceMonitor.recordFrame();
    }
    
    // NEW: Render canvas
    _renderCanvas() {
        if (!this._canvasRenderer || !this._lazyManager) {
            return;
        }
        
        this._performanceMonitor.startMetric('renderTime');
        
        const { x, y, width, height, zoom } = this._viewport;
        
        this._canvasRenderer.clear();
        
        // Get visible items
        const visibleItems = this._spatialIndex.queryViewport(x, y, width, height);
        
        // Render nodes
        for (const itemId of visibleItems) {
            const nodeData = this._lazyManager.layoutData?.nodes[itemId];
            if (nodeData) {
                const node = nodeData.original;
                if (!node || !node.label) {
                    continue;
                }
                
                const lod = this._lodManager.getNodeLOD(node.label, this._viewport);
                const screenX = (node.label.x - x) * zoom;
                const screenY = (node.label.y - y) * zoom;
                
                if (this._lodManager.shouldRenderNode(node.label, this._viewport, zoom)) {
                    this._canvasRenderer.renderNode(node.label, screenX, screenY, zoom, lod);
                }
            }
        }
        
        // Render edges
        for (const itemId of visibleItems) {
            const edgeData = this._lazyManager.layoutData?.edges[itemId];
            if (edgeData && edgeData.original) {
                const edge = edgeData.original;
                if (!edge || !edge.label || !edge.label.points) {
                    continue;
                }
                
                const lod = this._lodManager.determineLOD(zoom, 1, 0);
                const screenPoints = edge.label.points.map(p => ({
                    x: (p.x - x) * zoom,
                    y: (p.y - y) * zoom
                }));
                
                this._canvasRenderer.renderEdge(edge.label, screenPoints, lod, zoom);
            }
        }
        
        this._performanceMonitor.endMetric('renderTime');
    }
    
    // NEW: Setup edge event handlers
    _setupEdgeEventHandlers(edgePathHitTestGroup) {
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
    }
    
    // NEW: Get performance stats
    getPerformanceStats() {
        return {
            monitor: this._performanceMonitor.getMetrics(),
            memory: this._memoryManager.getMemoryUsage(),
            spatial: this._spatialIndex.getStats(),
            lazy: this._lazyManager ? this._lazyManager.getStats() : null
        };
    }
    
    // NEW: Enable performance overlay
    showPerformanceOverlay(container) {
        return this._performanceMonitor.createOverlay(container);
    }
    
    // NEW: Set worker for background processing
    setWorker(worker) {
        this._worker = worker;
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
        this.element.style.opacity = 0;
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
        if (!this.element || !this.border) {
            console.warn('Cannot update node: element or border not built');
            return;
        }
        for (const block of this._blocks) {
            if (block.update) {
                block.update();
            }
        }
        this.border.setAttribute('d', grapher.Node.roundedRect(0, 0, this.width, this.height, true, true, true, true));
        this.element.setAttribute('transform', `translate(${this.x - (this.width / 2)},${this.y - (this.height / 2)})`);
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
            if (!entry.element || !entry.path || !entry.text) {
                continue;
            }
            entry.element.setAttribute('transform', `translate(${entry.x},${this.y})`);
            const r1 = i === 0 && this.first;
            const r2 = i === this._entries.length - 1 && this.first;
            const r3 = i === this._entries.length - 1 && this.last;
            const r4 = i === 0 && this.last;
            entry.path.setAttribute('d', grapher.Node.roundedRect(0, 0, entry.width, entry.height, r1, r2, r3, r4));
            entry.text.setAttribute('x', 6);
            entry.text.setAttribute('y', entry.ty);
        }
        for (let i = 1; i < this._entries.length; i++) {
            const entry = this._entries[i];
            const line = entry.line;
            if (line) {
                line.setAttribute('class', 'node');
                line.setAttribute('x1', entry.x);
                line.setAttribute('x2', entry.x);
                line.setAttribute('y1', this.y);
                line.setAttribute('y2', this.y + this.height);
            }
        }
        if (this.line) {
            this.line.setAttribute('class', 'node');
            this.line.setAttribute('x1', 0);
            this.line.setAttribute('x2', this.width);
            this.line.setAttribute('y1', this.y);
            this.line.setAttribute('y2', this.y);
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

    measure() {
        const yPadding = 4;
        const xPadding = 7;
        if (!this.text) {
            this.width = 100;
            this.height = 20;
            this.tx = xPadding;
            this.ty = yPadding;
            return;
        }
        try {
            const boundingBox = this.text.getBBox();
            this.width = boundingBox.width + xPadding + xPadding;
            this.height = boundingBox.height + yPadding + yPadding;
            this.tx = xPadding;
            this.ty = yPadding - boundingBox.y;
        } catch (e) {
            // Fallback if getBBox fails
            this.width = 100;
            this.height = 20;
            this.tx = xPadding;
            this.ty = yPadding;
        }
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
        if (!this.element || !this.background) {
            return;
        }
        this.element.setAttribute('transform', `translate(${this.x},${this.y})`);
        this.background.setAttribute('d', grapher.Node.roundedRect(0, 0, this.width, this.height, this.first, this.first, this.last, this.last));
        for (const item of this._items) {
            if (item.update) {
                item.update();
            }
        }
        if (this.line) {
            this.line.setAttribute('x1', 0);
            this.line.setAttribute('x2', this.width);
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

    measure() {
        const yPadding = 1;
        const xPadding = 6;
        if (!this.text) {
            this.width = 150;
            this.height = 20;
            this.bottom = 20;
            this.offset = 0;
            return;
        }
        try {
            const size = this.text.getBBox();
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
        } catch (e) {
            // Fallback if getBBox fails
            console.warn('Failed to measure argument:', e);
            this.width = 150;
            this.height = 20;
            this.bottom = 20;
            this.offset = 0;
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
        if (!this.text || !this.border) {
            return;
        }
        this.text.setAttribute('x', this.x + xPadding);
        this.text.setAttribute('y', this.y + yPadding - this.offset);
        this.border.setAttribute('x', this.x + 3);
        this.border.setAttribute('y', this.y);
        this.border.setAttribute('width', this.width - 6);
        this.border.setAttribute('height', this.height);
        if (this.type === 'node') {
            const node = this.content;
            if (node && node.update) {
                node.update();
            }
        } else if (this.type === 'node[]') {
            for (const node of this.content) {
                if (node && node.update) {
                    node.update();
                }
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
        edgePathGroupElement.appendChild(this.element);
        this.hitTest = createElement('path');
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
            if (this.id) {
                this.labelElement.setAttribute('id', `edge-label-${this.id}`);
            }
            edgeLabelGroupElement.appendChild(this.labelElement);
        }
    }

    update() {
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
        const curvePath = (edge, tail, head) => {
            const points = edge.points.slice(1, edge.points.length - 1);
            points.unshift(intersectRect(tail, points[0]));
            points.push(intersectRect(head, points[points.length - 1]));
            return new grapher.Edge.Curve(points).path.data;
        };
        const edgePath = curvePath(this, this.from, this.to);
        this.element.setAttribute('d', edgePath);
        this.hitTest.setAttribute('d', edgePath);
        if (this.labelElement) {
            this.labelElement.setAttribute('transform', `translate(${this.x - (this.width / 2)},${this.y - (this.height / 2)})`);
            this.labelElement.style.opacity = 1;
        }
    }

    select() {
        if (this.element) {
            if (!this.element.classList.contains('select')) {
                const path = this.element;
                path.classList.add('select');
                this.element = path.cloneNode(true);
                path.parentNode.replaceChild(this.element, path);
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
            path.parentNode.replaceChild(this.element, path);
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

export const { Graph, Node, Edge, Argument } = grapher;