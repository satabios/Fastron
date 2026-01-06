/**
 * Lazy Graph Manager
 * Manages lazy loading and rendering of graph nodes and edges
 */

export class LazyGraphManager {
    constructor(graph, spatialIndex, memoryManager) {
        this.graph = graph;
        this.spatialIndex = spatialIndex;
        this.memoryManager = memoryManager;
        this.loadedNodes = new Map();
        this.loadedEdges = new Map();
        this.renderCache = new Map();
        this.prefetchQueue = [];
        this.currentViewport = null;
        this.isInitialized = false;
        this.layoutData = null;
        this.prefetchInProgress = false;
    }

    /**
     * Initialize with lightweight graph structure (no rendering)
     */
    async initialize() {
        if (this.isInitialized) {
            return this.layoutData;
        }
        
        try {
            // Only compute layout, don't build DOM elements yet
            this.layoutData = await this.computeLayoutOnly();
            
            if (!this.layoutData || !this.layoutData.nodes || !this.layoutData.edges) {
                console.error('[LazyGraphManager] Failed to compute layout data');
                this.layoutData = { nodes: {}, edges: {} };
                return this.layoutData;
            }
            
            // Index all nodes spatially
            for (const [nodeId, nodeData] of Object.entries(this.layoutData.nodes)) {
                this.spatialIndex.indexNode(
                    nodeId,
                    nodeData.x,
                    nodeData.y,
                    nodeData.width,
                    nodeData.height
                );
            }
            
            // Index edges spatially
            for (const [edgeId, edgeData] of Object.entries(this.layoutData.edges)) {
                if (edgeData.points) {
                    this.spatialIndex.indexEdge(edgeId, edgeData.points);
                }
            }
            
            this.isInitialized = true;
            console.log(`[LazyGraphManager] Initialized with ${Object.keys(this.layoutData.nodes).length} nodes and ${Object.keys(this.layoutData.edges).length} edges`);
            return this.layoutData;
        } catch (error) {
            console.error('[LazyGraphManager] Initialization failed:', error);
            this.layoutData = { nodes: {}, edges: {} };
            this.isInitialized = false;
            throw error;
        }
    }

    /**
     * Compute layout without building DOM
     */
    async computeLayoutOnly() {
        try {
            const nodes = [];
            const edges = [];
            const nodeMap = {};
            const edgeMap = {};
            
            // Collect node data
            for (const node of this.graph.nodes.values()) {
                const nodeData = {
                    v: node.v,
                    width: this.estimateNodeWidth(node),
                    height: this.estimateNodeHeight(node),
                    parent: this.graph.parent(node.v)
                };
                nodes.push(nodeData);
                nodeMap[node.v] = node;
            }
            
            // Collect edge data
            for (const edge of this.graph.edges.values()) {
                const edgeData = {
                    v: edge.v,
                    w: edge.w,
                    minlen: edge.label.minlen || 1,
                    weight: edge.label.weight || 1,
                    width: edge.label.width || 0,
                    height: edge.label.height || 0,
                    labeloffset: edge.label.labeloffset || 10,
                    labelpos: edge.label.labelpos || 'r'
                };
                edges.push(edgeData);
                edgeMap[`${edge.v}:${edge.w}`] = edge;
            }
            
            // Compute layout
            const layout = {
                nodesep: 20,
                ranksep: 20
            };
            
            const direction = this.graph.options?.direction;
            const rotate = edges.length === 0 ? direction === 'vertical' : direction !== 'vertical';
            if (rotate) {
                layout.rankdir = 'LR';
            }
            
            if (nodes.length > 3000) {
                layout.ranker = 'longest-path';
            }
            
            // Use Web Worker for layout if available
            let layoutResult;
            if (this.graph._worker) {
                try {
                    const message = await this.graph._worker.request({
                        type: 'dagre.layout',
                        nodes,
                        edges,
                        layout,
                        state: {}
                    }, 5000);
                    
                    if (message.type !== 'cancel') {
                        layoutResult = { nodes: message.nodes, edges: message.edges };
                    } else {
                        console.warn('[LazyGraphManager] Layout computation cancelled');
                        layoutResult = await this.computeLayoutSync(nodes, edges, layout);
                    }
                } catch (e) {
                    // Fallback to synchronous layout
                    console.warn('[LazyGraphManager] Worker layout failed, falling back to sync:', e);
                    layoutResult = await this.computeLayoutSync(nodes, edges, layout);
                }
            } else {
                layoutResult = await this.computeLayoutSync(nodes, edges, layout);
            }
            
            // Store layout data
            const result = {
                nodes: {},
                edges: {}
            };
            
            for (const node of layoutResult.nodes) {
                result.nodes[node.v] = {
                    x: node.x,
                    y: node.y,
                    width: node.width,
                    height: node.height,
                    original: nodeMap[node.v]
                };
            }
            
            for (const edge of layoutResult.edges) {
                const key = `${edge.v}:${edge.w}`;
                result.edges[key] = {
                    points: edge.points,
                    x: edge.x,
                    y: edge.y,
                    original: edgeMap[key]
                };
            }
            
            return result;
        } catch (error) {
            console.error('[LazyGraphManager] Error computing layout:', error);
            return { nodes: {}, edges: {} };
        }
    }

