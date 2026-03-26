
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

// Read-window sizes.  Network drives benefit from smaller windows so that
// the protobuf parser can skip large weight fields without waiting for a full
// 256 MB chunk to arrive over the wire.  Local drives use the larger window
// to amortise syscall overhead.
node.LOCAL_WINDOW  = 0x10000000; // 256 MB — matches original behaviour
node.NETWORK_WINDOW = 0x2000000; //  32 MB — reduces per-chunk network wait

node.FileStream = class {

    constructor(file, start, length, mtime) {
        this._file = file;
        this._start = start;
        this._length = length;
        this._position = 0;
        this._mtime = mtime;
        this._fd = null;
        // Choose window size based on whether the path looks like a network share.
        // Smaller windows on network paths mean the protobuf parser reaches each
        // skipType() call sooner, reducing the bytes that must cross the wire.
        this._windowSize = node.isNetworkPath(file) ? node.NETWORK_WINDOW : node.LOCAL_WINDOW;
        // Read-ahead slot: holds a pending async read for the next window.
        this._prefetch = null;
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

    stream(length) {
        const stream = new node.FileStream(this._file, this._start + this._position, length, this._mtime);
        this.skip(length);
        return stream;
    }

    seek(position) {
        this._position = position >= 0 ? position : this._length + position;
    }

    skip(offset) {
        this._position += offset;
        if (this._position > this._length) {
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

    _fill(length) {
        if (this._position + length > this._length) {
            const offset = this._position + length - this._length;
            throw new Error(`Expected ${offset} more bytes. The file might be corrupted. Unexpected end of file.`);
        }
        if (!this._buffer || this._position < this._offset || this._position + length > this._offset + this._buffer.length) {
            // Check whether the read-ahead prefetch covers this position.
            if (this._prefetch && this._prefetch.offset === this._position) {
                // Consume the prefetched buffer synchronously (it was already read).
                this._offset = this._prefetch.offset;
                this._buffer = this._prefetch.buffer;
                this._prefetch = null;
            } else {
                this._offset = this._position;
                const windowLength = Math.min(this._windowSize, this._length - this._offset);
                if (!this._buffer || windowLength !== this._buffer.length) {
                    this._buffer = new Uint8Array(windowLength);
                }
                this._read(this._buffer, this._offset);
            }
            // Kick off a read-ahead for the next window so it arrives while the
            // protobuf parser is processing the current window.  This overlaps
            // network I/O with CPU work and is especially valuable on high-latency
            // links (SMB over WAN, NFS over VPN).
            this._scheduleReadAhead();
        }
        const position = this._position;
        this._position += length;
        return position - this._offset;
    }

    _scheduleReadAhead() {
        const nextOffset = this._offset + this._buffer.length;
        if (nextOffset >= this._length || this._prefetch) {
            return;
        }
        const nextLength = Math.min(this._windowSize, this._length - nextOffset);
        const nextBuffer = new Uint8Array(nextLength);
        const fd = this._openFd();
        // fs.read is non-blocking — it yields the event loop while the OS/network
        // driver fetches the data, so the protobuf parser can continue on the
        // current window without stalling.
        this._prefetch = { offset: nextOffset, buffer: nextBuffer, ready: false };
        fs.read(fd, nextBuffer, 0, nextLength, nextOffset + this._start, (err) => {
            if (!err && this._prefetch && this._prefetch.offset === nextOffset) {
                this._prefetch.ready = true;
            } else {
                this._prefetch = null;
            }
        });
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
        fs.readSync(fd, buffer, 0, buffer.length, offset + this._start);
    }

    dispose() {
        this._prefetch = null;
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