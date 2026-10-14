import { formatKind, indexSource } from './model-index.mjs';

const native = typeof process !== 'undefined' && process.versions?.node;
const files = new Map();
let input = null;
let fs = null;
let path = null;
let root = '';
let readBytes = 0;
let readRequests = 0;
const identity = (request) => {
    const etag = request.getResponseHeader('ETag');
    return etag && !etag.startsWith('W/') ? etag : request.getResponseHeader('Last-Modified');
};
const version = (stat) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}`;

const describe = async (name, initial = false) => {
    if (native) {
        const file = await fs.promises.realpath(initial ? input.path : path.resolve(root, name));
        if (!initial) {
            const relative = path.relative(root, file);
            if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
                throw new Error('Model reference is outside its directory.');
            }
        }
        const stat = await fs.promises.stat(file, { bigint: true });
        if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) {
            throw new Error('Invalid model file.');
        }
        return { key: file, name: initial ? path.basename(file) : name, length: Number(stat.size), version: version(stat) };
    }
    if (input.file) {
        const file = initial ? input.file : input.files.find((entry) => entry.name === name);
        if (!file) {
            throw new Error(`File not found '${name}'.`);
        }
        return { key: file.name, name: file.name, length: file.size, version: `${file.size}:${file.lastModified}`, blob: file };
    }
    const url = initial ? input.url : new URL(name, input.url).href;
    const request = new XMLHttpRequest();
    request.open('HEAD', url, false);
    request.send();
    const lengthHeader = request.getResponseHeader('Content-Length');
    const length = lengthHeader === null ? NaN : Number(lengthHeader);
    const revision = identity(request);
    if (request.status !== 200 || !Number.isSafeInteger(length) || length < 0 || !revision || request.getResponseHeader('Accept-Ranges') !== 'bytes') {
        throw new Error('The server does not provide versioned byte ranges.');
    }
    return { key: url, name: initial ? (input.name || new URL(url).pathname.split('/').pop()) : name, length, version: revision };
};

const withSource = async (descriptor, action) => {
    let fd = null;
    if (native) {
        fd = fs.openSync(descriptor.key, 'r');
        if (version(fs.fstatSync(fd, { bigint: true })) !== descriptor.version) {
            fs.closeSync(fd);
            throw new Error('Model file changed. Reopen the model.');
        }
    }
    const source = {
        length: descriptor.length,
        readSync(offset, bytes) {
            if (!Number.isSafeInteger(offset) || offset < 0 || bytes.length > descriptor.length - offset) {
                throw new Error('Invalid source range.');
            }
            if (bytes.length === 0) {
                return;
            }
            if (native) {
                let read = 0;
                while (read < bytes.length) {
                    const count = fs.readSync(fd, bytes, read, bytes.length - read, offset + read);
                    if (!count) {
                        throw new Error('Truncated model file.');
                    }
                    read += count;
                }
            } else if (descriptor.blob) {
                const part = new Uint8Array(new self.FileReaderSync().readAsArrayBuffer(descriptor.blob.slice(offset, offset + bytes.length)));
                if (part.length !== bytes.length) {
                    throw new Error('Truncated model file.');
                }
                bytes.set(part);
            } else {
                const request = new XMLHttpRequest();
                request.open('GET', descriptor.key, false);
                request.responseType = 'arraybuffer';
                request.setRequestHeader(descriptor.version.startsWith('"') ? 'If-Match' : 'If-Unmodified-Since', descriptor.version);
                request.setRequestHeader('Range', `bytes=${offset}-${offset + bytes.length - 1}`);
                request.send();
                const expected = `bytes ${offset}-${offset + bytes.length - 1}/${descriptor.length}`;
                const revision = identity(request);
                if (request.status !== 206 || request.getResponseHeader('Content-Range') !== expected || revision !== descriptor.version || request.response.byteLength !== bytes.length) {
                    throw new Error('Remote model changed or returned an invalid byte range.');
                }
                bytes.set(new Uint8Array(request.response));
            }
            readBytes += bytes.length;
        }
    };
    try {
        const result = await action(source);
        if (native && version(fs.fstatSync(fd, { bigint: true })) !== descriptor.version) {
            throw new Error('Model file changed while reading.');
        }
        return result;
    } finally {
        if (fd !== null) {
            fs.closeSync(fd);
        }
    }
};

const indexed = async (name, initial = false) => {
    const descriptor = await describe(name, initial);
    const previous = files.get(descriptor.key);
    if (previous && previous.version !== descriptor.version) {
        throw new Error('Model reference changed. Reopen the model.');
    }
    files.set(descriptor.key, descriptor);
    const result = await withSource(descriptor, async (source) => {
        const head = new Uint8Array(Math.min(9, source.length));
        source.readSync(0, head);
        const kind = formatKind(descriptor.name, head);
        if (kind) {
            return indexSource(source, kind);
        }
        if (!initial) {
            return { kind: 0, metadata: null, ranges: [] };
        }
        // Other formats retain their existing parser and full-file behavior.
        const bytes = new Uint8Array(source.length);
        source.readSync(0, bytes);
        return { kind: 0, metadata: bytes.buffer, ranges: [] };
    });
    return { ...result, key: descriptor.key, name: descriptor.name, length: descriptor.length, version: descriptor.version };
};

const handle = async (message) => {
    switch (message.command) {
        case 'open': {
            input = message.input;
            if (native) {
                fs = await import('node:fs');
                path = await import('node:path');
                const filename = await fs.promises.realpath(input.path);
                input = { ...input, path: filename };
                root = path.dirname(filename);
            } else if (input.url) {
                input.url = new URL(input.url).href;
            }
            return indexed('', true);
        }
        case 'index': return indexed(message.file);
        case 'read': {
            const descriptor = files.get(message.file);
            if (!descriptor || descriptor.version !== message.version || !Number.isSafeInteger(message.length) || message.length < 0 || message.length > 4 * 1024 * 1024) {
                throw new Error('Invalid model range request.');
            }
            readRequests++;
            return withSource(descriptor, (source) => {
                const bytes = new Uint8Array(message.length);
                source.readSync(message.offset, bytes);
                return bytes.buffer;
            });
        }
        case 'stats': return { readBytes, readRequests };
        default: throw new Error('Unsupported model source request.');
    }
};

const port = native ? (await import('node:worker_threads')).parentPort : self;
let queue = Promise.resolve();
const receive = (message) => {
    queue = queue.then(async () => {
        try {
            const result = await handle(message);
            const buffer = result instanceof ArrayBuffer ? result : result.metadata;
            port.postMessage({ id: message.id, result }, buffer ? [buffer] : []);
        } catch (error) {
            port.postMessage({ id: message.id, error: error.message });
        }
    });
};
if (native) {
    port.on('message', receive);
} else {
    port.addEventListener('message', (event) => receive(event.data));
}
