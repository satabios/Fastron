/**
 * Memory Manager
 * Manages memory usage with LRU cache and automatic cleanup
 */

export class MemoryManager {
    constructor(maxMemoryMB = 500) {
        this.maxMemory = maxMemoryMB * 1024 * 1024; // Convert to bytes
        this.currentMemory = 0;
        this.loadedResources = new Map();
        this.lruCache = [];
        this.memoryEstimates = {
            node: 1024,        // 1KB per node
            edge: 512,         // 512B per edge
            tensor: 4096,      // 4KB per tensor metadata
            element: 2048      // 2KB per DOM element
        };
    }

    /**
     * Allocate memory for a resource
     */
    allocate(resourceId, size, data, type = 'generic') {
        // Check if we need to free memory
        while (this.currentMemory + size > this.maxMemory && this.lruCache.length > 0) {
            this.evictLRU();
        }
        
        // If still not enough memory, force cleanup
        if (this.currentMemory + size > this.maxMemory) {
            this.forceCleanup(size);
        }
        
        this.loadedResources.set(resourceId, {
            size,
            data,
            type,
            lastAccess: Date.now(),
            accessCount: 0
        });
        
        this.currentMemory += size;
        this.updateLRU(resourceId);
    }

    /**
     * Access a resource (updates LRU)
     */
    access(resourceId) {
        const resource = this.loadedResources.get(resourceId);
        if (resource) {
            resource.lastAccess = Date.now();
            resource.accessCount++;
            this.updateLRU(resourceId);
            return resource.data;
        }
        return null;
    }

    /**
     * Check if a resource is loaded
     */
    has(resourceId) {
        return this.loadedResources.has(resourceId);
    }

    /**
     * Free a specific resource
     */
    free(resourceId) {
        const resource = this.loadedResources.get(resourceId);
        if (!resource) {
            return false;
        }
        
        this.currentMemory -= resource.size;
        this.loadedResources.delete(resourceId);
        
        // Remove from LRU cache
        const index = this.lruCache.indexOf(resourceId);
        if (index > -1) {
            this.lruCache.splice(index, 1);
        }
        
        // Clean up DOM elements
        if (resource.data && resource.data.element) {
            try {
                resource.data.element.remove();
            } catch (e) {
                // Element may already be removed
            }
        }
        
        return true;
    }

    /**
     * Evict least recently used resource
     */
    evictLRU() {
        if (this.lruCache.length === 0) {
            return false;
        }
        
        const resourceId = this.lruCache.shift();
        return this.free(resourceId);
    }

    /**
     * Force cleanup to free specified amount of memory
     */
    forceCleanup(requiredSize) {
        let freedMemory = 0;
        const toRemove = [];
        
        // Sort by last access time (oldest first)
        const sorted = Array.from(this.loadedResources.entries())
            .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
        
        for (const [resourceId, resource] of sorted) {
            if (freedMemory >= requiredSize) {
                break;
            }
            toRemove.push(resourceId);
            freedMemory += resource.size;
        }
        
        for (const resourceId of toRemove) {
            this.free(resourceId);
        }
    }

    /**
     * Update LRU cache
     */
    updateLRU(resourceId) {
        // Remove from current position
        const index = this.lruCache.indexOf(resourceId);
        if (index > -1) {
            this.lruCache.splice(index, 1);
        }
        // Add to end (most recently used)
        this.lruCache.push(resourceId);
    }

    /**
     * Cleanup resources not in visible set
     */
    cleanup(visibleResources, maxAge = 30000) {
        const now = Date.now();
        const toRemove = [];
        
        for (const [resourceId, resource] of this.loadedResources) {
            if (!visibleResources.has(resourceId)) {
                const timeSinceAccess = now - resource.lastAccess;
                // Evict if not accessed for maxAge milliseconds
                if (timeSinceAccess > maxAge) {
                    toRemove.push(resourceId);
                }
            }
        }
        
        for (const resourceId of toRemove) {
            this.free(resourceId);
        }
        
        return toRemove.length;
    }

    /**
     * Estimate size for a resource type
     */
    estimateSize(type, data) {
        if (this.memoryEstimates[type]) {
            return this.memoryEstimates[type];
        }
        
        // Try to estimate from data
        if (data) {
            if (data.element) {
                return this.memoryEstimates.element;
            }
            if (typeof data === 'string') {
                return data.length * 2; // UTF-16
            }
            if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
                return data.byteLength || data.length;
            }
            // Estimate object size
            if (typeof data === 'object') {
                try {
                    const jsonSize = JSON.stringify(data).length;
                    return jsonSize * 2;
                } catch (e) {
                    // Circular reference or non-serializable, use default
                    return this.memoryEstimates[type] || 1024;
                }
            }
        }
        
        return 1024; // Default 1KB
    }

    /**
     * Get memory usage statistics
     */
    getMemoryUsage() {
        const byType = {};
        for (const [, resource] of this.loadedResources) {
            byType[resource.type] = (byType[resource.type] || 0) + resource.size;
        }
        
        return {
            current: this.currentMemory,
            max: this.maxMemory,
            percentage: (this.currentMemory / this.maxMemory) * 100,
            resourceCount: this.loadedResources.size,
            byType,
            available: this.maxMemory - this.currentMemory
        };
    }

    /**
     * Get detailed statistics
     */
    getStats() {
        const usage = this.getMemoryUsage();
        const resources = Array.from(this.loadedResources.entries());
        
        return {
            ...usage,
            lruCacheSize: this.lruCache.length,
            oldestAccess: resources.length > 0 
                ? Math.min(...resources.map(([, r]) => r.lastAccess))
                : null,
            newestAccess: resources.length > 0
                ? Math.max(...resources.map(([, r]) => r.lastAccess))
                : null,
            avgAccessCount: resources.length > 0
                ? resources.reduce((sum, [, r]) => sum + r.accessCount, 0) / resources.length
                : 0
        };
    }

    /**
     * Clear all resources
     */
    clear() {
        for (const [resourceId] of this.loadedResources) {
            this.free(resourceId);
        }
        this.lruCache = [];
        this.currentMemory = 0;
    }

    /**
     * Set memory limit
     */
    setMemoryLimit(maxMemoryMB) {
        this.maxMemory = maxMemoryMB * 1024 * 1024;
        
        // Cleanup if over limit
        if (this.currentMemory > this.maxMemory) {
            this.forceCleanup(this.currentMemory - this.maxMemory);
        }
    }
}
