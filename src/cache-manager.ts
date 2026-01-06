import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as vscode from 'vscode';

/**
 * Cache Entry
 */
interface CacheEntry {
    data: Uint8Array;
    timestamp: number;
    accessCount: number;
    size: number;
    key: string;
}

/**
 * Cache Statistics
 */
interface CacheStats {
    memoryUsage: number;
    diskUsage: number;
    hitRate: number;
    totalHits: number;
    totalMisses: number;
    entryCount: number;
}

/**
 * Multi-Level Cache Manager
 * Implements L1 (memory) and L2 (disk) caching with LRU eviction
 */
export class CacheManager {
    private memoryCache: Map<string, CacheEntry> = new Map();
    private diskCachePath: string;
    private maxMemoryCacheMB: number;
    private maxDiskCacheGB: number;
    private cacheHits: number = 0;
    private cacheMisses: number = 0;
    private enabled: boolean = true;

    constructor(
        context: vscode.ExtensionContext,
        maxMemoryCacheMB: number = 500,
        maxDiskCacheGB: number = 10
    ) {
        this.maxMemoryCacheMB = maxMemoryCacheMB;
        this.maxDiskCacheGB = maxDiskCacheGB;
        this.diskCachePath = path.join(context.globalStorageUri.fsPath, 'model-cache');
        
        // Create cache directory
        this.initializeCacheDirectory();
    }

    /**
     * Initialize cache directory
     */
    private initializeCacheDirectory(): void {
        try {
            if (!fs.existsSync(this.diskCachePath)) {
                fs.mkdirSync(this.diskCachePath, { recursive: true });
            }
        } catch (error) {
            console.error('[CacheManager] Failed to create cache directory:', error);
            this.enabled = false;
        }
    }

    /**
     * Generate cache key from file path or URL
     */
    private generateKey(identifier: string): string {
        return crypto.createHash('sha256').update(identifier).digest('hex');
    }

    /**
     * Get data from cache
     */
    async get(identifier: string): Promise<Uint8Array | null> {
        if (!this.enabled) {
            return null;
        }

        const key = this.generateKey(identifier);

        // L1: Memory cache
        if (this.memoryCache.has(key)) {
            const entry = this.memoryCache.get(key)!;
            entry.accessCount++;
            entry.timestamp = Date.now();
            this.cacheHits++;
            
            console.log(`[CacheManager] Memory cache HIT for ${identifier.substring(0, 50)}...`);
            return entry.data;
        }

        // L2: Disk cache
        const diskPath = this.getDiskPath(key);
        if (fs.existsSync(diskPath)) {
            try {
                const data = await fs.promises.readFile(diskPath);
                const uint8Data = new Uint8Array(data);
                
                // Promote to memory cache if space available
                if (this.canFitInMemory(uint8Data.length)) {
                    this.memoryCache.set(key, {
                        data: uint8Data,
                        timestamp: Date.now(),
                        accessCount: 1,
                        size: uint8Data.length,
                        key: identifier
                    });
                }
                
                this.cacheHits++;
                console.log(`[CacheManager] Disk cache HIT for ${identifier.substring(0, 50)}...`);
                return uint8Data;
            } catch (error) {
                console.error('[CacheManager] Failed to read from disk cache:', error);
            }
        }

        this.cacheMisses++;
        console.log(`[CacheManager] Cache MISS for ${identifier.substring(0, 50)}...`);
        return null;
    }

    /**
     * Store data in cache
     */
    async set(identifier: string, data: Uint8Array): Promise<void> {
        if (!this.enabled) {
            return;
        }

        const key = this.generateKey(identifier);

        // Memory cache
        if (this.canFitInMemory(data.length)) {
            this.evictIfNeeded(data.length);
            this.memoryCache.set(key, {
                data,
                timestamp: Date.now(),
                accessCount: 1,
                size: data.length,
                key: identifier
            });
            console.log(`[CacheManager] Stored in memory cache: ${identifier.substring(0, 50)}... (${this.formatSize(data.length)})`);
        }

        // Disk cache
        try {
            const diskPath = this.getDiskPath(key);
            await fs.promises.writeFile(diskPath, data);
            console.log(`[CacheManager] Stored in disk cache: ${identifier.substring(0, 50)}... (${this.formatSize(data.length)})`);
        } catch (error) {
            console.error('[CacheManager] Failed to write to disk cache:', error);
        }
    }

    /**
     * Check if data can fit in memory cache
     */
    private canFitInMemory(size: number): boolean {
        const currentSize = this.getMemoryCacheSize();
        const maxSize = this.maxMemoryCacheMB * 1024 * 1024;
        return (currentSize + size) <= maxSize;
    }

    /**
     * Get current memory cache size
     */
    private getMemoryCacheSize(): number {
        let total = 0;
        for (const entry of this.memoryCache.values()) {
            total += entry.size;
        }
        return total;
    }

