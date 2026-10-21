// On Windows Node's path stat can report dev=0 while fstat reports the
// volume serial number. Keep inode, size and both timestamps authoritative
// at the canonical path; retain device identity on platforms that agree.
export const fileVersion = (stat, platform) => `${platform === 'win32' ? '' : stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

// Bounded read-ahead for native indexing only. Tensor previews use exact ranges.
export const bufferedSource = (source) => {
    const limit = 4096;
    let offset = -1;
    let window = new Uint8Array(0);
    return {
        length: source.length,
        readSync(position, bytes) {
            if (!Number.isSafeInteger(position) || position < 0 || bytes.length > source.length - position) {
                throw new Error('Invalid source range.');
            }
            if (bytes.length === 0) {
                return;
            }
            if (position >= offset && bytes.length <= offset + window.length - position) {
                bytes.set(window.subarray(position - offset, position - offset + bytes.length));
                return;
            }
            // Keep the format header and large sequential windows exact.
            if (bytes.length > limit || position === 0) {
                source.readSync(position, bytes);
                return;
            }
            // A lone post-skip probe stays exact. Read ahead only after metadata
            // continues beyond it, rather than over-reading every tensor body.
            const size = position === offset + window.length ? limit : bytes.length;
            const next = new Uint8Array(Math.min(size, source.length - position));
            source.readSync(position, next);
            offset = position;
            window = next;
            bytes.set(window.subarray(0, bytes.length));
        }
    };
};
