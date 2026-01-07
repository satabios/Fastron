/**
 * Viewport Manager
 * Central controller for viewport-based rendering optimization
 * Implements tile-based progressive loading similar to Google Earth
 */

export class ViewportManager {
    constructor(graph, options = {}) {
        this.graph = graph;
        this.options = {
            tileSize: options.tileSize || 1000,
            bufferZones: options.bufferZones || 1,
            debounceDelay: options.debounceDelay || 100,
            enablePrefetch: options.enablePrefetch !== false,
            enableLOD: options.enableLOD !== false,
            maxMemoryMB: options.maxMemoryMB || 500,
            adaptiveQuality: options.adaptiveQuality !== false,
            ...options
        };
        
        // Core viewport state
        this.viewport = {
            x: 0,
            y: 0,
            width: 0,
            height: 0,
            zoom: 1,
            rotation: 0
        };
        
        // Viewport change tracking
        this.lastViewport = { ...this.viewport };
        this.viewportChangeCallbacks = [];
        this.debounceTimer = null;
        this.isUpdating = false;
        
        // Tile management
        this.activeTiles = new Set();
        this.loadingTiles = new Set();
        this.loadedTiles = new Map();
        this.tileLoadQueue = [];
        
        // Container reference
        this.container = null;
        this.svgElement = null;
        this.transformGroup = null;
        
        // Event listeners
        this.boundHandlers = {
            wheel: null,
            scroll: null,
            resize: null,
            pan: null,
            zoom: null
        };
        
        // Performance tracking
        this.stats = {
            viewportUpdates: 0,
            tilesLoaded: 0,
            tilesUnloaded: 0,
            nodesRendered: 0,
            edgesRendered: 0,
            lastUpdateTime: 0,
            avgUpdateTime: 0
        };
        
        // Initialization state
        this.initialized = false;
    }

    /**
     * Initialize viewport manager with container
     */
    async initialize(container) {
        if (this.initialized) {
            console.warn('[ViewportManager] Already initialized');
            return;
        }
        
        this.container = container;
        
        // Find or create SVG element
        this.svgElement = container.querySelector('svg');
        if (!this.svgElement) {
            this.svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            this.svgElement.setAttribute('class', 'graph-viewport');
            this.svgElement.style.cssText = 'width: 100%; height: 100%; position: absolute; top: 0; left: 0;';
            container.appendChild(this.svgElement);
        }
        
        // Find or create transform group
        this.transformGroup = this.svgElement.querySelector('g.graph-transform');
        if (!this.transformGroup) {
            this.transformGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            this.transformGroup.setAttribute('class', 'graph-transform');
            this.svgElement.appendChild(this.transformGroup);
        }
        
        // Initialize viewport from container
        this.updateViewportDimensions();
        
        // Setup event listeners
        this.setupEventListeners();
        
        // Initial viewport update
        await this.updateViewport();
        
        this.initialized = true;
        console.log('[ViewportManager] Initialized', this.viewport);
    }

    /**
     * Setup event listeners for viewport changes
     */
    setupEventListeners() {
        // Wheel event for zoom
        this.boundHandlers.wheel = this.handleWheel.bind(this);
        this.container.addEventListener('wheel', this.boundHandlers.wheel, { passive: false });
        
        // Resize observer for container size changes
        if (typeof ResizeObserver !== 'undefined') {
            this.resizeObserver = new ResizeObserver(() => {
                this.updateViewportDimensions();
                this.debouncedViewportUpdate();
            });
            this.resizeObserver.observe(this.container);
        } else {
            // Fallback to window resize
            this.boundHandlers.resize = () => {
                this.updateViewportDimensions();
                this.debouncedViewportUpdate();
            };
            window.addEventListener('resize', this.boundHandlers.resize);
        }
        
        // Pan detection via transform changes
        this.setupTransformObserver();
        
        // Scroll events (if container is scrollable)
        this.boundHandlers.scroll = () => {
            this.debouncedViewportUpdate();
        };
        this.container.addEventListener('scroll', this.boundHandlers.scroll);
    }

