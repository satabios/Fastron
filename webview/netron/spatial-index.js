/**
 * Spatial indexing system for viewport-based rendering
 * Divides the graph into tiles for efficient querying
 */

export class SpatialIndex {
    constructor(tileSize = 1000) {
        this.tileSize = tileSize;
        this.tiles = new Map(); // Map<tileKey, Set<nodeId>>
        this.nodeBounds = new Map(); // Map<nodeId, {x, y, width, height}>
        this.edgeBounds = new Map(); // Map<edgeId, {minX, minY, maxX, maxY}>
    }

    /**
     * Convert world coordinates to tile coordinates
     */
    getTileKey(x, y) {
        const tileX = Math.floor(x / this.tileSize);
        const tileY = Math.floor(y / this.tileSize);
        return `${tileX}:${tileY}`;
    }

    /**
     * Index a node into spatial tiles
     */
    indexNode(nodeId, x, y, width, height) {
        const bounds = { x, y, width, height };
        this.nodeBounds.set(nodeId, bounds);

        // Calculate which tiles this node overlaps
        const minTileX = Math.floor((x - width / 2) / this.tileSize);
        const maxTileX = Math.floor((x + width / 2) / this.tileSize);
        const minTileY = Math.floor((y - height / 2) / this.tileSize);
        const maxTileY = Math.floor((y + height / 2) / this.tileSize);

        for (let tx = minTileX; tx <= maxTileX; tx++) {
            for (let ty = minTileY; ty <= maxTileY; ty++) {
                const key = `${tx}:${ty}`;
                if (!this.tiles.has(key)) {
                    this.tiles.set(key, new Set());
                }
                this.tiles.get(key).add(nodeId);
            }
        }
    }

    /**
     * Index an edge into spatial tiles
     */
    indexEdge(edgeId, points) {
        if (!points || points.length === 0) return;

        let minX = Infinity, minY = Infinity;
        let maxX = -Infinity, maxY = -Infinity;

        for (const point of points) {
            minX = Math.min(minX, point.x);
            minY = Math.min(minY, point.y);
            maxX = Math.max(maxX, point.x);
            maxY = Math.max(maxY, point.y);
        }

        this.edgeBounds.set(edgeId, { minX, minY, maxX, maxY });

        // Index edge into tiles it overlaps
        const minTileX = Math.floor(minX / this.tileSize);
        const maxTileX = Math.floor(maxX / this.tileSize);
        const minTileY = Math.floor(minY / this.tileSize);
        const maxTileY = Math.floor(maxY / this.tileSize);

        for (let tx = minTileX; tx <= maxTileX; tx++) {
            for (let ty = minTileY; ty <= maxTileY; ty++) {
                const key = `${tx}:${ty}`;
                if (!this.tiles.has(key)) {
                    this.tiles.set(key, new Set());
                }
                this.tiles.get(key).add(edgeId);
            }
        }
    }

    /**
     * Query nodes within viewport with optional buffer
     */
    queryViewport(viewportX, viewportY, viewportWidth, viewportHeight, buffer = 1) {
        const minTileX = Math.floor((viewportX - buffer * this.tileSize) / this.tileSize);
        const maxTileX = Math.floor((viewportX + viewportWidth + buffer * this.tileSize) / this.tileSize);
        const minTileY = Math.floor((viewportY - buffer * this.tileSize) / this.tileSize);
        const maxTileY = Math.floor((viewportY + viewportHeight + buffer * this.tileSize) / this.tileSize);

        const visibleItems = new Set();
        for (let tx = minTileX; tx <= maxTileX; tx++) {
            for (let ty = minTileY; ty <= maxTileY; ty++) {
                const key = `${tx}:${ty}`;
                const tile = this.tiles.get(key);
                if (tile) {
                    tile.forEach(itemId => visibleItems.add(itemId));
                }
            }
        }
        return visibleItems;
    }

    /**
     * Get adjacent tiles for prefetching
     */
    getAdjacentTiles(viewportX, viewportY, viewportWidth, viewportHeight) {
        const centerTileX = Math.floor((viewportX + viewportWidth / 2) / this.tileSize);
        const centerTileY = Math.floor((viewportY + viewportHeight / 2) / this.tileSize);
        
        const adjacent = [];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                if (dx === 0 && dy === 0) continue;
                adjacent.push(`${centerTileX + dx}:${centerTileY + dy}`);
            }
        }
        return adjacent;
    }

    /**
     * Get bounds for a specific node
     */
    getNodeBounds(nodeId) {
        return this.nodeBounds.get(nodeId);
    }

    /**
     * Get bounds for a specific edge
     */
    getEdgeBounds(edgeId) {
        return this.edgeBounds.get(edgeId);
    }

    /**
     * Clear all indexed data
     */
    clear() {
        this.tiles.clear();
        this.nodeBounds.clear();
        this.edgeBounds.clear();
    }

    /**
     * Get statistics about the spatial index
     */
    getStats() {
        return {
            tileCount: this.tiles.size,
            nodeCount: this.nodeBounds.size,
            edgeCount: this.edgeBounds.size,
            avgItemsPerTile: this.tiles.size > 0 
                ? Array.from(this.tiles.values()).reduce((sum, tile) => sum + tile.size, 0) / this.tiles.size 
                : 0
        };
    }
}
