
import * as fs from 'fs';

const node = {};

// Detect whether a file path refers to a network location.
// On Windows, UNC paths (\\server\share or //server/share) are always remote.
// On all platforms, paths under common NFS/SMB mount points are heuristically
// detected by checking for leading double-separator.
node.isNetworkPath = (filepath) => {
    if (!filepath) {
        return false;
    }
    const normalized = filepath.replace(/\\/g, '/');
    return normalized.startsWith('//');
};

// Keep parser windows small enough that skipping a large tensor does not read
// the tensor from disk or across a network share. Random-access tensor reads
// are performed separately when a value is opened in the UI.
node.LOCAL_WINDOW = 0x1000000; // 16 MB
node.NETWORK_WINDOW = 0x400000; // 4 MB

node.FileStream = class {

    constructor(file, start, length, mtime) {
        this._file = file;
        this._start = start;
        this._length = length;
        this._position = 0;
        this._mtime = mtime;
        this._fd = null;
        this._windowSize = node.isNetworkPath(file) ? node.NETWORK_WINDOW : node.LOCAL_WINDOW;
    }

    get position() {
        return this._position;
    }

    get length() {
        return this._length;
    }

    // Expose the path so callers (e.g. protobuf.BinaryReader) can identify
    // this as a FileStream and choose the appropriate reader strategy.
    get file() {
        return this._file;
    }

    get windowSize() {
        return this._windowSize;
    }

    stream(length) {
        const stream = new node.FileStream(this._file, this._start + this._position, length, this._mtime);
        this.skip(length);
        return stream;
    }

    seek(position) {
        this._position = position >= 0 ? position : this._length + position;
        if (this._position > this._length || this._position < 0) {
            throw new Error(`Expected ${this._position - this._length} more bytes. The file might be corrupted. Unexpected end of file.`);
        }
    }

    skip(offset) {
        this._position += offset;
        if (this._position > this._length || this._position < 0) {
            const offset = this._position - this._length;
            throw new Error(`Expected ${offset} more bytes. The file might be corrupted. Unexpected end of file.`);
        }
    }

    peek(length) {
        length = length === undefined ? this._length - this._position : length;
        if (length < 0x1000000) {
            const position = this._fill(length);
            this._position -= length;
            return this._buffer.subarray(position, position + length);
        }
        const position = this._position;
        this.skip(length);
        this.seek(position);
        const buffer = new Uint8Array(length);
        this._read(buffer, position);
        return buffer;
    }

    read(length) {
        length = length === undefined ? this._length - this._position : length;
        if (length < this._windowSize) {
            const position = this._fill(length);
            return this._buffer.slice(position, position + length);
        }
        const position = this._position;
        this.skip(length);
        const buffer = new Uint8Array(length);
        this._read(buffer, position);
        return buffer;
    }

    readAt(position, length) {
        if (!Number.isInteger(position) || !Number.isInteger(length) || position < 0 || length < 0 || position + length > this._length) {
            throw new Error('Invalid file read range.');
        }
        const buffer = new Uint8Array(length);
        this._read(buffer, position);
        return buffer;
    }

    _fill(length) {
        if (this._position + length > this._length) {
            const offset = this._position + length - this._length;
            throw new Error(`Expected ${offset} more bytes. The file might be corrupted. Unexpected end of file.`);
        }
        if (!this._buffer || this._position < this._offset || this._position + length > this._offset + this._buffer.length) {
            this._offset = this._position;
            const windowLength = Math.min(this._windowSize, this._length - this._offset);
            if (!this._buffer || windowLength !== this._buffer.length) {
                this._buffer = new Uint8Array(windowLength);
            }
            this._read(this._buffer, this._offset);
        }
        const position = this._position;
        this._position += length;
        return position - this._offset;
    }

    _openFd() {
        if (this._fd === null) {
            this._fd = fs.openSync(this._file, 'r');
            const stat = fs.fstatSync(this._fd);
            if (stat.mtimeMs !== this._mtime) {
                fs.closeSync(this._fd);
                this._fd = null;
                throw new Error(`File '${this._file}' last modified time changed.`);
            }
        }
        return this._fd;
    }

    _read(buffer, offset) {
        const fd = this._openFd();
        let destination = 0;
        while (destination < buffer.length) {
            const size = fs.readSync(fd, buffer, destination, buffer.length - destination, offset + this._start + destination);
            if (size === 0) {
                throw new Error(`Expected ${buffer.length - destination} more bytes. The file might be corrupted. Unexpected end of file.`);
            }
            destination += size;
        }
    }

    dispose() {
        if (this._fd !== null) {
            try {
                fs.closeSync(this._fd);
            } catch {
                // continue regardless of error
            }
            this._fd = null;
        }
    }
};

export const FileStream = node.FileStream;
export const isNetworkPath = node.isNetworkPath;
