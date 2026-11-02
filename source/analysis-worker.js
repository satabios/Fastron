import { instantiateAnalysis } from './graph-analysis.mjs';

const native = typeof process !== 'undefined' && process.versions?.node;
const port = native ? (await import('node:worker_threads')).parentPort : self;
let wasm = null;
let handle = 0;
let running = false;
let projections = 0;
const initialized = instantiateAnalysis().then((instance) => {
    wasm = instance;
    handle = wasm.analysis_new();
});
initialized.catch(() => {});
const error = () => new Error(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.analysis_error(handle), wasm.analysis_error_len(handle))));
const output = () => JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, wasm.analysis_output(handle), wasm.analysis_output_len(handle))));
const input = (bytes) => {
    const pointer = wasm.analysis_input(handle, bytes.byteLength);
    if (!pointer && bytes.byteLength) {
        throw error();
    }
    new Uint8Array(wasm.memory.buffer, pointer, bytes.byteLength).set(bytes);
};
const receive = async (message) => {
    const { id, command } = message;
    try {
        await initialized;
        let result = null;
        switch (command) {
            case 'upload':
                if (running) {
                    throw new Error('Cannot upload while analysis is running.');
                }
                input(new Uint8Array(message.bytes));
                result = wasm.analysis_upload(handle) >>> 0;
                if (result === 0xffffffff) {
                    throw error();
                }
                break;
            case 'compare': {
                if (running) {
                    throw new Error('An analysis job is already running.');
                }
                const pair = wasm.analysis_start(handle, message.a, message.b) >>> 0;
                if (pair === 0xffffffff) {
                    throw error();
                }
                running = true;
                const started = performance.now();
                let lastProgress = started;
                try {
                    let done = false;
                    while (!done) {
                        const deadline = performance.now() + 8;
                        do {
                            const status = wasm.analysis_step(handle, 1024);
                            if (status < 0) {
                                throw error();
                            }
                            done = Boolean(status);
                        } while (!done && performance.now() < deadline);
                        if (!done) {
                            if (performance.now() - lastProgress > 100) {
                                port.postMessage({ event: 'progress', elapsed: performance.now() - started });
                                lastProgress = performance.now();
                            }
                            // Yield so cancellation and inspections are not held behind a long WASM call.
                            // eslint-disable-next-line no-await-in-loop
                            await new Promise((resolve) => {
                                setTimeout(resolve, 0);
                            });
                        }
                    }
                    if (wasm.analysis_result(handle, pair) < 0) {
                        throw error();
                    }
                    result = output();
                } finally {
                    running = false;
                }
                break;
            }
            case 'result':
                if (wasm.analysis_result(handle, message.pair) < 0) {
                    throw error();
                }
                result = output();
                break;
            case 'project': {
                if (running) {
                    throw new Error('Matching is still pending.');
                }
                projections++;
                try {
                    let done = false;
                    while (!done) {
                        const deadline = performance.now() + 8;
                        do {
                            const status = wasm.analysis_group_step(handle, message.graph, 1024);
                            if (status < 0) {
                                throw error();
                            }
                            done = Boolean(status);
                        } while (!done && performance.now() < deadline);
                        if (!done) {
                            // eslint-disable-next-line no-await-in-loop
                            await new Promise((resolve) => {
                                setTimeout(resolve, 0);
                            });
                        }
                    }
                    input(new Uint8Array(new Uint32Array(message.expanded).buffer));
                    if (wasm.analysis_project(handle, message.graph, message.pair, message.side, Number(message.initialize)) < 0) {
                        throw error();
                    }
                    result = output();
                } finally {
                    projections--;
                }
                break;
            }
            case 'dispose':
                if (running || projections) {
                    throw new Error('Terminate the worker to cancel a running analysis.');
                }
                wasm.analysis_free(handle); handle = 0;
                break;
            default: throw new Error(`Unsupported analysis command '${command}'.`);
        }
        port.postMessage({ id, result });
        if (command === 'dispose') {
            port.close();
        }
    } catch (err) {
        port.postMessage({ id, error: err.message });
    }
};
if (native) {
    port.on('message', receive);
} else {
    port.addEventListener('message', (event) => receive(event.data));
}
