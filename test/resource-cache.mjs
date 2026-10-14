import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as vm from 'node:vm';
import { BinaryStream } from '../source/base.js';
import { test } from 'node:test';

const createHost = async (target, fetch) => {
    if (target === 'browser') {
        const source = await fs.readFile(new URL('../source/browser.js', import.meta.url), 'utf8');
        const start = source.indexOf('    async request(file, encoding, base) {');
        const end = source.indexOf('\n    openURL(', start);
        const request = vm.runInNewContext(`({ ${source.slice(start, end)} }).request`);
        return { request, _url: (file) => `assets/${file}`, async _request(url, headers, encoding) {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }
            return encoding ? response.text() : new BinaryStream(new Uint8Array(await response.arrayBuffer()));
        } };
    }
    const source = await fs.readFile(new URL('../vscode-extension/webview/comparator.html', import.meta.url), 'utf8');
    const start = source.indexOf('    class ComparatorBrowserHost {');
    const end = source.indexOf('\n    const host = new ComparatorBrowserHost();', start);
    const Host = vm.runInNewContext(`${source.slice(start, end)}; ComparatorBrowserHost`, {
        fetch, window: { document: {} }, BinaryStream, Uint8Array
    });
    return new Host();
};

const response = (text = 'examples') => ({ ok: true, text: async () => text,
    arrayBuffer: async () => new Uint8Array([1, 2]).buffer });

for (const target of ['browser', 'vscode']) {
    test(`${target} shares failed static requests and permits one successful retry`, async () => {
        let calls = 0;
        let reject = null;
        const pending = new Promise((resolve, fail) => {
            reject = fail;
        });
        const host = await createHost(target, () => {
            calls++;
            return calls === 1 ? pending : Promise.resolve(response());
        });
        const first = host.request('onnx-metadata-examples.json', 'utf-8', null);
        const second = host.request('onnx-metadata-examples.json', 'utf-8', null);
        const failure = Promise.allSettled([first, second]);
        assert.equal(calls, 1);
        reject(new Error('Temporary network failure'));
        assert.ok((await failure).every((result) => result.status === 'rejected' && result.reason.message === 'Temporary network failure'));
        assert.deepEqual(await Promise.all([
            host.request('onnx-metadata-examples.json', 'utf-8', null),
            host.request('onnx-metadata-examples.json', 'utf-8', null)
        ]), ['examples', 'examples']);
        assert.equal(calls, 2);
        assert.equal(await host.request('onnx-metadata-examples.json', 'utf-8', null), 'examples');
        assert.equal(calls, 2);
    });

    test(`${target} retries HTTP and response-body failures without poisoning the cache`, async () => {
        let calls = 0;
        const host = await createHost(target, async () => {
            calls++;
            if (calls === 1) {
                return { ok: false, status: 503 };
            }
            if (calls === 2) {
                return { ok: true, text: async () => {
                    throw new Error('Interrupted response');
                } };
            }
            return response();
        });
        await assert.rejects(host.request('keras-metadata-examples.json', 'utf-8', null), /503/);
        await assert.rejects(host.request('keras-metadata-examples.json', 'utf-8', null), /Interrupted response/);
        assert.equal(await host.request('keras-metadata-examples.json', 'utf-8', null), 'examples');
        assert.equal(calls, 3);
    });

    test(`${target} keeps successful text and binary resources separately cached`, async () => {
        let calls = 0;
        const host = await createHost(target, async () => {
            calls++;
            return response();
        });
        assert.equal(await host.request('asset.json', 'utf-8', null), 'examples');
        const binary = await host.request('asset.json', null, null);
        assert.deepEqual(Array.from(binary.peek()), [1, 2]);
        assert.equal(await host.request('asset.json', null, null), binary);
        assert.equal(await host.request('asset.json', 'utf-8', null), 'examples');
        assert.equal(calls, 2);
    });
}
