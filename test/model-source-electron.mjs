import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { registerModelSources } from '../source/model-source-electron.mjs';
import { test } from 'node:test';

for (const action of ['dispose', 'destroyed', 'replace']) {
    test(`Electron broker cancels pending open on ${action}`, async () => {
        const ipc = new EventEmitter();
        registerModelSources(ipc);
        const handle = ipc.listeners('model-source')[0];
        const session = crypto.randomUUID();
        const sender = new EventEmitter();
        let destroyed = false;
        sender.isDestroyed = () => destroyed;
        const responses = new Map();
        sender.send = (channel, response) => responses.set(response.id, response);
        const event = { sender };
        const pending = handle(event, { session, request: { id: 1, command: 'open', input: { path: path.resolve('package.json') } } });
        try {
            assert.equal(sender.listenerCount('destroyed'), 1);
            let replacement = null;
            if (action === 'destroyed') {
                destroyed = true;
                sender.emit('destroyed');
            } else {
                const disposed = handle(event, { session, request: { command: 'dispose' } });
                assert.equal(sender.listenerCount('destroyed'), 0);
                if (action === 'replace') {
                    replacement = handle(event, { session, request: { id: 2, command: 'open', input: { path: path.resolve('package.json') } } });
                }
                await disposed;
            }
            await pending;
            assert.equal(responses.has(1), false);
            if (replacement) {
                await replacement;
                assert.equal(responses.get(2).error, undefined);
                assert.equal(sender.listenerCount('destroyed'), 1);
            } else {
                assert.equal(sender.listenerCount('destroyed'), 0);
                destroyed = false;
                await handle(event, { session, request: { id: 3, command: 'stats' } });
                assert.match(responses.get(3).error, /closed/);
            }
        } finally {
            sender.emit('destroyed');
            await pending;
        }
    });
}

test('Electron broker rejects duplicate pending opens, pending requests and foreign disposal without closing owner session', async () => {
    const ipc = new EventEmitter();
    registerModelSources(ipc);
    const handle = ipc.listeners('model-source')[0];
    const session = crypto.randomUUID();
    const sender = new EventEmitter();
    sender.isDestroyed = () => false;
    const responses = new Map();
    sender.send = (channel, response) => responses.set(response.id, response);
    const event = { sender };
    const request = { id: 1, command: 'open', input: { path: path.resolve('package.json') } };
    const pending = handle(event, { session, request });
    try {
        assert.equal(sender.listenerCount('destroyed'), 1);
        const duplicate = handle(event, { session, request: { ...request, id: 2 } });
        const unavailable = ['read', 'index', 'stats'].map((command, index) => handle(event, { session, request: { id: index + 3, command } }));
        const foreign = new EventEmitter();
        foreign.isDestroyed = () => false;
        const denied = [];
        foreign.send = (channel, response) => denied.push(response);
        const disposal = handle({ sender: foreign }, { session, request: { command: 'dispose' } });
        assert.match(responses.get(2).error, /already open/);
        for (const id of [3, 4, 5]) {
            assert.match(responses.get(id).error, /not ready/);
        }
        assert.match(denied[0].error, /owner/);
        assert.equal(sender.listenerCount('destroyed'), 1);
        await Promise.all([pending, duplicate, ...unavailable, disposal]);
        assert.equal(responses.get(1).error, undefined);
        await handle(event, { session, request: { id: 6, command: 'stats' } });
        assert.equal(responses.get(6).error, undefined);
        assert.equal(sender.listenerCount('destroyed'), 1);
    } finally {
        sender.emit('destroyed');
        await pending;
    }
});

test('Electron broker preserves request IDs, bounds reads, checks owners and closes destroyed sessions', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fastron-electron-source-'));
    const file = path.join(folder, 'model.safetensors');
    const header = Buffer.from(JSON.stringify({ weight: { dtype: 'F32', shape: [2097152], data_offsets: [0, 8388608] } }));
    const prefix = Buffer.alloc(8);
    prefix.writeBigUInt64LE(BigInt(header.length));
    fs.writeFileSync(file, Buffer.concat([prefix, header, Buffer.from([0, 0, 192, 63])]));
    fs.truncateSync(file, 8 + header.length + 8388608);
    const ipc = new EventEmitter();
    registerModelSources(ipc);
    const session = crypto.randomUUID();
    const sender = new EventEmitter();
    sender.isDestroyed = () => false;
    const rpc = (owner, id, command, args = {}) => new Promise((resolve) => {
        owner.send = (channel, response) => resolve(response);
        ipc.emit('model-source', { sender: owner }, { session, request: { ...args, id, command } });
    });
    try {
        const opened = await rpc(sender, 73, 'open', { input: { path: file } });
        assert.equal(opened.error, undefined);
        const descriptor = opened.result;
        assert.ok(descriptor.metadata.byteLength < 1024);
        const read = await rpc(sender, 91, 'read', { file: descriptor.key, version: descriptor.version, offset: 8 + header.length, length: 4 });
        assert.equal(read.id, 91);
        assert.equal(new DataView(read.result).getFloat32(0, true), 1.5);
        const foreign = new EventEmitter();
        foreign.isDestroyed = () => false;
        const denied = await rpc(foreign, 5, 'open', { input: { path: file } });
        assert.match(denied.error, /owner/);
        const oversized = await rpc(sender, 92, 'read', { file: descriptor.key, version: descriptor.version, offset: 0, length: 8388608 });
        assert.match(oversized.error, /Invalid/);
        const stats = await rpc(sender, 103, 'stats');
        assert.equal(stats.error, undefined);
        assert.ok(stats.result.readBytes < 131072);
        sender.emit('destroyed');
        // The main-process cache survives the source session/worker lifetime.
        const reopened = await rpc(sender, 105, 'open', { input: { path: file } });
        assert.equal(reopened.error, undefined);
        assert.deepEqual(reopened.result.metadata, descriptor.metadata);
        assert.deepEqual((await rpc(sender, 106, 'stats')).result, { readBytes: 0, readRequests: 0, indexCacheHits: 1 });
        const cachedRead = await rpc(sender, 107, 'read', { file: descriptor.key, version: descriptor.version, offset: 8 + header.length, length: 4 });
        assert.equal(new DataView(cachedRead.result).getFloat32(0, true), 1.5);
        fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
        const staleRead = await rpc(sender, 108, 'read', { file: descriptor.key, version: descriptor.version, offset: 8 + header.length, length: 4 });
        assert.match(staleRead.error, /changed/);
        sender.emit('destroyed');
        const closed = await rpc(sender, 104, 'stats');
        assert.match(closed.error, /closed/);
        assert.equal(sender.listenerCount('destroyed'), 0);
    } finally {
        sender.emit('destroyed');
        fs.rmSync(folder, { recursive: true, force: true });
    }
});