    /**
     * Setup MutationObserver to detect transform changes
     */
    setupTransformObserver() {
        if (typeof MutationObserver === 'undefined') {
            return;
        }
        
        this.transformObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.type === 'attributes' && mutation.attributeName === 'transform') {
                    this.extractTransformFromDOM();
                    this.debouncedViewportUpdate();
                    break;
                }
            }
        });
        
        if (this.transformGroup) {
            this.transformObserver.observe(this.transformGroup, {
                attributes: true,
                attributeFilter: ['transform']
            });
        }
    }

    /**
     * Handle wheel event for zoom detection
     */
    handleWheel(event) {
        // Extract zoom information if available
        // This is a simplified version - actual implementation depends on zoom library
        this.debouncedViewportUpdate();
    }

    /**
     * Update viewport dimensions from container
     */
    updateViewportDimensions() {
        if (!this.container) return;
        
        const rect = this.container.getBoundingClientRect();
        this.viewport.width = rect.width;
        this.viewport.height = rect.height;
    }

    /**
     * Extract transform from DOM
     */
    extractTransformFromDOM() {
        if (!this.transformGroup) return;
        
        const transform = this.transformGroup.getAttribute('transform');
        if (!transform) return;
        
        // Parse transform string
        // Format: translate(x, y) scale(s) or matrix(...)
        const translateMatch = transform.match(/translate\(([^,]+),\s*([^)]+)\)/);
        const scaleMatch = transform.match(/scale\(([^)]+)\)/);
        const matrixMatch = transform.match(/matrix\(([^)]+)\)/);
        
        if (matrixMatch) {
            // Parse matrix transform
            const values = matrixMatch[1].split(/[\s,]+/).map(parseFloat);
            if (values.length === 6) {
                // matrix(a, b, c, d, e, f)
                // a = scale x, d = scale y, e = translate x, f = translate y
                this.viewport.zoom = values[0]; // Assuming uniform scale
                this.viewport.x = -values[4] / values[0];
                this.viewport.y = -values[5] / values[0];
            }
        } else {
            if (translateMatch) {
                const tx = parseFloat(translateMatch[1]);
                const ty = parseFloat(translateMatch[2]);
                const scale = this.viewport.zoom || 1;
                this.viewport.x = -tx / scale;
                this.viewport.y = -ty / scale;
            }
            
            if (scaleMatch) {
                this.viewport.zoom = parseFloat(scaleMatch[1]);
            }
        }
    }

    /**
     * Debounced viewport update
     */
    debouncedViewportUpdate() {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        
        this.debounceTimer = setTimeout(() => {
            this.updateViewport();
        }, this.options.debounceDelay);
    }

    /**
     * Update viewport and trigger rendering
     */
    async updateViewport(force = false) {
        if (this.isUpdating && !force) {
            return;
        }
        
        this.isUpdating = true;
        const startTime = performance.now();
        
        try {
            // Extract current transform
            this.extractTransformFromDOM();
            
            // Check if viewport actually changed
            if (!force && !this.hasViewportChanged()) {
                this.isUpdating = false;
                return;
            }
            
            // Calculate visible tiles
            const visibleTiles = this.calculateVisibleTiles();
            
            // Determine tiles to load and unload
            const tilesToLoad = this.getTilesToLoad(visibleTiles);
            const tilesToUnload = this.getTilesToUnload(visibleTiles);
            
            // Unload invisible tiles first to free memory
            await this.unloadTiles(tilesToUnload);
            
            // Load visible tiles
            await this.loadTiles(tilesToLoad);
            
            // Update active tiles
            this.activeTiles = visibleTiles;
            
            // Prefetch adjacent tiles if enabled
            if (this.options.enablePrefetch) {
                this.prefetchAdjacentTiles(visibleTiles);
            }
            
            // Update last viewport
            this.lastViewport = { ...this.viewport };
            
            // Update stats
            this.stats.viewportUpdates++;
            const updateTime = performance.now() - startTime;
            this.stats.lastUpdateTime = updateTime;
            this.stats.avgUpdateTime = (this.stats.avgUpdateTime * (this.stats.viewportUpdates - 1) + updateTime) / this.stats.viewportUpdates;
            
            // Notify listeners
            this.notifyViewportChange();
            
        } catch (error) {
            console.error('[ViewportManager] Error updating viewport:', error);
        } finally {
            this.isUpdating = false;
        }
    }

    /**
     * Check if viewport has changed significantly
     */
    hasViewportChanged(threshold = 10) {
        const dx = Math.abs(this.viewport.x - this.lastViewport.x);
        const dy = Math.abs(this.viewport.y - this.lastViewport.y);
        const dw = Math.abs(this.viewport.width - this.lastViewport.width);
        const dh = Math.abs(this.viewport.height - this.lastViewport.height);
        const dz = Math.abs(this.viewport.zoom - this.lastViewport.zoom);
        
        return dx > threshold || dy > threshold || dw > threshold || dh > threshold || dz > 0.01;
    }

    /**
     * Calculate visible tiles based on current viewport
     */
    calculateVisibleTiles() {
        const { x, y, width, height, zoom } = this.viewport;
        const { tileSize, bufferZones } = this.options;
        
        // Calculate viewport bounds in world coordinates
        const viewportMinX = x;
        const viewportMinY = y;
        const viewportMaxX = x + width / zoom;
        const viewportMaxY = y + height / zoom;
        
        // Add buffer zones
        const bufferSize = tileSize * bufferZones;
        const minX = viewportMinX - bufferSize;
        const minY = viewportMinY - bufferSize;
        const maxX = viewportMaxX + bufferSize;
        const maxY = viewportMaxY + bufferSize;
        
        // Calculate tile coordinates
        const minTileX = Math.floor(minX / tileSize);
        const minTileY = Math.floor(minY / tileSize);
        const maxTileX = Math.floor(maxX / tileSize);
        const maxTileY = Math.floor(maxY / tileSize);
        
        // Generate tile keys
        const tiles = new Set();
        for (let tx = minTileX; tx <= maxTileX; tx++) {
            for (let ty = minTileY; ty <= maxTileY; ty++) {
                tiles.add(`${tx}:${ty}`);
            }
        }
        
        return tiles;
    }

    /**
     * Get tiles that need to be loaded
     */
    getTilesToLoad(visibleTiles) {
        const tilesToLoad = [];
        
        for (const tileKey of visibleTiles) {
            if (!this.loadedTiles.has(tileKey) && !this.loadingTiles.has(tileKey)) {
                tilesToLoad.push(tileKey);
            }
        }
        
        // Sort by distance from viewport center
        tilesToLoad.sort((a, b) => {
            const distA = this.getTileDistanceFromCenter(a);
            const distB = this.getTileDistanceFromCenter(b);
            return distA - distB;
        });
        
        return tilesToLoad;
    }

    /**
     * Get tiles that should be unloaded
     */
    getTilesToUnload(visibleTiles) {
        const tilesToUnload = [];
        
        for (const tileKey of this.loadedTiles.keys()) {
            if (!visibleTiles.has(tileKey)) {
                tilesToUnload.push(tileKey);
            }
        }
        
        return tilesToUnload;
    }

    /**
     * Calculate distance of tile from viewport center
     */
    getTileDistanceFromCenter(tileKey) {
        const [tx, ty] = tileKey.split(':').map(Number);
        const { tileSize } = this.options;
        
        const tileCenterX = (tx + 0.5) * tileSize;
        const tileCenterY = (ty + 0.5) * tileSize;
        
        const viewportCenterX = this.viewport.x + this.viewport.width / (2 * this.viewport.zoom);
        const viewportCenterY = this.viewport.y + this.viewport.height / (2 * this.viewport.zoom);
        
        const dx = tileCenterX - viewportCenterX;
        const dy = tileCenterY - viewportCenterY;
        
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Load tiles
     */
    async loadTiles(tileKeys) {
        if (tileKeys.length === 0) return;
        
        // Mark tiles as loading
        for (const tileKey of tileKeys) {
            this.loadingTiles.add(tileKey);
        }
        
        // Load tiles in batches to avoid blocking
        const batchSize = 5;
        for (let i = 0; i < tileKeys.length; i += batchSize) {
            const batch = tileKeys.slice(i, i + batchSize);
            
            await Promise.all(batch.map(async (tileKey) => {
                try {
                    await this.loadTile(tileKey);
                    this.loadedTiles.set(tileKey, {
                        key: tileKey,
                        loadedAt: Date.now(),
                        nodes: new Set(),
                        edges: new Set()
                    });
                    this.stats.tilesLoaded++;
                } catch (error) {
                    console.error(`[ViewportManager] Failed to load tile ${tileKey}:`, error);
                } finally {
                    this.loadingTiles.delete(tileKey);
                }
            }));
            
            // Yield to browser between batches
            if (i + batchSize < tileKeys.length) {
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
    }

    /**
     * Load a single tile
     */
    async loadTile(tileKey) {
        // Get items in this tile from spatial index
        if (!this.graph._spatialIndex) {
            return;
        }
        
        const [tx, ty] = tileKey.split(':').map(Number);
        const { tileSize } = this.options;
        
        const tileX = tx * tileSize;
        const tileY = ty * tileSize;
        
        // Query spatial index for items in this tile
        const items = this.graph._spatialIndex.queryViewport(
            tileX,
            tileY,
            tileSize,
            tileSize,
            0 // No buffer for individual tile loading
        );
        
        // Separate nodes and edges
        const nodes = new Set();
        const edges = new Set();
        
        for (const itemId of items) {
            if (this.graph._lazyManager?.layoutData?.nodes[itemId]) {
                nodes.add(itemId);
            } else if (this.graph._lazyManager?.layoutData?.edges[itemId]) {
                edges.add(itemId);
            }
        }
        
        // Load nodes and edges through lazy manager
        if (this.graph._lazyManager) {
            await this.graph._lazyManager.loadNodes(nodes);
            await this.graph._lazyManager.loadEdges(edges);
        }
        
        // Store tile data
        const tileData = this.loadedTiles.get(tileKey) || { nodes: new Set(), edges: new Set() };
        tileData.nodes = nodes;
        tileData.edges = edges;
        this.loadedTiles.set(tileKey, tileData);
        
        this.stats.nodesRendered += nodes.size;
        this.stats.edgesRendered += edges.size;
    }

    /**
     * Unload tiles
     */
    async unloadTiles(tileKeys) {
        for (const tileKey of tileKeys) {
            await this.unloadTile(tileKey);
            this.loadedTiles.delete(tileKey);
            this.stats.tilesUnloaded++;
        }
    }

    /**
     * Unload a single tile
     */
    async unloadTile(tileKey) {
        const tileData = this.loadedTiles.get(tileKey);
        if (!tileData) return;
        
        // Unload nodes and edges through lazy manager
        if (this.graph._lazyManager) {
            this.graph._lazyManager.unloadInvisibleNodes(new Set());
            this.graph._lazyManager.unloadInvisibleEdges(new Set());
        }
        
        this.stats.nodesRendered -= tileData.nodes.size;
        this.stats.edgesRendered -= tileData.edges.size;
    }

    /**
     * Prefetch adjacent tiles
     */
    prefetchAdjacentTiles(visibleTiles) {
        const adjacentTiles = new Set();
        
        for (const tileKey of visibleTiles) {
            const [tx, ty] = tileKey.split(':').map(Number);
            
            // Add 8 surrounding tiles
            for (let dx = -1; dx <= 1; dx++) {
                for (let dy = -1; dy <= 1; dy++) {
                    if (dx === 0 && dy === 0) continue;
                    const adjacentKey = `${tx + dx}:${ty + dy}`;
                    if (!visibleTiles.has(adjacentKey) && !this.loadedTiles.has(adjacentKey)) {
                        adjacentTiles.add(adjacentKey);
                    }
                }
            }
        }
        
        // Queue prefetch operations
        for (const tileKey of adjacentTiles) {
            if (!this.tileLoadQueue.includes(tileKey)) {
                this.tileLoadQueue.push(tileKey);
            }
        }
        
        // Process queue in background
        this.processPrefetchQueue();
    }

    /**
     * Process prefetch queue
     */
    async processPrefetchQueue() {
        if (this.tileLoadQueue.length === 0 || this.isUpdating) {
            return;
        }
        
        // Use requestIdleCallback if available
        const processNext = async () => {
            if (this.tileLoadQueue.length === 0) return;
            
            const tileKey = this.tileLoadQueue.shift();
            
            // Only prefetch if not already loaded or loading
            if (!this.loadedTiles.has(tileKey) && !this.loadingTiles.has(tileKey)) {
                try {
                    await this.loadTile(tileKey);
                    this.loadedTiles.set(tileKey, {
                        key: tileKey,
                        loadedAt: Date.now(),
                        prefetched: true
                    });
                } catch (error) {
                    // Silently fail prefetch
                }
            }
            
            // Continue processing queue
            if (this.tileLoadQueue.length > 0) {
                if (typeof requestIdleCallback !== 'undefined') {
                    requestIdleCallback(processNext);
                } else {
                    setTimeout(processNext, 100);
                }
            }
        };
        
        if (typeof requestIdleCallback !== 'undefined') {
            requestIdleCallback(processNext);
        } else {
            setTimeout(processNext, 100);
        }
    }

    /**
     * Register viewport change callback
     */
    onViewportChange(callback) {
        this.viewportChangeCallbacks.push(callback);
    }

    /**
     * Notify viewport change listeners
     */
    notifyViewportChange() {
        const viewportInfo = {
            ...this.viewport,
            activeTiles: this.activeTiles.size,
            loadedTiles: this.loadedTiles.size,
            visibleNodes: this.stats.nodesRendered,
            visibleEdges: this.stats.edgesRendered
        };
        
        for (const callback of this.viewportChangeCallbacks) {
            try {
                callback(viewportInfo);
            } catch (error) {
                console.error('[ViewportManager] Error in viewport change callback:', error);
            }
        }
    }

    /**
     * Get current viewport info
     */
    getViewportInfo() {
        return {
            viewport: { ...this.viewport },
            activeTiles: this.activeTiles.size,
            loadedTiles: this.loadedTiles.size,
            loadingTiles: this.loadingTiles.size,
            stats: { ...this.stats }
        };
    }

    /**
     * Get statistics
     */
    getStats() {
        return {
            ...this.stats,
            activeTiles: this.activeTiles.size,
            loadedTiles: this.loadedTiles.size,
            loadingTiles: this.loadingTiles.size,
            prefetchQueueSize: this.tileLoadQueue.length,
            memoryUsage: this.graph._memoryManager?.getMemoryUsage() || null
        };
    }

    /**
     * Force viewport update
     */
    forceUpdate() {
        return this.updateViewport(true);
    }

    /**
     * Set viewport programmatically
     */
    setViewport(x, y, zoom) {
        this.viewport.x = x;
        this.viewport.y = y;
        this.viewport.zoom = zoom;
        
        // Update transform group
        if (this.transformGroup) {
            const tx = -x * zoom;
            const ty = -y * zoom;
            this.transformGroup.setAttribute('transform', `translate(${tx}, ${ty}) scale(${zoom})`);
        }
        
        return this.updateViewport(true);
    }

    /**
     * Cleanup and destroy
     */
    destroy() {
        // Remove event listeners
        if (this.boundHandlers.wheel) {
            this.container.removeEventListener('wheel', this.boundHandlers.wheel);
        }
        if (this.boundHandlers.scroll) {
            this.container.removeEventListener('scroll', this.boundHandlers.scroll);
        }
        if (this.boundHandlers.resize) {
            window.removeEventListener('resize', this.boundHandlers.resize);
        }
        
        // Disconnect observers
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
        }
        if (this.transformObserver) {
            this.transformObserver.disconnect();
        }
        
        // Clear timers
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
        }
        
        // Clear tiles
        this.activeTiles.clear();
        this.loadingTiles.clear();
        this.loadedTiles.clear();
        this.tileLoadQueue = [];
        
        this.initialized = false;
    }
}
