import * as vscode from 'vscode';
import * as path from 'path';
import { StreamingFileReader } from './streaming-file-reader';
import { CacheManager } from './cache-manager';
import { RemoteFileHandler } from './remote-file-handler';

/**
 * Model Load Options
 */
interface ModelLoadOptions {
    useCache?: boolean;
    useStreaming?: boolean;
    chunkSize?: number;
    skipTensorWeights?: boolean;
    onProgress?: (percent: number, message: string) => void;
}

/**
 * Model Load Result
 */
interface ModelLoadResult {
    data: Uint8Array;
    fromCache: boolean;
    loadTime: number;
    size: number;
    source: 'local' | 'remote' | 'cache';
}

/**
 * Optimized Model Loader
 * Integrates streaming, caching, and remote file handling
 */
export class OptimizedModelLoader {
    private cacheManager: CacheManager;
    private remoteFileHandler: RemoteFileHandler;
    private config: vscode.WorkspaceConfiguration;

    constructor(context: vscode.ExtensionContext) {
        this.config = vscode.workspace.getConfiguration('netron');
        
        // Initialize cache manager
        const maxMemoryCacheMB = this.config.get<number>('cache.maxMemoryMB', 500);
        const maxDiskCacheGB = this.config.get<number>('cache.maxDiskGB', 10);
        this.cacheManager = new CacheManager(context, maxMemoryCacheMB, maxDiskCacheGB);

        // Initialize remote file handler
        const chunkSizeMB = this.config.get<number>('loading.chunkSizeMB', 10);
        const parallelConnections = this.config.get<number>('network.parallelConnections', 6);
        this.remoteFileHandler = new RemoteFileHandler(
            chunkSizeMB * 1024 * 1024,
            parallelConnections
        );

        // Enable/disable cache based on config
        const cacheEnabled = this.config.get<boolean>('cache.enabled', true);
        this.cacheManager.setEnabled(cacheEnabled);
    }

    /**
     * Load model from file path or URL
     */
    async loadModel(
        filePathOrUrl: string,
        options: ModelLoadOptions = {}
    ): Promise<ModelLoadResult> {
        const startTime = Date.now();
        const useCache = options.useCache !== false && this.config.get<boolean>('cache.enabled', true);

        // Report progress
        const reportProgress = (percent: number, message: string) => {
            if (options.onProgress) {
                options.onProgress(percent, message);
            }
        };

        reportProgress(0, 'Initializing...');

        // Check if it's a remote URL
        const isRemote = this.isRemoteUrl(filePathOrUrl);

        // Try cache first
        if (useCache) {
            reportProgress(5, 'Checking cache...');
            const cachedData = await this.cacheManager.get(filePathOrUrl);
            if (cachedData) {
                const loadTime = Date.now() - startTime;
                reportProgress(100, 'Loaded from cache');
                
                return {
                    data: cachedData,
                    fromCache: true,
                    loadTime,
                    size: cachedData.length,
                    source: 'cache'
                };
            }
        }

        // Load from source
        let data: Uint8Array;
        let source: 'local' | 'remote';

        if (isRemote) {
            reportProgress(10, 'Downloading from remote...');
            data = await this.loadRemoteFile(filePathOrUrl, (percent) => {
                reportProgress(10 + percent * 0.8, `Downloading... ${percent.toFixed(1)}%`);
            });
            source = 'remote';
        } else {
            reportProgress(10, 'Loading local file...');
            data = await this.loadLocalFile(filePathOrUrl, options, (percent) => {
                reportProgress(10 + percent * 0.8, `Loading... ${percent.toFixed(1)}%`);
            });
            source = 'local';
        }

        // Store in cache
        if (useCache && data.length > 0) {
            reportProgress(95, 'Caching...');
            await this.cacheManager.set(filePathOrUrl, data);
        }

        const loadTime = Date.now() - startTime;
        reportProgress(100, 'Load complete');

        return {
            data,
            fromCache: false,
            loadTime,
            size: data.length,
            source
        };
    }