    /**
     * Compute layout synchronously
     */
    async computeLayoutSync(nodes, edges, layout) {
        const dagre = await import('./dagre.js');
        const state = {};
        dagre.layout(nodes, edges, layout, state);
        return { nodes, edges };
    }

    /**
     * Estimate node dimensions without building DOM
     */
    estimateNodeWidth(node) {
        const label = node.label;
        if (!label) {
            return 100;
        }
        
        let width = 75;
        
        // Estimate based on blocks
        if (label._blocks) {
            for (const block of label._blocks) {
                if (block._items) {
                    width = Math.max(width, block._items.length * 50);
                }
                if (block._entries) {
                    width = Math.max(width, block._entries.length * 60);
                }
            }
        }
        
        // Estimate based on label text
        if (label.name) {
            width = Math.max(width, label.name.length * 7 + 20);
        }
        
        return Math.min(width, 400); // Cap at 400px
    }

    estimateNodeHeight(node) {
        const label = node.label;
        if (!label || !label._blocks) {
            return 40;
        }
        
        let height = 0;
        for (const block of label._blocks) {
            if (block._items) {
                height += block._items.length * 20 + 10;
            } else if (block._entries) {
                height += block._entries.length * 25 + 10;
            } else {
                height += 30;
            }
        }
        
        return Math.max(40, Math.min(height, 600)); // Between 40 and 600px
    }

    /**
     * Update viewport and load visible nodes
     */
    async updateViewport(x, y, width, height, zoom) {
        if (!this.isInitialized || !this.layoutData) {
            console.warn('[LazyGraphManager] updateViewport called before initialization');
            return { nodes: new Set(), edges: new Set() };
        }
        
        this.currentViewport = { x, y, width, height, zoom };
        
        try {
            // Query visible items
            const visibleItems = this.spatialIndex.queryViewport(x, y, width, height, 1);
            
            // Separate nodes and edges
            const visibleNodes = new Set();
            const visibleEdges = new Set();
            
            for (const itemId of visibleItems) {
                if (this.layoutData.nodes[itemId]) {
                    visibleNodes.add(itemId);
                } else if (this.layoutData.edges[itemId]) {
                    visibleEdges.add(itemId);
                }
            }
            
            // Unload items that are no longer visible
            this.unloadInvisibleNodes(visibleNodes);
            this.unloadInvisibleEdges(visibleEdges);
            
            // Load visible items
            await this.loadNodes(visibleNodes);
            await this.loadEdges(visibleEdges);
            
            // Prefetch adjacent tiles
            this.prefetchAdjacentTiles();
            
            return { nodes: visibleNodes, edges: visibleEdges };
        } catch (error) {
            console.error('[LazyGraphManager] Error in updateViewport:', error);
            return { nodes: new Set(), edges: new Set() };
        }
    }

    /**
     * Load nodes
     */
    async loadNodes(nodeIds) {
        const nodesToLoad = Array.from(nodeIds).filter(id => !this.loadedNodes.has(id));
        
        if (nodesToLoad.length === 0) {
            return;
        }
        
        // Batch load nodes
        for (const nodeId of nodesToLoad) {
            const nodeData = this.layoutData.nodes[nodeId];
            if (nodeData && nodeData.original) {
                try {
                    await this.buildAndRenderNode(nodeData.original, nodeData);
                    this.loadedNodes.set(nodeId, nodeData);
                    
                    // Track memory usage
                    const size = this.memoryManager.estimateSize('node', nodeData);
                    this.memoryManager.allocate(nodeId, size, nodeData, 'node');
                } catch (error) {
                    console.warn(`Failed to load node ${nodeId}:`, error);
                    // Continue with next node instead of crashing
                }
            }
        }
    }

