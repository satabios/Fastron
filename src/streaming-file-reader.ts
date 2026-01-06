import * as fs from 'fs';
import * as crypto from 'crypto';

/**
 * Streaming File Reader
 * Reads large files in chunks to avoid loading entire file into memory
 */
export class StreamingFileReader {
    private filePath: string;
    private chunkSize: number;
    private fileSize: number = 0;
    private fileHandle: fs.promises.FileHandle | null = null;

    constructor(filePath: string, chunkSize: number = 10 * 1024 * 1024) { // 10MB default
        this.filePath = filePath;
        this.chunkSize = chunkSize;
    }

    /**
     * Initialize the reader and get file size
     */
    async initialize(): Promise<void> {
        const stats = await fs.promises.stat(this.filePath);
        this.fileSize = stats.size;
    }

    /**
     * Get file size
     */
    getFileSize(): number {
        return this.fileSize;
    }

    /**
     * Read file in chunks
     */
    async *readChunks(): AsyncGenerator<Uint8Array> {
        const fd = await fs.promises.open(this.filePath, 'r');
        try {
            let position = 0;
            
            while (position < this.fileSize) {
                const buffer = Buffer.allocUnsafe(Math.min(this.chunkSize, this.fileSize - position));
                const { bytesRead } = await fd.read(buffer, 0, buffer.length, position);
                
                if (bytesRead === 0) {
                    break;
                }
                
                yield new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
                position += bytesRead;
            }
        } finally {
            await fd.close();
        }
    }

    /**
     * Read a specific range of the file
     */
    async readRange(start: number, length: number): Promise<Uint8Array> {
        const fd = await fs.promises.open(this.filePath, 'r');
        try {
            const buffer = Buffer.allocUnsafe(length);
            const { bytesRead } = await fd.read(buffer, 0, length, start);
            return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
        } finally {
            await fd.close();
        }
    }

    /**
     * Read file header (first N bytes)
     */
    async readHeader(size: number = 1024): Promise<Uint8Array> {
        return this.readRange(0, Math.min(size, this.fileSize));
    }

    /**
     * Calculate file hash without loading entire file
     */
    async calculateHash(algorithm: string = 'sha256'): Promise<string> {
        const hash = crypto.createHash(algorithm);
        
        for await (const chunk of this.readChunks()) {
            hash.update(chunk);
        }
        
        return hash.digest('hex');
    }

    /**
     * Read entire file (fallback for small files)
     */
    async readAll(): Promise<Uint8Array> {
        const buffer = await fs.promises.readFile(this.filePath);
        return new Uint8Array(buffer);
    }

    /**
     * Check if file should use streaming (based on size)
     */
    shouldUseStreaming(threshold: number = 50 * 1024 * 1024): boolean {
        return this.fileSize > threshold;
    }
}

/**
 * Chunked Buffer Manager
 * Manages chunks of data for streaming operations
 */
export class ChunkedBufferManager {
    private chunks: Map<number, Uint8Array> = new Map();
    private chunkSize: number;
    private totalSize: number;

    constructor(chunkSize: number, totalSize: number) {
        this.chunkSize = chunkSize;
        this.totalSize = totalSize;
    }

    /**
     * Add a chunk at a specific position
     */
    addChunk(position: number, data: Uint8Array): void {
        const chunkIndex = Math.floor(position / this.chunkSize);
        this.chunks.set(chunkIndex, data);
    }

    /**
     * Get data from a specific range
     */
    getRange(start: number, length: number): Uint8Array | null {
        const startChunk = Math.floor(start / this.chunkSize);
        const endChunk = Math.floor((start + length - 1) / this.chunkSize);

        // Check if all required chunks are available
        for (let i = startChunk; i <= endChunk; i++) {
            if (!this.chunks.has(i)) {
                return null;
            }
        }

        // Single chunk case
        if (startChunk === endChunk) {
            const chunk = this.chunks.get(startChunk)!;
            const offset = start % this.chunkSize;
            return chunk.slice(offset, offset + length);
        }

        // Multiple chunks case
        const result = new Uint8Array(length);
        let resultOffset = 0;
        let currentPos = start;

        for (let i = startChunk; i <= endChunk; i++) {
            const chunk = this.chunks.get(i)!;
            const chunkStart = i * this.chunkSize;
            const offset = Math.max(0, currentPos - chunkStart);
            const copyLength = Math.min(chunk.length - offset, length - resultOffset);

            result.set(chunk.slice(offset, offset + copyLength), resultOffset);
            resultOffset += copyLength;
            currentPos += copyLength;
        }

        return result;
    }

    /**
     * Check if a range is available
     */
    hasRange(start: number, length: number): boolean {
        const startChunk = Math.floor(start / this.chunkSize);
        const endChunk = Math.floor((start + length - 1) / this.chunkSize);

        for (let i = startChunk; i <= endChunk; i++) {
            if (!this.chunks.has(i)) {
                return false;
            }
        }

        return true;
    }

    /**
     * Get memory usage
     */
    getMemoryUsage(): number {
        let total = 0;
        for (const chunk of this.chunks.values()) {
            total += chunk.length;
        }
        return total;
    }

    /**
     * Clear chunks to free memory
     */
    clear(): void {
        this.chunks.clear();
    }

    /**
     * Remove specific chunks
     */
    removeChunks(startChunk: number, endChunk: number): void {
        for (let i = startChunk; i <= endChunk; i++) {
            this.chunks.delete(i);
        }
    }
}
