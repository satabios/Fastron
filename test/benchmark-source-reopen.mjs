// Same-process native ONNX opens. Fresh workers, uncontrolled OS/server caches.
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as mock from './mock.js';
import * as path from 'node:path';
import { ModelFactoryService } from '../source/view.js';
import { openSource } from '../source/model-source.mjs';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const filename = process.argv[2];
if (!filename) {
    throw new Error('Supply an ONNX model path and optional JSON output path.');
}
globalThis.window = { NETRON_CONFIG: { skipTensorWeights: true } };
const host = new mock.Host({ serial: true });
host.require = (id) => import(pathToFileURL(path.resolve('source', `${id}.js`)).href);
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const report = { filename, node: process.version, scope: 'Three same-process native opens, each with a fresh worker. Source/index and parse only; no layout, Electron IPC or paint. OS/server caches uncontrolled.', trials: [] };
const save = () => {
    if (process.argv[3]) {
        fs.mkdirSync(path.dirname(path.resolve(process.argv[3])), { recursive: true });
        fs.writeFileSync(process.argv[3], JSON.stringify(report, null, 2));
    }
};
for (let trial = 0; trial < 3; trial++) {
    const started = performance.now();
    // eslint-disable-next-line no-await-in-loop
    const context = await openSource(host, { path: filename });
    const openMs = performance.now() - started;
    try {
        assert.equal(context.indexedFormat, 'onnx');
        // eslint-disable-next-line no-await-in-loop
        const source = await context.source.request('stats');
        const metadataSha256 = hash(context.stream.peek());
        const rangesSha256 = hash(JSON.stringify(context.stream.tensorRanges));
        const parseStarted = performance.now();
        // eslint-disable-next-line no-await-in-loop
        const model = await new ModelFactoryService(host).open(context);
        const parseMs = performance.now() - parseStarted;
        assert.equal(host.errors.length, 0);
        const result = { trial: trial + 1, openMs, parseMs, source, metadataSha256, rangesSha256, nodes: model.modules[0].nodes.length };
        if (trial > 0) {
            assert.equal(source.indexCacheHits, 1);
            assert.equal(source.readBytes, 0);
            assert.equal(metadataSha256, report.trials[0].metadataSha256);
            assert.equal(rangesSha256, report.trials[0].rangesSha256);
            assert.equal(result.nodes, report.trials[0].nodes);
        } else {
            assert.equal(source.indexCacheHits, 0);
        }
        report.trials.push(result);
        save();
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
        context.source.dispose();
    }
}
report.hashesMatch = true;
save();