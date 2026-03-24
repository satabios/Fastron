
/**
 * Stream Reader
 * Reads files in chunks to reduce memory usage
 */

export const StreamReader = class {

    constructor(chunkSize = 10 * 1024 * 1024) { // 10MB default
        this._chunkSize = chunkSize;
        this._streamingThreshold = 50 * 1024 * 1024; // 50MB threshold
    }

    /**
     * Read file with automatic streaming decision
     */
    async read(file) {
        const size = file.size || 0;

        // Use streaming for large files
        if (size > this._streamingThreshold) {
            return this.readStreaming(file);
        }

        // Direct read for small files
        return this.readDirect(file);
    }

    /**
     * Read file directly (whole file at once)
     */
    async readDirect(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = (event) => {
                resolve(new Uint8Array(event.target.result));
            };

            reader.onerror = () => {
                reject(new Error(`Failed to read file: ${file.name}`));
            };

            reader.readAsArrayBuffer(file);
        });
    }

    /**
     * Read file in chunks (streaming)
     */
    async readStreaming(file) {
        const totalSize = file.size;
        const chunkPromises = [];
        let offset = 0;

        // Create all chunk read promises
        while (offset < totalSize) {
            const chunkSize = Math.min(this._chunkSize, totalSize - offset);
            chunkPromises.push(this._readChunk(file, offset, chunkSize));
            offset += chunkSize;
        }

        // Wait for all chunks in parallel
        const chunks = await Promise.all(chunkPromises);

        // Concatenate all chunks
        return this._concatenateChunks(chunks);
    }

    /**
     * Read file chunk
     */
    async _readChunk(file, offset, size) {
        return new Promise((resolve, reject) => {
            const slice = file.slice(offset, offset + size);
            const reader = new FileReader();

            reader.onload = (event) => {
                resolve(new Uint8Array(event.target.result));
            };

            reader.onerror = () => {
                reject(new Error(`Failed to read chunk at offset ${offset}`));
            };

            reader.readAsArrayBuffer(slice);
        });
    }

    /**
     * Concatenate chunks into single Uint8Array
     */
    _concatenateChunks(chunks) {
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
     * Read specific byte range
     */
    async readRange(file, start, length) {
        const end = Math.min(start + length, file.size);
        return this._readChunk(file, start, end - start);
    }

    /**
     * Check if file should use streaming
     */
    shouldStream(file) {
        return file.size > this._streamingThreshold;
    }

    /**
     * Set chunk size
     */
    setChunkSize(chunkSizeMB) {
        this._chunkSize = chunkSizeMB * 1024 * 1024;
    }

    /**
     * Set streaming threshold
     */
    setStreamingThreshold(thresholdMB) {
        this._streamingThreshold = thresholdMB * 1024 * 1024;
    }
};
