// Load-only benchmark: no validation, tensor inspection, layout, or rendering.
// Usage: node test/benchmark-onnx.js --runs 3 --timeout 240000 <model paths...>
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const self = fileURLToPath(import.meta.url);
const median = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

const child = async (mode, filename) => {
    // Must precede importing view.js: ordinary Node tests have no global window.
    globalThis.window = { NETRON_CONFIG: { skipTensorWeights: true } };
    const node = await import('../source/node.js');
    const mock = await import('./mock.js');
    const view = await import('../source/view.js');
    const { openSource } = await import('../source/model-source.mjs');
    const streams = new Set();
    const files = new Map();
    let readCalls = 0;
    let readBytes = 0;
    let readMilliseconds = 0;
    const originalRead = node.FileStream.prototype._read;
    node.FileStream.prototype._read = function(buffer, offset) {
        streams.add(this);
        const start = process.hrtime.bigint();
        try {
            originalRead.call(this, buffer, offset);
            readCalls++;
            readBytes += buffer.byteLength;
            files.set(this.file, (files.get(this.file) || 0) + buffer.byteLength);
        } finally {
            readMilliseconds += Number(process.hrtime.bigint() - start) / 1e6;
        }
    };
    const host = new mock.Host({ serial: true });
    // Use canonical file URLs for Windows paths, independent of mock.Host.require.
    host.require = (id) => import(pathToFileURL(path.resolve(path.dirname(self), '../source', `${id}.js`)).href);
    const service = new view.ModelFactoryService(host);
    const start = process.hrtime.bigint();
    let result = null;
    let context = null;
    try {
        const stat = fs.statSync(filename);
        if (mode === 'indexed') {
            context = await openSource(host, { path: filename });
            if (context.indexedFormat !== 'onnx') {
                throw new Error('The model did not use the ONNX index.');
            }
        } else {
            const stream = new node.FileStream(filename, 0, stat.size, stat.mtimeMs);
            streams.add(stream);
            context = new mock.Context(host, path.dirname(filename), path.basename(filename), stream, new Map());
        }
        const indexMilliseconds = Number(process.hrtime.bigint() - start) / 1e6;
        const model = await service.open(context);
        const loadMilliseconds = Number(process.hrtime.bigint() - start) / 1e6;
        if (!model || host.errors.length) {
            throw new Error(host.errors.map((error) => error.message).join('; ') || 'No model returned.');
        }
        const graphs = model.graphs || model.modules || [];
        result = {
            status: 'ok', mode, filename, fileBytes: stat.size, format: model.format,
            graphs: graphs.length,
            nodes: graphs.reduce((sum, graph) => sum + (graph.nodes || []).length, 0),
            loadMilliseconds, indexMilliseconds,
            parseMilliseconds: loadMilliseconds - indexMilliseconds
        };
        if (context.source) {
            const stats = await context.source.request('stats');
            readBytes += stats.readBytes;
            // Worker stats count payload requests, not indexing read calls.
            readCalls = null;
            readMilliseconds = null;
            result.payloadRequests = stats.readRequests;
        }
    } catch (error) {
        result = { status: 'error', mode, filename, error: error.stack || error.message };
    } finally {
        context?.source?.dispose();
        for (const stream of streams) {
            stream.dispose();
        }
        node.FileStream.prototype._read = originalRead;
    }
    Object.assign(result, {
        readCalls, readBytes, readMilliseconds,
        peakRssMiB: process.resourceUsage().maxRSS / 1024,
        files: Array.from(files, ([filename, bytes]) => ({ filename, bytes }))
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
};

const main = () => {
    const args = process.argv.slice(2);
    const options = { runs: 3, timeout: 240000, output: path.resolve('dist/benchmark-onnx/results.json') };
    const filenames = [];
    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--runs' || arg === '--timeout' || arg === '--output') {
            const value = args[++index];
            if (!value) {
                throw new Error(`Missing value for ${arg}.`);
            }
            options[arg.slice(2)] = arg === '--output' ? path.resolve(value) : Number(value);
        } else if (arg.startsWith('--')) {
            throw new Error(`Unknown option ${arg}.`);
        } else {
            filenames.push(path.resolve(arg));
        }
    }
    if (!filenames.length || !Number.isInteger(options.runs) || options.runs < 1 ||
        !Number.isInteger(options.timeout) || options.timeout < 1) {
        throw new Error('Supply model paths, a positive --runs count, and a positive --timeout in milliseconds.');
    }
    const report = {
        started: new Date().toISOString(), node: process.version, platform: process.platform,
        revision: spawnSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf-8' }).stdout.trim(),
        osRelease: os.release(), totalMemoryGiB: os.totalmem() / 2 ** 30,
        cpu: os.cpus()[0]?.model, options,
        scope: 'Rust indexed worker loader versus legacy JS FileStream loader; skipTensorWeights=true in both; no layout/render or forced external-weight reads.',
        cache: 'Uncontrolled client/server filesystem caches; fresh child process per trial; alternating mode order.',
        io: 'Application source bytes, not SMB wire bytes. Legacy calls count FileStream reads; indexed call/time counters unavailable. Index includes worker startup/WASM compile.',
        trials: [], summary: []
    };
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    const save = () => fs.writeFileSync(options.output, `${JSON.stringify(report, null, 2)}\n`);
    save();
    for (const filename of filenames) {
        for (let trial = 1; trial <= options.runs; trial++) {
            const modes = trial % 2 ? ['indexed', 'legacy'] : ['legacy', 'indexed'];
            for (const mode of modes) {
                process.stdout.write(`Trial ${trial}/${options.runs} ${mode}: ${filename}\n`);
                const run = spawnSync(process.execPath, ['--max-old-space-size=4096', self, '--child', mode, filename], {
                    encoding: 'utf-8', timeout: options.timeout, maxBuffer: 4 * 1024 * 1024,
                    windowsHide: true
                });
                let result = null;
                try {
                    if (run.error || run.status !== 0) {
                        throw run.error || new Error(`Child exited ${run.status}: ${run.stderr}`);
                    }
                    result = JSON.parse(run.stdout.trim());
                } catch (error) {
                    result = { filename, mode, status: 'error', error: error.message, stderr: run.stderr };
                }
                report.trials.push({ trial, ...result });
                save();
                process.stdout.write(result.status === 'ok' ?
                    `  ${(result.loadMilliseconds / 1000).toFixed(3)} s, ${(result.readBytes / 2 ** 20).toFixed(2)} MiB read, peak RSS ${result.peakRssMiB.toFixed(0)} MiB\n` :
                    `  ERROR: ${result.error}\n`);
            }
        }
        const trials = report.trials.filter((entry) => entry.filename === filename);
        const good = trials.filter((entry) => entry.status === 'ok');
        const signatures = new Set(good.map((entry) => JSON.stringify([entry.format, entry.graphs, entry.nodes])));
        const summary = { filename, successfulTrials: good.length, expectedTrials: options.runs * 2,
            graphCountsMatch: good.length === options.runs * 2 && signatures.size === 1 };
        for (const mode of ['legacy', 'indexed']) {
            const entries = good.filter((entry) => entry.mode === mode);
            if (entries.length) {
                summary[mode] = {
                    trials: entries.length,
                    medianMilliseconds: median(entries.map((entry) => entry.loadMilliseconds)),
                    minMilliseconds: Math.min(...entries.map((entry) => entry.loadMilliseconds)),
                    maxMilliseconds: Math.max(...entries.map((entry) => entry.loadMilliseconds)),
                    medianReadBytes: median(entries.map((entry) => entry.readBytes)),
                    medianPeakRssMiB: median(entries.map((entry) => entry.peakRssMiB))
                };
            }
        }
        if (summary.legacy && summary.indexed && summary.graphCountsMatch) {
            summary.speedup = summary.legacy.medianMilliseconds / summary.indexed.medianMilliseconds;
            summary.readReductionPercent = 100 * (1 - summary.indexed.medianReadBytes / summary.legacy.medianReadBytes);
        }
        report.summary.push(summary);
        save();
        process.stdout.write(`SUMMARY ${JSON.stringify(summary)}\n`);
    }
    report.finished = new Date().toISOString();
    save();
    process.stdout.write(`Report: ${options.output}\n`);
    if (report.trials.some((entry) => entry.status !== 'ok') || report.summary.some((entry) => !entry.graphCountsMatch)) {
        process.exitCode = 1;
    }
};

if (process.argv[2] === '--child') {
    await child(process.argv[3], process.argv[4]);
} else {
    main();
}