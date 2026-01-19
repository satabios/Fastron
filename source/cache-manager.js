
/**
 * Cache Manager
 * Multi-level caching system for improved performance
 */

export const CacheManager = class {

    constructor(maxMemoryMB = 500) {
        this._memoryCache = new Map();
        this._cacheKeys = []; // LRU tracking
        this._maxMemoryBytes = maxMemoryMB * 1024 * 1024;
        this._currentMemoryBytes = 0;
        this._stats = {
            hits: 0,
            misses: 0,
            evictions: 0,
            totalBytesServed: 0
        };
        this._enabled = true;
    }

    /**
     * Get item from cache
     */
    get(key) {
        if (!this._enabled) {
            return null;
        }

        const entry = this._memoryCache.get(key);
        if (entry) {
            // Update LRU - move to end
            const index = this._cacheKeys.indexOf(key);
            if (index > -1) {
                this._cacheKeys.splice(index, 1);
            }
            this._cacheKeys.push(key);

            // Update stats
            this._stats.hits++;
            this._stats.totalBytesServed += entry.size;

            return entry.data;
        }

        this._stats.misses++;
        return null;
    }

    /**
     * Set item in cache
     */
    set(key, data) {
        if (!this._enabled || !data) {
            return;
        }

        const size = data.byteLength || data.length || 0;

        // Don't cache if item is larger than max cache size
        if (size > this._maxMemoryBytes) {
            return;
        }

        // Evict items if necessary
        while (this._currentMemoryBytes + size > this._maxMemoryBytes && this._cacheKeys.length > 0) {
            this._evictOldest();
        }

        // Remove existing entry if present
        if (this._memoryCache.has(key)) {
            const oldEntry = this._memoryCache.get(key);
            this._currentMemoryBytes -= oldEntry.size;
            const index = this._cacheKeys.indexOf(key);
            if (index > -1) {
                this._cacheKeys.splice(index, 1);
            }
        }

        // Add new entry
        this._memoryCache.set(key, {
            data,
            size,
            timestamp: Date.now()
        });
        this._cacheKeys.push(key);
        this._currentMemoryBytes += size;
    }

    /**
     * Check if key exists in cache
     */
    has(key) {
        return this._enabled && this._memoryCache.has(key);
    }

    /**
     * Delete specific key
     */
    delete(key) {
        if (this._memoryCache.has(key)) {
            const entry = this._memoryCache.get(key);
            this._currentMemoryBytes -= entry.size;
            this._memoryCache.delete(key);

            const index = this._cacheKeys.indexOf(key);
            if (index > -1) {
                this._cacheKeys.splice(index, 1);
            }
        }
    }

    /**
     * Clear all cache
     */
    clear() {
        this._memoryCache.clear();
        this._cacheKeys = [];
        this._currentMemoryBytes = 0;
    }

    /**
     * Get cache statistics
     */
    getStats() {
        const hitRate = this._stats.hits + this._stats.misses > 0
            ? (this._stats.hits / (this._stats.hits + this._stats.misses) * 100).toFixed(1)
            : 0;

        return {
            enabled: this._enabled,
            entries: this._memoryCache.size,
            memoryUsedMB: (this._currentMemoryBytes / (1024 * 1024)).toFixed(2),
            memoryLimitMB: (this._maxMemoryBytes / (1024 * 1024)).toFixed(0),
            memoryUsagePercent: ((this._currentMemoryBytes / this._maxMemoryBytes) * 100).toFixed(1),
            hits: this._stats.hits,
            misses: this._stats.misses,
            hitRate: `${hitRate}%`,
            evictions: this._stats.evictions,
            totalBytesServedMB: (this._stats.totalBytesServed / (1024 * 1024)).toFixed(2)
        };
    }

    /**
     * Set cache enabled/disabled
     */
    setEnabled(enabled) {
        this._enabled = enabled;
        if (!enabled) {
            this.clear();
        }
    }

    /**
     * Set memory limit
     */
    setMemoryLimit(maxMemoryMB) {
        this._maxMemoryBytes = maxMemoryMB * 1024 * 1024;

        // Evict if over limit
        while (this._currentMemoryBytes > this._maxMemoryBytes && this._cacheKeys.length > 0) {
            this._evictOldest();
        }
    }

    /**
     * Evict oldest (LRU) item
     */
    _evictOldest() {
        if (this._cacheKeys.length === 0) {
            return;
        }

        const oldestKey = this._cacheKeys.shift();
        const entry = this._memoryCache.get(oldestKey);

        if (entry) {
            this._currentMemoryBytes -= entry.size;
            this._memoryCache.delete(oldestKey);
            this._stats.evictions++;
        }
    }

    /**
     * Get cache key for file
     */
    static getCacheKey(file) {
        // Use file name/path as cache key
        if (typeof file === 'string') {
            return file;
        }
        if (file instanceof File) {
            return `${file.name}:${file.size}:${file.lastModified}`;
        }
        return JSON.stringify(file);
    }
};