    /**
     * Load edges
     */
    async loadEdges(edgeIds) {
        const edgesToLoad = Array.from(edgeIds).filter(id => !this.loadedEdges.has(id));
        
        if (edgesToLoad.length === 0) {
            return;
        }
        
        for (const edgeId of edgesToLoad) {
            const edgeData = this.layoutData.edges[edgeId];
            if (edgeData && edgeData.original) {
                try {
                    await this.buildAndRenderEdge(edgeData.original, edgeData);
                    this.loadedEdges.set(edgeId, edgeData);
                    
                    // Track memory usage
                    const size = this.memoryManager.estimateSize('edge', edgeData);
                    this.memoryManager.allocate(edgeId, size, edgeData, 'edge');
                } catch (error) {
                    console.warn(`Failed to load edge ${edgeId}:`, error);
                    // Continue with next edge instead of crashing
                }
            }
        }
    }

    /**
     * Build and render a node
     */
    async buildAndRenderNode(node, layoutData) {
        const label = node.label;
        if (!label) {
            return;
        }
        
        // Apply layout data
        label.x = layoutData.x;
        label.y = layoutData.y;
        label.width = layoutData.width;
        label.height = layoutData.height;
        
        // Build DOM element only when needed
        // IMPORTANT: For lazy loading, we skip DOM building entirely
        // The layout data is already computed and stored
        // Actual rendering happens only in updateViewport or traditional render
        if (!label.element && this.graph._document && this.graph._nodeGroup) {
            try {
                label.build(this.graph._document, this.graph._nodeGroup);
                label.measure();
                label.layout();
                label.update();
            } catch (e) {
                // Building failed, skip this node
                console.warn(`Failed to build node ${node.v}:`, e);
                // Don't throw - gracefully handle the error
            }
        }
    }

    /**
     * Build and render an edge
     */
    async buildAndRenderEdge(edge, layoutData) {
        const label = edge.label;
        if (!label) {
            return;
        }
        
        // Apply layout data
        label.points = layoutData.points;
        if (layoutData.x !== undefined) {
            label.x = layoutData.x;
            label.y = layoutData.y;
        }
        
        // Build DOM element only when needed
        // IMPORTANT: For lazy loading, we skip DOM building entirely
        // The layout data is already computed and stored
        if (!label.element && this.graph._document) {
            try {
                if (this.graph._edgePathGroup && this.graph._edgePathHitTestGroup && this.graph._edgeLabelGroup) {
                    label.build(
                        this.graph._document,
                        this.graph._edgePathGroup,
                        this.graph._edgePathHitTestGroup,
                        this.graph._edgeLabelGroup
                    );
                    label.update();
                }
            } catch (e) {
                // Building failed, skip this edge
                console.warn(`Failed to build edge ${edge.v}:${edge.w}:`, e);
                // Don't throw - gracefully handle the error
            }
        }
    }

    /**
     * Unload invisible nodes
     */
    unloadInvisibleNodes(visibleNodeIds) {
        const toUnload = [];
        for (const [nodeId, nodeData] of this.loadedNodes) {
            if (!visibleNodeIds.has(nodeId)) {
                toUnload.push(nodeId);
            }
        }
        
        // Remove DOM elements for invisible nodes
        for (const nodeId of toUnload) {
            const nodeData = this.loadedNodes.get(nodeId);
            if (nodeData && nodeData.original && nodeData.original.label && nodeData.original.label.element) {
                try {
                    nodeData.original.label.element.remove();
                } catch (e) {
                    // Element may already be removed
                }
            }
            this.loadedNodes.delete(nodeId);
            this.memoryManager.free(nodeId);
        }
    }

