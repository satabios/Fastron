import { BinaryStream } from './base.js';
import { MetadataIndexCache } from './model-source-cache.mjs';

// Electron retains this cache in the main-process transport, not each renderer.
const nativeIndexCache = typeof process !== 'undefined' && process.versions?.node && process.type !== 'renderer' ? new MetadataIndexCache() : null;

// A metadata prefix can be read synchronously; payload ranges stay asynchronous.
export class RangeStream {
    constructor(descriptor, read, metadata = new Uint8Array(0), start = 0, length = descriptor.length) {
        this.descriptor = descriptor;
        this._readRange = read;
        this._metadata = metadata;
        this._start = start;
        this._length = length;
        this._position = 0;
        this.remote = true;
    }
    get file() {
        return this.descriptor.name;
    }
    get length() {
        return this._length;
    }
    get position() {
        return this._position;
    }
    _check(position, length) {
        if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 0 || length > this.length - position) {
            throw new Error('Invalid model byte range.');
        }
    }
    seek(position) {
        const next = position < 0 ? this.length + position : position;
        this._check(next, 0);
        this._position = next;
    }
    skip(length) {
        const next = this.position + length;
        this._check(next, 0);
        this._position = next;
    }
    stream(length) {
        this._check(this.position, length);
        const stream = new RangeStream(this.descriptor, this._readRange, this._metadata, this._start + this.position, length);
        this.skip(length);
        return stream;
    }
    peek(length = this.length - this.position) {
        this._check(this.position, length);
        const start = this._start + this.position;
        if (start + length > this._metadata.length) {
            throw new Error('Weight data requires an asynchronous range read.');
        }
        return this._metadata.subarray(start, start + length);
    }
    read(length = this.length - this.position) {
        const bytes = this.peek(length);
        this.skip(length);
        return bytes;
    }
    async readAt(position, length) {
        this._check(position, length);
        const bytes = new Uint8Array(length);
        // Bound each transport message, including full-tensor export requests.
        for (let offset = 0; offset < length; offset += 4 * 1024 * 1024) {
            const count = Math.min(4 * 1024 * 1024, length - offset);
            // eslint-disable-next-line no-await-in-loop
            const part = new Uint8Array(await this._readRange(this.descriptor, this._start + position + offset, count));
            if (part.length !== count) {
                throw new Error('Truncated model byte range.');
            }
            bytes.set(part, offset);
        }
        return bytes;
    }
}

export const createContext = (host, descriptor, readRange, openReference) => {
    const metadata = new Uint8Array(descriptor.metadata || 0);
    const source = new RangeStream(descriptor, readRange, metadata);
    const stream = descriptor.kind === 2 || descriptor.kind === 3 || !descriptor.metadata ? source : new BinaryStream(metadata);
    stream.tensorRanges = descriptor.kind === 1 ? descriptor.ranges : null;
    stream.tensorSource = descriptor.kind === 1 ? source : null;
    return {
        identifier: descriptor.name,
        indexedFormat: ['','onnx', 'gguf', 'safetensors'][descriptor.kind],
        stream,
        async request(file, encoding, base) {
            if (base === null) {
                return host.request(file, encoding, base);
            }
            const ref = await openReference(base ? `${base}/${file}` : file);
            if (!ref.metadata && !descriptor.kind && !/\.onnx$/i.test(descriptor.name)) {
                ref.metadata = (await new RangeStream(ref, readRange).readAt(0, ref.length)).buffer;
            }
            const refContext = createContext(host, ref, readRange, openReference);
            return encoding ? new TextDecoder(encoding).decode(await new RangeStream(ref, readRange).readAt(0, ref.length)) : refContext.stream;
        },
        require: (id) => host.require(id),
        error: (error, fatal) => host.exception(error, fatal)
    };
};

export class ModelSource {
    constructor(worker) {
        this._worker = worker;
        this._pending = new Map();
        this._next = 0;
        const message = (data) => {
            const pending = this._pending.get(data.id);
            if (pending) {
                this._pending.delete(data.id);
                if (data.error) {
                    pending.reject(new Error(data.error));
                } else {
                    pending.resolve(data.result);
                }
            }
        };
        const error = (event) => this.dispose(new Error(event.message || 'Model source worker failed.'));
        if (worker.addEventListener) {
            worker.addEventListener('message', (event) => message(event.data));
            worker.addEventListener('error', error);
        } else {
            worker.on('message', message);
            worker.on('error', error);
            worker.on('exit', () => this.dispose(new Error('Model source worker closed.')));
        }
    }
    request(command, args = {}) {
        if (!this._worker) {
            return Promise.reject(new Error('Model source is closed.'));
        }
        const cacheKey = nativeIndexCache && command === 'open' && typeof args.input?.path === 'string' ? args.input.path : null;
        if (cacheKey !== null) {
            args = { ...args, input: { ...args.input, cachedIndex: nativeIndexCache.get(cacheKey) } };
        }
        const id = ++this._next;
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject });
            try {
                this._worker.postMessage({ id, command, ...args });
            } catch (error) {
                this._pending.delete(id); reject(error);
            }
        }).then((result) => {
            if (cacheKey !== null) {
                nativeIndexCache.set(cacheKey, result);
            }
            return result;
        });
    }
    context(host, descriptor) {
        return createContext(host, descriptor,
            (file, offset, length) => this.request('read', { file: file.key, version: file.version, offset, length }),
            (file) => this.request('index', { file }));
    }
    dispose(error = new Error('Model source was closed.')) {
        const worker = this._worker;
        this._worker = null;
        this._pending.forEach((pending) => pending.reject(error));
        this._pending.clear();
        if (worker) {
            worker.terminate();
        }
    }
}

export const openSource = async (host, input) => {
    let worker = null;
    const url = new URL('./model-source-worker.mjs', import.meta.url);
    if (typeof process !== 'undefined' && process.type === 'renderer' && process.versions?.electron) {
        const { ipcRenderer } = await import('electron');
        worker = (await import('./model-source-electron.mjs')).createElectronWorker(ipcRenderer);
    } else if (typeof process !== 'undefined' && process.versions?.node) {
        const threads = await import('node:worker_threads');
        worker = new threads.Worker(new URL(url.href.replace('/app.asar/', '/app.asar.unpacked/')));
    } else {
        worker = new Worker(url, { type: 'module' });
    }
    const source = new ModelSource(worker);
    try {
        const descriptor = await source.request('open', { input });
        const context = source.context(host, descriptor);
        context.source = source;
        return context;
    } catch (error) {
        source.dispose();
        throw error;
    }
};
