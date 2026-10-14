import * as assert from 'node:assert/strict';
import * as base from '../source/base.js';
import * as mock from './mock.js';
import * as view from '../source/view.js';
import { test } from 'node:test';

const context = (host, identifier, obj) => new mock.Context(host, '', identifier,
    new base.BinaryStream(new TextEncoder().encode(JSON.stringify(obj))));

const documentation = (host) => {
    const instance = Object.create(view.View.prototype);
    instance._host = host;
    instance._sidebar = { _stack: [], entries: [], push(sidebar) {
        sidebar.render();
        this.entries.push(sidebar);
    } };
    return instance;
};

test('simultaneous ONNX opens share metadata and defer examples until documentation', async () => {
    const onnx = await import('../source/onnx.js?metadata-concurrency');
    const host = new mock.Host({});
    const require = host.require.bind(host);
    host.require = (id) => id === './onnx' ? Promise.resolve(onnx) : require(id);
    const requests = [];
    host.request = async (name) => {
        requests.push(name);
        await Promise.resolve();
        if (name === 'onnx-metadata.slim.json') {
            return JSON.stringify([{ name: 'Add', module: 'ai.onnx', version: 1, category: 'Math', description: 'Adds values.' }]);
        }
        if (name === 'onnx-metadata-examples.json') {
            return JSON.stringify({ Add: [{ summary: 'Example', code: 'a + b' }] });
        }
        throw new Error(`Unexpected request '${name}'`);
    };
    const model = { irVersion: '8', graph: { node: [{ opType: 'Add', input: ['a', 'b'], output: ['c'] }] } };
    const service = new view.ModelFactoryService(host);
    const models = await Promise.all([
        service.open(context(host, 'a.onnx', model)),
        service.open(context(host, 'b.onnx', model))
    ]);
    assert.equal(requests.filter((name) => name === 'onnx-metadata.slim.json').length, 1);
    assert.equal(requests.filter((name) => name === 'onnx-metadata-examples.json').length, 0);
    for (const model of models) {
        assert.equal(model.modules[0].nodes[0].type.name, 'Add');
        assert.equal(model.modules[0].nodes[0].type.category, 'Math');
        assert.equal(model.modules[0].nodes[0].type.examples, undefined);
    }
    // ONNX fixups and other readers spread schemas before examples have loaded.
    const types = models.map((model) => ({ ...model.modules[0].nodes[0].type }));
    const viewers = types.map(() => documentation(host));
    await Promise.all(viewers.map((viewer, i) => viewer.showDefinition(types[i])));
    assert.equal(requests.filter((name) => name === 'onnx-metadata-examples.json').length, 1);
    for (let i = 0; i < viewers.length; i++) {
        assert.equal(types[i].examples[0].code, 'a + b');
        assert.equal(viewers[i]._sidebar.entries[0].element.childNodes.find((element) => element.tagName === 'PRE').innerHTML, 'a + b');
    }
});

test('simultaneous Keras opens share generic metadata and preserve fallback', async () => {
    const host = new mock.Host({});
    const requests = [];
    host.request = async (name) => {
        requests.push(name);
        await Promise.resolve();
        if (name === 'keras-metadata.slim.json') {
            throw new Error('Slim metadata unavailable');
        }
        if (name === 'keras-metadata.json') {
            return JSON.stringify([{ name: 'Dense', category: 'Layer', examples: [{ code: 'Dense(2)' }] }]);
        }
        throw new Error(`File not found '${name}'`);
    };
    const model = { class_name: 'Sequential', config: { name: 'test', layers: [{ class_name: 'Dense', config: { name: 'dense', units: 2 } }] } };
    const service = new view.ModelFactoryService(host);
    const models = await Promise.all([
        service.open(context(host, 'a.json', model)),
        service.open(context(host, 'b.json', model))
    ]);
    assert.equal(requests.filter((name) => name === 'keras-metadata.slim.json').length, 1);
    assert.equal(requests.filter((name) => name === 'keras-metadata.json').length, 1);
    for (const model of models) {
        assert.equal(model.modules[0].nodes[0].type.name, 'Dense');
        assert.equal(model.modules[0].nodes[0].type.category, 'Layer');
        assert.equal(model.modules[0].nodes[0].type.examples[0].code, 'Dense(2)');
        assert.equal(model.modules[0].nodes[0].type.loadExamples, undefined);
    }
    assert.equal(requests.filter((name) => name.includes('-examples')).length, 0);
});

