import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { validateMetadataAssets } from '../tools/metadata-assets.mjs';

test('every shipped slim metadata asset preserves its original and examples', async () => {
    assert.ok((await validateMetadataAssets()).size > 0);
});

test('packaging rejects missing or changed metadata and incomplete examples', async () => {
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'fastron-metadata-'));
    const write = (name, data) => fs.writeFile(path.join(folder, name), JSON.stringify(data));
    const full = [{ name: 'Op', version: 1, examples: [{ code: 'x' }] }];
    try {
        await write('test-metadata.json', full);
        await assert.rejects(validateMetadataAssets(folder), /ENOENT/);
        await write('test-metadata.slim.json', [{ name: 'Op', version: 1 }]);
        await write('test-metadata-examples.json', {});
        await assert.rejects(validateMetadataAssets(folder), /examples for Op/);
        await write('test-metadata-examples.json', { Op: [{ code: 'x' }] });
        assert.deepEqual(await validateMetadataAssets(folder), new Set(['test-metadata.json']));
        await write('test-metadata.slim.json', [{ name: 'Op', version: 2 }]);
        await assert.rejects(validateMetadataAssets(folder), /slim metadata differs/);
    } finally {
        await fs.rm(folder, { recursive: true, force: true });
    }
});