    /**
     * Unload invisible edges
     */
    unloadInvisibleEdges(visibleEdgeIds) {
        const toUnload = [];
        for (const [edgeId, edgeData] of this.loadedEdges) {
            if (!visibleEdgeIds.has(edgeId)) {
                toUnload.push(edgeId);
            }
        }
        
        // Remove DOM elements for invisible edges
        for (const edgeId of toUnload) {
            const edgeData = this.loadedEdges.get(edgeId);
            if (edgeData && edgeData.original && edgeData.original.label) {
                const label = edgeData.original.label;
                try {
                    if (label.element) {
                        label.element.remove();
                    }
                    if (label.hitTest) {
                        label.hitTest.remove();
                    }
                    if (label.labelElement) {
                        label.labelElement.remove();
                    }
                } catch (e) {
                    // Elements may already be removed
                }
            }
            this.loadedEdges.delete(edgeId);
            this.memoryManager.free(edgeId);
        }
    }

    /**
     * Prefetch adjacent tiles
     */
    prefetchAdjacentTiles() {
        if (!this.currentViewport || this.prefetchInProgress) {
            return;
        }
        
        const { x, y, width, height } = this.currentViewport;
        const adjacentTiles = this.spatialIndex.getAdjacentTiles(x, y, width, height);
        
        // Queue prefetch operations
        for (const tileKey of adjacentTiles) {
            if (!this.prefetchQueue.includes(tileKey)) {
                this.prefetchQueue.push(tileKey);
            }
        }
        
        // Process prefetch queue asynchronously
        this.processPrefetchQueue();
    }

    /**
     * Process prefetch queue
     */
    async processPrefetchQueue() {
        if (this.prefetchQueue.length === 0 || this.prefetchInProgress) {
            return;
        }
        
        this.prefetchInProgress = true;
        
        const tileKey = this.prefetchQueue.shift();
        const tile = this.spatialIndex.tiles.get(tileKey);
        
        if (tile) {
            // Prefetch in background without blocking
            if (typeof requestIdleCallback !== 'undefined') {
                requestIdleCallback(async () => {
                    const nodes = new Set();
                    const edges = new Set();
                    
                    for (const itemId of tile) {
                        if (this.layoutData.nodes[itemId]) {
                            nodes.add(itemId);
                        } else if (this.layoutData.edges[itemId]) {
                            edges.add(itemId);
                        }
                    }
                    
                    await this.loadNodes(nodes);
                    await this.loadEdges(edges);
                    
                    this.prefetchInProgress = false;
                    
                    // Continue processing queue
                    if (this.prefetchQueue.length > 0) {
                        setTimeout(() => this.processPrefetchQueue(), 100);
                    }
                });
            } else {
                // Fallback without requestIdleCallback
                setTimeout(async () => {
                    const nodes = new Set();
                    const edges = new Set();
                    
                    for (const itemId of tile) {
                        if (this.layoutData.nodes[itemId]) {
                            nodes.add(itemId);
                        } else if (this.layoutData.edges[itemId]) {
                            edges.add(itemId);
                        }
                    }
                    
                    await this.loadNodes(nodes);
                    await this.loadEdges(edges);
                    
                    this.prefetchInProgress = false;
                    
                    // Continue processing queue
                    if (this.prefetchQueue.length > 0) {
                        setTimeout(() => this.processPrefetchQueue(), 100);
                    }
                }, 100);
            }
        } else {
            this.prefetchInProgress = false;
            
            // Continue processing queue
            if (this.prefetchQueue.length > 0) {
                setTimeout(() => this.processPrefetchQueue(), 100);
            }
        }
    }

    /**
     * Get loaded node count
     */
    getLoadedNodeCount() {
        return this.loadedNodes.size;
    }

    /**
     * Get loaded edge count
     */
    getLoadedEdgeCount() {
        return this.loadedEdges.size;
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            totalNodes: Object.keys(this.layoutData?.nodes || {}).length,
            totalEdges: Object.keys(this.layoutData?.edges || {}).length,
            loadedNodes: this.loadedNodes.size,
            loadedEdges: this.loadedEdges.size,
            prefetchQueueSize: this.prefetchQueue.length,
            spatialIndexStats: this.spatialIndex.getStats()
        };
    }

    /**
     * Clear all loaded data
     */
    clear() {
        this.unloadInvisibleNodes(new Set());
        this.unloadInvisibleEdges(new Set());
        this.prefetchQueue = [];
        this.renderCache.clear();
    }
}