test('Keras documentation shares retryable lazy examples and preserves cloned types', async () => {
    const freshView = await import('../source/view.js?lazy-keras-examples');
    const host = new mock.Host({});
    let attempts = 0;
    const requests = [];
    host.request = async (name) => {
        requests.push(name);
        if (name === 'keras-metadata.slim.json') {
            return JSON.stringify([{ name: 'Dense', description: 'A dense layer.' }]);
        }
        assert.equal(name, 'keras-metadata-examples.json');
        if (++attempts === 1) {
            throw new Error('Temporary network failure');
        }
        return JSON.stringify({ Dense: [{ summary: 'Dense layer', code: 'Dense(2)' }] });
    };
    const service = new freshView.ModelFactoryService(host);
    service._openContext = async (context) => (await context.metadata('keras-metadata.json')).type('Dense');
    const type = await service.open(context(host, 'keras.json', {}));
    assert.deepEqual(requests, ['keras-metadata.slim.json']);
    const clone = { ...type };
    const viewers = [documentation(host), documentation(host)];
    await Promise.all(viewers.map((viewer) => viewer.showDefinition(clone)));
    assert.equal(attempts, 1);
    assert.ok(viewers.every((viewer) => viewer._sidebar.entries.length === 1));
    assert.equal(clone.examples, undefined);
    await viewers[0].showDefinition(clone);
    assert.equal(attempts, 2);
    assert.equal(clone.examples[0].code, 'Dense(2)');
    assert.equal(viewers[0]._sidebar.entries[1].element.childNodes.find((element) => element.tagName === 'PRE').innerHTML, 'Dense(2)');
    await type.loadExamples();
    assert.equal(attempts, 2);
});

test('ONNX example failures retry without reloading metadata', async () => {
    const onnx = await import('../source/onnx.js?lazy-example-retry');
    const host = new mock.Host({});
    const require = host.require.bind(host);
    host.require = (id) => id === './onnx' ? Promise.resolve(onnx) : require(id);
    let metadataRequests = 0;
    let attempts = 0;
    host.request = async (name) => {
        if (name === 'onnx-metadata.slim.json') {
            metadataRequests++;
            return JSON.stringify([{ name: 'Add', module: 'ai.onnx', version: 1, description: 'Adds values.' }]);
        }
        assert.equal(name, 'onnx-metadata-examples.json');
        return ++attempts === 1 ? 'malformed' : JSON.stringify({ Add: [{ code: 'a + b' }] });
    };
    const model = { irVersion: '8', graph: { node: [{ opType: 'Add', input: ['a', 'b'], output: ['c'] }] } };
    const result = await new view.ModelFactoryService(host).open(context(host, 'retry.onnx', model));
    const type = { ...result.modules[0].nodes[0].type };
    const viewer = documentation(host);
    await viewer.showDefinition(type);
    assert.equal(type.examples, undefined);
    await viewer.showDefinition(type);
    assert.equal(type.examples[0].code, 'a + b');
    assert.equal(attempts, 2);
    assert.equal(metadataRequests, 1);
});

