import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';

/**
 * Remote File Handler
 * Handles downloading files from remote URLs with support for:
 * - HTTP Range requests
 * - Parallel chunk downloads
 * - Progress tracking
 * - Retry logic
 */
export class RemoteFileHandler {
    private chunkSize: number;
    private maxParallelConnections: number;
    private maxRetries: number;
    private retryDelay: number;

    constructor(
        chunkSize: number = 5 * 1024 * 1024, // 5MB default
        maxParallelConnections: number = 6,
        maxRetries: number = 3,
        retryDelay: number = 1000
    ) {
        this.chunkSize = chunkSize;
        this.maxParallelConnections = maxParallelConnections;
        this.maxRetries = maxRetries;
        this.retryDelay = retryDelay;
    }

    /**
     * Check if server supports range requests
     */
    async supportsRangeRequests(url: string): Promise<boolean> {
        try {
            const headers = await this.getHeaders(url);
            return headers['accept-ranges'] === 'bytes';
        } catch (error) {
            console.error('[RemoteFileHandler] Failed to check range support:', error);
            return false;
        }
    }

    /**
     * Get file size from remote server
     */
    async getFileSize(url: string): Promise<number> {
        try {
            const headers = await this.getHeaders(url);
            const contentLength = headers['content-length'];
            return contentLength ? parseInt(contentLength, 10) : 0;
        } catch (error) {
            console.error('[RemoteFileHandler] Failed to get file size:', error);
            throw error;
        }
    }

    /**
     * Get headers from remote server
     */
    private async getHeaders(url: string): Promise<Record<string, string>> {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const protocol = parsedUrl.protocol === 'https:' ? https : http;

            const request = protocol.request(
                url,
                { method: 'HEAD' },
                (response) => {
                    const headers: Record<string, string> = {};
                    for (const [key, value] of Object.entries(response.headers)) {
                        if (typeof value === 'string') {
                            headers[key.toLowerCase()] = value;
                        } else if (Array.isArray(value)) {
                            headers[key.toLowerCase()] = value[0];
                        }
                    }
                    resolve(headers);
                }
            );

            request.on('error', reject);
            request.end();
        });
    }

    /**
     * Download a specific range of the file
     */
    async downloadRange(url: string, start: number, end: number): Promise<Uint8Array> {
        let lastError: Error | null = null;

        for (let attempt = 0; attempt < this.maxRetries; attempt++) {
            try {
                return await this._downloadRangeAttempt(url, start, end);
            } catch (error) {
                lastError = error as Error;
                console.warn(`[RemoteFileHandler] Download attempt ${attempt + 1} failed:`, error);
                
                if (attempt < this.maxRetries - 1) {
                    await this.delay(this.retryDelay * (attempt + 1));
                }
            }
        }

        throw lastError || new Error('Download failed after retries');
    }

    /**
     * Single download attempt
     */
    private async _downloadRangeAttempt(url: string, start: number, end: number): Promise<Uint8Array> {
        return new Promise((resolve, reject) => {
            const parsedUrl = new URL(url);
            const protocol = parsedUrl.protocol === 'https:' ? https : http;

            const options = {
                headers: {
                    'Range': `bytes=${start}-${end}`
                }
            };

            const request = protocol.get(url, options, (response) => {
                if (response.statusCode !== 206 && response.statusCode !== 200) {
                    reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
                    return;
                }

                const chunks: Buffer[] = [];
                let totalLength = 0;

                response.on('data', (chunk: Buffer) => {
                    chunks.push(chunk);
                    totalLength += chunk.length;
                });

                response.on('end', () => {
                    const buffer = Buffer.concat(chunks, totalLength);
                    resolve(new Uint8Array(buffer));
                });

                response.on('error', reject);
            });

            request.on('error', reject);
            request.setTimeout(30000, () => {
                request.destroy();
                reject(new Error('Request timeout'));
            });
        });
    }

    /**
     * Download entire file with parallel connections
     */
    async downloadFile(
        url: string,
        onProgress?: (percent: number, downloaded: number, total: number) => void
    ): Promise<Uint8Array> {
        const fileSize = await this.getFileSize(url);
        const supportsRanges = await this.supportsRangeRequests(url);

        console.log(`[RemoteFileHandler] Downloading ${url}`);
        console.log(`[RemoteFileHandler] File size: ${this.formatSize(fileSize)}`);
        console.log(`[RemoteFileHandler] Range requests: ${supportsRanges ? 'supported' : 'not supported'}`);

        if (!supportsRanges || fileSize < this.chunkSize) {
            // Download entire file at once
            return this.downloadRange(url, 0, fileSize - 1);
        }

        // Download in parallel chunks
        const chunkCount = Math.ceil(fileSize / this.chunkSize);
        const chunks: Uint8Array[] = new Array(chunkCount);
        let downloadedBytes = 0;

        // Download chunks in batches
        for (let i = 0; i < chunkCount; i += this.maxParallelConnections) {
            const batchPromises: Promise<void>[] = [];

            for (let j = 0; j < this.maxParallelConnections && (i + j) < chunkCount; j++) {
                const chunkIndex = i + j;
                const start = chunkIndex * this.chunkSize;
                const end = Math.min(start + this.chunkSize - 1, fileSize - 1);

                batchPromises.push(
                    this.downloadRange(url, start, end).then(data => {
                        chunks[chunkIndex] = data;
                        downloadedBytes += data.length;
                        
                        if (onProgress) {
                            const percent = (downloadedBytes / fileSize) * 100;
                            onProgress(percent, downloadedBytes, fileSize);
                        }
                    })
                );
            }

            await Promise.all(batchPromises);
        }

        // Concatenate all chunks
        const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const result = new Uint8Array(totalLength);
        let offset = 0;

        for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
        }

        console.log(`[RemoteFileHandler] Download complete: ${this.formatSize(totalLength)}`);
        return result;
    }

    /**
     * Stream file in chunks
     */
    async *streamFile(url: string): AsyncGenerator<Uint8Array> {
        const fileSize = await this.getFileSize(url);
        const supportsRanges = await this.supportsRangeRequests(url);

        if (!supportsRanges) {
            // Download entire file and yield as single chunk
            const data = await this.downloadRange(url, 0, fileSize - 1);
            yield data;
            return;
        }

        // Stream in chunks
        let position = 0;
        while (position < fileSize) {
            const end = Math.min(position + this.chunkSize - 1, fileSize - 1);
            const chunk = await this.downloadRange(url, position, end);
            yield chunk;
            position = end + 1;
        }
    }

    /**
     * Download file header only
     */
    async downloadHeader(url: string, size: number = 1024): Promise<Uint8Array> {
        const fileSize = await this.getFileSize(url);
        const headerSize = Math.min(size, fileSize);
        return this.downloadRange(url, 0, headerSize - 1);
    }

    /**
     * Delay helper
     */
    private delay(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
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
     * Set chunk size
     */
    setChunkSize(sizeMB: number): void {
        this.chunkSize = sizeMB * 1024 * 1024;
    }

    /**
     * Set max parallel connections
     */
    setMaxParallelConnections(count: number): void {
        this.maxParallelConnections = Math.max(1, Math.min(count, 10));
    }
}
