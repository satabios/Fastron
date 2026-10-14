import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventEmitter } from 'node:events';
import { registerModelSources } from '../source/model-source-electron.mjs';
import { test } from 'node:test';

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
        const closed = await rpc(sender, 104, 'stats');
        assert.match(closed.error, /closed/);
        assert.equal(sender.listenerCount('destroyed'), 0);
    } finally {
        sender.emit('destroyed');
        fs.rmSync(folder, { recursive: true, force: true });
    }
});