test('ONNX full metadata fallback keeps examples without a separate request', async () => {
    const onnx = await import('../source/onnx.js?full-example-fallback');
    const host = new mock.Host({});
    const require = host.require.bind(host);
    host.require = (id) => id === './onnx' ? Promise.resolve(onnx) : require(id);
    const requests = [];
    host.request = async (name) => {
        requests.push(name);
        if (name === 'onnx-metadata.slim.json') {
            throw new Error('Slim metadata unavailable');
        }
        assert.equal(name, 'onnx-metadata.json');
        return JSON.stringify([{ name: 'Add', module: 'ai.onnx', version: 1, description: 'Adds values.', examples: [{ code: 'a + b' }] }]);
    };
    const model = { irVersion: '8', graph: { node: [{ opType: 'Add', input: ['a', 'b'], output: ['c'] }] } };
    const result = await new view.ModelFactoryService(host).open(context(host, 'fallback.onnx', model));
    const type = result.modules[0].nodes[0].type;
    await documentation(host).showDefinition(type);
    assert.equal(type.examples[0].code, 'a + b');
    assert.equal(type.loadExamples, undefined);
    assert.deepEqual(requests, ['onnx-metadata.slim.json', 'onnx-metadata.json']);
});

test('formats without example assets make no missing-file requests', async () => {
    const freshView = await import('../source/view.js?no-example-asset');
    const host = new mock.Host({});
    const requests = [];
    host.request = async (name) => {
        requests.push(name);
        assert.equal(name, 'tflite-metadata.slim.json');
        return JSON.stringify([{ name: 'ADD', description: 'Adds values.' }]);
    };
    const service = new freshView.ModelFactoryService(host);
    service._openContext = async (context) => (await context.metadata('tflite-metadata.json')).type('ADD');
    const type = await service.open(context(host, 'tflite.json', {}));
    await documentation(host).showDefinition(type);
    assert.deepEqual(requests, ['tflite-metadata.slim.json']);
    assert.equal(type.loadExamples, undefined);
});

test('lazy examples use detached static requests after model contexts close', async () => {
    await Promise.all(['onnx', 'keras'].map(async (format) => {
        const freshView = await import(`../source/view.js?detached-${format}`);
        const host = new mock.Host({});
        const require = host.require.bind(host);
        const onnx = await import(`../source/onnx.js?detached-${format}`);
        host.require = (id) => id === './onnx' ? Promise.resolve(onnx) : require(id);
        let exampleRequests = 0;
        const name = format === 'onnx' ? 'Add' : 'Dense';
        host.request = async (file, encoding, base) => {
            if (file === `${format}-metadata.slim.json`) {
                return JSON.stringify([{ name, module: 'ai.onnx', version: 1, description: 'Documentation.' }]);
            }
            assert.equal(file, `${format}-metadata-examples.json`);
            assert.equal(encoding, 'utf-8');
            assert.equal(base, null);
            exampleRequests++;
            return JSON.stringify({ [name]: [{ code: 'retained documentation' }] });
        };
        const service = new freshView.ModelFactoryService(host);
        const open = service._openContext.bind(service);
        let modelContext = null;
        service._openContext = (context) => {
            modelContext = context;
            return open(context);
        };
        const model = format === 'onnx' ? { irVersion: '8', graph: { node: [{ opType: 'Add', input: ['a', 'b'], output: ['c'] }] } } :
            { class_name: 'Sequential', config: { name: 'test', layers: [{ class_name: 'Dense', config: { name: 'dense', units: 2 } }] } };
        const result = await service.open(context(host, `${format}.json`, model));
        const type = { ...result.modules[0].nodes[0].type };
        modelContext.request = () => {
            throw new Error('The model context has closed');
        };
        modelContext._context = null;
        modelContext._stream = null;
        modelContext._content.clear();
        await documentation(host).showDefinition(type);
        assert.equal(exampleRequests, 1);
        assert.equal(type.examples[0].code, 'retained documentation');
    }));
});

