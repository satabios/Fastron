// Session-local, bounded metadata only. No tensor data or persistent sidecars.
export class MetadataIndexCache {
    constructor(limit = 64 * 1024 * 1024, capacity = 8) {
        this._limit = limit;
        this._capacity = capacity;
        this._bytes = 0;
        this._entries = new Map();
    }

    get(key) {
        const entry = this._entries.get(key);
        if (!entry) {
            return null;
        }
        this._entries.delete(key);
        this._entries.set(key, entry);
        return entry.index;
    }

    set(key, index) {
        const previous = this._entries.get(key);
        if (previous) {
            this._bytes -= previous.bytes;
            this._entries.delete(key);
        }
        if (![1, 2, 3].includes(index.kind) || !(index.metadata instanceof ArrayBuffer)) {
            return;
        }
        // Account conservatively for range objects as well as metadata bytes.
        const bytes = index.metadata.byteLength + 2 * JSON.stringify(index.ranges).length + index.ranges.length * 128;
        if (bytes > this._limit || this._capacity < 1) {
            return;
        }
        while (this._entries.size >= this._capacity || this._bytes + bytes > this._limit) {
            const oldest = this._entries.keys().next().value;
            this._bytes -= this._entries.get(oldest).bytes;
            this._entries.delete(oldest);
        }
        // The consumer may mutate or transfer its result after open resolves.
        const { kind, metadata, ranges, key: file, name, length, version } = index;
        this._entries.set(key, { bytes, index: structuredClone({ kind, metadata, ranges, key: file, name, length, version }) });
        this._bytes += bytes;
    }
}