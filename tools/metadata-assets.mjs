import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as url from 'node:url';

// Packaging may omit originals only when slim metadata and its examples preserve every field.
export const validateMetadataAssets = async (directory = url.fileURLToPath(new URL('../source/', import.meta.url))) => {
    const originals = (await fs.readdir(directory)).filter((file) => file.endsWith('-metadata.json'));
    await Promise.all(originals.map(async (file) => {
        const read = async (name) => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8'));
        const full = await read(file);
        const slim = await read(file.replace('.json', '.slim.json'));
        const documented = full.filter((type) => type.examples && type.examples.length > 0);
        const examples = documented.length > 0 ? await read(file.replace('-metadata.json', '-metadata-examples.json')) : {};
        for (const type of documented) {
            assert.deepEqual(type.examples, examples[type.name], `${file}: examples for ${type.name}`);
        }
        const expected = full.map((type) => {
            const result = { ...type };
            if (result.examples && result.examples.length > 0) {
                delete result.examples;
            }
            return result;
        });
        assert.deepEqual(slim, expected, `${file}: slim metadata differs`);
    }));
    return new Set(originals);
};

export default async () => {
    await validateMetadataAssets();
};