    /**
     * Evict entries if needed (LRU)
     */
    private evictIfNeeded(requiredSize: number): void {
        const maxSize = this.maxMemoryCacheMB * 1024 * 1024;
        let currentSize = this.getMemoryCacheSize();

        if (currentSize + requiredSize <= maxSize) {
            return;
        }

        // Sort by last access time (oldest first)
        const entries = Array.from(this.memoryCache.entries())
            .sort((a, b) => a[1].timestamp - b[1].timestamp);

        for (const [key, entry] of entries) {
            if (currentSize + requiredSize <= maxSize) {
                break;
            }
            
            this.memoryCache.delete(key);
            currentSize -= entry.size;
            console.log(`[CacheManager] Evicted from memory cache: ${entry.key.substring(0, 50)}... (${this.formatSize(entry.size)})`);
        }
    }

    /**
     * Get disk path for cache key
     */
    private getDiskPath(key: string): string {
        return path.join(this.diskCachePath, key);
    }

    /**
     * Clear all caches
     */
    async clear(): Promise<void> {
        // Clear memory cache
        this.memoryCache.clear();
        console.log('[CacheManager] Memory cache cleared');

        // Clear disk cache
        try {
            const files = await fs.promises.readdir(this.diskCachePath);
            for (const file of files) {
                await fs.promises.unlink(path.join(this.diskCachePath, file));
            }
            console.log('[CacheManager] Disk cache cleared');
        } catch (error) {
            console.error('[CacheManager] Failed to clear disk cache:', error);
        }
    }

    /**
     * Clear memory cache only
     */
    clearMemoryCache(): void {
        this.memoryCache.clear();
        console.log('[CacheManager] Memory cache cleared');
    }

    /**
     * Get cache statistics
     */
    getStats(): CacheStats {
        const memoryUsage = this.getMemoryCacheSize();
        const diskUsage = this.getDiskCacheSize();
        const totalRequests = this.cacheHits + this.cacheMisses;
        const hitRate = totalRequests > 0 ? (this.cacheHits / totalRequests) * 100 : 0;

        return {
            memoryUsage,
            diskUsage,
            hitRate,
            totalHits: this.cacheHits,
            totalMisses: this.cacheMisses,
            entryCount: this.memoryCache.size
        };
    }

    /**
     * Get disk cache size
     */
    private getDiskCacheSize(): number {
        try {
            const files = fs.readdirSync(this.diskCachePath);
            let total = 0;
            for (const file of files) {
                const stats = fs.statSync(path.join(this.diskCachePath, file));
                total += stats.size;
            }
            return total;
        } catch (error) {
            return 0;
        }
    }

    /**
     * Format size in human-readable format
     */
    private formatSize(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
        if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
        return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    }

    /**
     * Enable/disable cache
     */
    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
        console.log(`[CacheManager] Cache ${enabled ? 'enabled' : 'disabled'}`);
    }

    /**
     * Set memory cache limit
     */
    setMemoryCacheLimit(limitMB: number): void {
        this.maxMemoryCacheMB = limitMB;
        console.log(`[CacheManager] Memory cache limit set to ${limitMB} MB`);
        
        // Evict if over limit
        const currentSize = this.getMemoryCacheSize();
        const maxSize = limitMB * 1024 * 1024;
        if (currentSize > maxSize) {
            this.evictIfNeeded(0);
        }
    }

    /**
     * Clean up old cache entries
     */
    async cleanupOldEntries(maxAgeDays: number = 30): Promise<number> {
        const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
        const now = Date.now();
        let cleaned = 0;

        try {
            const files = await fs.promises.readdir(this.diskCachePath);
            for (const file of files) {
                const filePath = path.join(this.diskCachePath, file);
                const stats = await fs.promises.stat(filePath);
                
                if (now - stats.mtimeMs > maxAgeMs) {
                    await fs.promises.unlink(filePath);
                    cleaned++;
                }
            }
            
            if (cleaned > 0) {
                console.log(`[CacheManager] Cleaned up ${cleaned} old cache entries`);
            }
        } catch (error) {
            console.error('[CacheManager] Failed to cleanup old entries:', error);
        }

        return cleaned;
    }

    /**
     * Get cache entry info
     */
    async getEntryInfo(identifier: string): Promise<{ exists: boolean; size: number; location: 'memory' | 'disk' | 'none' } | null> {
        const key = this.generateKey(identifier);

        if (this.memoryCache.has(key)) {
            const entry = this.memoryCache.get(key)!;
            return {
                exists: true,
                size: entry.size,
                location: 'memory'
            };
        }

        const diskPath = this.getDiskPath(key);
        if (fs.existsSync(diskPath)) {
            const stats = await fs.promises.stat(diskPath);
            return {
                exists: true,
                size: stats.size,
                location: 'disk'
            };
        }

        return {
            exists: false,
            size: 0,
            location: 'none'
        };
    }
}
