import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModelSource } from '../out/modelSource.js';

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'fastron-vscode-source-'));
const file = path.join(folder, 'model.safetensors');
const header = Buffer.from(JSON.stringify({ weight: { dtype: 'F32', shape: [2097152], data_offsets: [0, 8388608] } }));
const prefix = Buffer.alloc(8);
prefix.writeBigUInt64LE(BigInt(header.length));
fs.writeFileSync(file, Buffer.concat([prefix, header, Buffer.from([0, 0, 192, 63])]));
fs.truncateSync(file, 8 + header.length + 8388608);
const source = new ModelSource(new URL('../', import.meta.url).pathname);
try {
    const descriptor = await source.request('open', { input: { path: file } });
    assert.ok(descriptor.metadata.byteLength < 1024);
    let response = null;
    const webview = { postMessage(message) { response = message; return Promise.resolve(true); } };
    await source.respond(webview, 'main', { id: 73, command: 'read', file: descriptor.key, version: descriptor.version, offset: 8 + header.length, length: 4 });
    assert.equal(response.command, 'model_source_result');
    assert.equal(response.model, 'main');
    assert.equal(response.response.id, 73);
    assert.equal(new DataView(response.response.result).getFloat32(0, true), 1.5);
    await source.respond(webview, 'main', { id: 74, command: 'open', input: { path: '/unapproved' } });
    assert.match(response.response.error, /Unsupported/);
    await source.respond(webview, 'main', { id: 75, command: 'index', file: '../unapproved' });
    assert.ok(response.response.error);
    assert.ok((await source.request('stats')).readBytes < 131072);
    source.dispose();
    await assert.rejects(source.request('stats'), /closed/);
    process.stdout.write('VS Code source bridge: bounded transfer, exact values, request restrictions, disposal passed.\n');
} finally {
    source.dispose();
    fs.rmSync(folder, { recursive: true, force: true });
}