    /**
     * Load local file
     */
    private async loadLocalFile(
        filePath: string,
        options: ModelLoadOptions,
        onProgress?: (percent: number) => void
    ): Promise<Uint8Array> {
        const reader = new StreamingFileReader(
            filePath,
            (options.chunkSize || this.config.get<number>('loading.chunkSizeMB', 10)) * 1024 * 1024
        );

        await reader.initialize();
        const fileSize = reader.getFileSize();

        // Use streaming for large files
        const streamingThreshold = 50 * 1024 * 1024; // 50MB
        const useStreaming = options.useStreaming !== false && fileSize > streamingThreshold;

        if (!useStreaming) {
            // Load entire file
            if (onProgress) onProgress(50);
            const data = await reader.readAll();
            if (onProgress) onProgress(100);
            return data;
        }

        // Stream file in chunks
        const chunks: Uint8Array[] = [];
        let loadedBytes = 0;

        for await (const chunk of reader.readChunks()) {
            chunks.push(chunk);
            loadedBytes += chunk.length;
            
            if (onProgress) {
                const percent = (loadedBytes / fileSize) * 100;
                onProgress(percent);
            }
        }

        // Concatenate chunks
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;

        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }

        return result;
    }

    /**
     * Load remote file
     */
    private async loadRemoteFile(
        url: string,
        onProgress?: (percent: number) => void
    ): Promise<Uint8Array> {
        return this.remoteFileHandler.downloadFile(url, (percent) => {
            if (onProgress) {
                onProgress(percent);
            }
        });
    }

    /**
     * Check if string is a remote URL
     */
    private isRemoteUrl(str: string): boolean {
        return str.startsWith('http://') || str.startsWith('https://');
    }

    /**
     * Get cache statistics
     */
    getCacheStats() {
        return this.cacheManager.getStats();
    }

    /**
     * Clear cache
     */
    async clearCache(): Promise<void> {
        await this.cacheManager.clear();
    }

    /**
     * Get file info without loading
     */
    async getFileInfo(filePathOrUrl: string): Promise<{
        size: number;
        cached: boolean;
        cacheLocation?: 'memory' | 'disk' | 'none';
    }> {
        const isRemote = this.isRemoteUrl(filePathOrUrl);
        
        // Check cache
        const cacheInfo = await this.cacheManager.getEntryInfo(filePathOrUrl);
        
        if (cacheInfo && cacheInfo.exists) {
            return {
                size: cacheInfo.size,
                cached: true,
                cacheLocation: cacheInfo.location
            };
        }

        // Get size from source
        let size = 0;
        if (isRemote) {
            try {
                size = await this.remoteFileHandler.getFileSize(filePathOrUrl);
            } catch (error) {
                console.error('[OptimizedModelLoader] Failed to get remote file size:', error);
            }
        } else {
            try {
                const reader = new StreamingFileReader(filePathOrUrl);
                await reader.initialize();
                size = reader.getFileSize();
            } catch (error) {
                console.error('[OptimizedModelLoader] Failed to get local file size:', error);
            }
        }

        return {
            size,
            cached: false,
            cacheLocation: 'none'
        };
    }

    /**
     * Prefetch model (load into cache without returning data)
     */
    async prefetchModel(filePathOrUrl: string): Promise<void> {
        await this.loadModel(filePathOrUrl, { useCache: true });
    }

    /**
     * Update configuration
     */
    updateConfiguration(): void {
        this.config = vscode.workspace.getConfiguration('netron');
        
        // Update cache settings
        const cacheEnabled = this.config.get<boolean>('cache.enabled', true);
        this.cacheManager.setEnabled(cacheEnabled);
        
        const maxMemoryCacheMB = this.config.get<number>('cache.maxMemoryMB', 500);
        this.cacheManager.setMemoryCacheLimit(maxMemoryCacheMB);
        
        // Update remote handler settings
        const chunkSizeMB = this.config.get<number>('loading.chunkSizeMB', 10);
        this.remoteFileHandler.setChunkSize(chunkSizeMB);
        
        const parallelConnections = this.config.get<number>('network.parallelConnections', 6);
        this.remoteFileHandler.setMaxParallelConnections(parallelConnections);
    }
}