test('companion contexts preserve explicit detached static-resource capabilities', async () => {
    const freshView = await import('../source/view.js?detached-companion');
    const host = new mock.Host({});
    let exampleRequests = 0;
    host.request = async (file) => {
        if (file === 'companion.json') {
            return new base.BinaryStream(new TextEncoder().encode('{}'));
        }
        assert.equal(file, 'keras-metadata.slim.json');
        return JSON.stringify([{ name: 'Dense', description: 'Documentation.' }]);
    };
    const source = context(host, 'parent.json', {});
    source.resourceRequest = async (file, encoding, base) => {
        assert.equal(file, 'keras-metadata-examples.json');
        assert.equal(encoding, 'utf-8');
        assert.equal(base, null);
        exampleRequests++;
        return JSON.stringify({ Dense: [{ code: 'companion documentation' }] });
    };
    const service = new freshView.ModelFactoryService(host);
    service._openContext = async (context) => {
        const companion = await context.fetch('companion.json');
        assert.equal(companion.resourceRequest, source.resourceRequest);
        const metadata = await companion.metadata('keras-metadata.json');
        companion.request = () => {
            throw new Error('The companion context has closed');
        };
        return metadata.type('Dense');
    };
    const type = await service.open(source);
    await documentation(host).showDefinition(type);
    assert.equal(exampleRequests, 1);
    assert.equal(type.examples[0].code, 'companion documentation');
});

test('archive metadata keeps documentation independent of closed archive entries', async () => {
    const freshView = await import('../source/view.js?detached-archive');
    const host = new mock.Host({});
    host.request = async (file) => file === 'keras-metadata.slim.json' ?
        JSON.stringify([{ name: 'Dense', description: 'Documentation.' }]) :
        JSON.stringify({ Dense: [{ code: 'archive documentation' }] });
    const service = new freshView.ModelFactoryService(host);
    service._filter = () => ['archive-test'];
    service._require = async () => ({ match: () => true });
    const archive = await service._openEntries(new Map([['model.json', new base.BinaryStream(new TextEncoder().encode('{}'))]]));
    const metadata = await archive.metadata('keras-metadata.json');
    const type = metadata.type('Dense');
    archive._context = null;
    archive._stream = null;
    await documentation(host).showDefinition(type);
    assert.equal(type.examples[0].code, 'archive documentation');
});

test('documentation loaded after navigation cannot reopen a stale sidebar', async () => {
    const host = new mock.Host({});
    let finish = null;
    const loaded = new Promise((resolve) => {
        finish = resolve;
    });
    const type = { name: 'Add', description: 'Adds values.', loadExamples: () => loaded };
    const viewer = documentation(host);
    const pending = viewer.showDefinition(type);
    viewer._sidebar._stack = [];
    finish();
    await pending;
    assert.equal(viewer._sidebar.entries.length, 0);

    let finishSecond = null;
    type.loadExamples = () => new Promise((resolve) => {
        finishSecond = resolve;
    });
    const second = viewer.showDefinition(type);
    await viewer.showDefinition({ name: 'New', description: 'New documentation.' });
    finishSecond();
    await second;
    assert.equal(viewer._sidebar.entries.length, 1);
    assert.equal(viewer._sidebar.entries[0]._type.name, 'New');

    const third = viewer.showDefinition(type);
    viewer._model = {};
    finishSecond();
    await third;
    assert.equal(viewer._sidebar.entries.length, 1);
});

test('malformed shared metadata remains retryable on the next open', async () => {
    const freshView = await import('../source/view.js?metadata-retry');
    const host = new mock.Host({});
    let valid = false;
    host.request = async (name) => {
        if (name === 'keras-metadata.slim.json') {
            return valid ? JSON.stringify([{ name: 'Dense', category: 'Layer' }]) : 'malformed';
        }
        throw new Error(`File not found '${name}'`);
    };
    const model = { class_name: 'Sequential', config: { name: 'test', layers: [{ class_name: 'Dense', config: { name: 'dense', units: 2 } }] } };
    const service = new freshView.ModelFactoryService(host);
    await assert.rejects(service.open(context(host, 'retry.json', model)));
    valid = true;
    const result = await service.open(context(host, 'retry.json', model));
    assert.equal(result.modules[0].nodes[0].type.category, 'Layer');
});
