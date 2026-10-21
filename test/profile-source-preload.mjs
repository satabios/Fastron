// Diagnostic preload inherited by the source worker; no production edits.
import { isMainThread, threadId } from 'node:worker_threads';
import { Session } from 'node:inspector';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';

if (!isMainThread && process.env.FASTRON_PROFILE_DIR) {
    const session = new Session();
    session.connect();
    const post = (method) => new Promise((resolve, reject) => {
        session.post(method, (error, result) => error ? reject(error) : resolve(result));
    });
    await post('Profiler.enable');
    await post('Profiler.start');
    const operations = {};
    const reads = [];
    const descriptors = new Set();
    const progressFile = `${process.env.FASTRON_PROFILE_DIR}/worker-${threadId}-progress.json`;
    let lastSaved = 0;
    const checkpoint = (pending, force = false) => {
        const now = performance.now();
        if (force || now - lastSaved > 5000) {
            fs.writeFileSync(progressFile, JSON.stringify({ timestamp: new Date().toISOString(), pending, operations, reads }, null, 2));
            lastSaved = now;
        }
    };
    checkpoint('worker initialized', true);
    const add = (name, milliseconds, bytes = 0, failed = false) => {
        operations[name] ||= { calls: 0, milliseconds: 0, bytes: 0, failures: 0 };
        const entry = operations[name];
        entry.calls++;
        entry.milliseconds += milliseconds;
        entry.bytes += bytes;
        entry.failures += failed ? 1 : 0;
    };
    const open = fs.openSync;
    fs.openSync = function(filename, ...args) {
        const start = performance.now();
        const network = typeof filename === 'string' && filename.replaceAll('\\', '/').startsWith('//');
        if (network) {
            checkpoint('openSync', true);
        }
        const fd = open.call(this, filename, ...args);
        if (network) {
            descriptors.add(fd);
            add('open', performance.now() - start);
        }
        return fd;
    };
    const read = fs.readSync;
    fs.readSync = function(fd, buffer, offset, length, position) {
        if (!descriptors.has(fd)) {
            return read.call(this, fd, buffer, offset, length, position);
        }
        const start = performance.now();
        checkpoint(`readSync offset=${position} length=${length}`);
        let count = 0;
        let failed = false;
        try {
            count = read.call(this, fd, buffer, offset, length, position);
            return count;
        } catch (error) {
            failed = true;
            throw error;
        } finally {
            const milliseconds = performance.now() - start;
            add('read', milliseconds, count, failed);
            reads.push({ position, requested: length, returned: count, milliseconds, failed });
            checkpoint('read completed');
        }
    };
    const stat = fs.fstatSync;
    fs.fstatSync = function(fd, ...args) {
        const start = performance.now();
        try {
            return stat.call(this, fd, ...args);
        } finally {
            if (descriptors.has(fd)) {
                add('fstat', performance.now() - start);
            }
        }
    };
    const close = fs.closeSync;
    let captured = false;
    fs.closeSync = function(fd) {
        const network = descriptors.has(fd);
        descriptors.delete(fd);
        const result = close.call(this, fd);
        if (network && !captured) {
            captured = true;
            session.post('Profiler.stop', (error, response) => {
                if (!error) {
                    const prefix = `${process.env.FASTRON_PROFILE_DIR}/worker-${threadId}`;
                    fs.writeFileSync(`${prefix}.cpuprofile`, JSON.stringify(response.profile));
                    fs.writeFileSync(`${prefix}-io.json`, JSON.stringify({ operations, reads }, null, 2));
                }
                session.disconnect();
            });
        }
        return result;
    };
    for (const name of ['realpath', 'stat']) {
        const original = fs.promises[name];
        fs.promises[name] = async function(...args) {
            const start = performance.now();
            checkpoint(name, true);
            try {
                return await original.apply(this, args);
            } finally {
                add(name, performance.now() - start);
                checkpoint(`${name} completed`, true);
            }
        };
    }
    syncBuiltinESMExports();
}