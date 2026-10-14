import * as assert from 'node:assert/strict';
import * as base from '../source/base.js';
import * as fs from 'node:fs/promises';
import * as vm from 'node:vm';
import { View } from '../source/view.js';
import { test } from 'node:test';

const previousWindow = globalThis.window;
globalThis.window = { document: { documentElement: { style: { scrollBehavior: 'auto' } } } };
const { Host: BrowserHost } = await import('../source/browser.js');
if (previousWindow === undefined) {
    delete globalThis.window;
} else {
    globalThis.window = previousWindow;
}

const deferred = () => {
    let resolve = null;
    let reject = null;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};

const makeContext = (identifier) => {
    const entry = { identifier, disposed: 0, streamClosed: 0 };
    entry.source = { dispose: () => entry.disposed++ };
    entry.stream = { dispose: () => entry.streamClosed++ };
    return entry;
};

const makeView = () => ({
    model: null, shown: [], errors: [], options: {},
    accept: () => true,
    show(value) {
        this.shown.push(value);
    },
    async attach() {
        return false;
    },
    async error(error) {
        this.errors.push(error);
    },
    async open(context) {
        this.model = { _source: context.source };
        return this.model;
    }
});

const browserHost = (view = makeView()) => ({
    _view: view, _telemetry: { set() {} }, document: { title: 'previous' },
    _openContext: BrowserHost.prototype._openContext
});

const desktopMethod = async (recents) => {
    const source = await fs.readFile(new URL('../source/desktop.mjs', import.meta.url), 'utf8');
    const start = source.indexOf('    async _open(location) {');
    const end = source.indexOf('\n    _request(location, headers, timeout) {', start);
    return vm.runInNewContext(`({ ${source.slice(start, end)} })._open`, {
        fs: { existsSync: () => true, statSync: () => ({ isFile: () => true, size: 1 }) },
        electron: { ipcRenderer: { send(command, value) {
            recents.push([command, value.path]);
        } } }
    });
};

test('older parsing cannot supersede a newer model and releases its unused source', async () => {
    const first = makeContext('first');
    const latest = makeContext('latest');
    const pending = deferred();
    const started = deferred();
    const opened = [];
    const app = { _sidebar: { close() {} }, _host: { event() {} }, _timeout: async () => {},
        _modelFactoryService: { async open(context) {
            if (context === first) {
                started.resolve();
                return pending.promise;
            }
            return { _source: context.source, modules: [] };
        } },
        async _updateTarget(model) {
            opened.push(model);
            this._model = model;
            return model;
        }
    };
    const older = View.prototype.open.call(app, first);
    await started.promise;
    const newest = await View.prototype.open.call(app, latest);
    pending.resolve({ _source: first.source, modules: [] });
    assert.equal(await older, undefined);
    assert.equal(app._model, newest);
    assert.deepEqual(opened, [newest]);
    assert.equal(first.disposed, 1);
    assert.equal(latest.disposed, 0);
    assert.equal(app._openingContext, undefined);
});

test('superseded parse errors are silent and preserve sources shared by the latest model', async () => {
    const first = makeContext('first');
    const latest = makeContext('latest');
    latest.source = first.source;
    const pending = deferred();
    const started = deferred();
    const app = { _sidebar: { close() {} }, _host: { event() {} }, _timeout: async () => {},
        _modelFactoryService: { async open(context) {
            if (context === first) {
                started.resolve();
                return pending.promise;
            }
            return { _source: context.source, modules: [] };
        } },
        async _updateTarget(model) {
            this._model = model;
            return model;
        }
    };
    const older = View.prototype.open.call(app, first);
    await started.promise;
    const newest = await View.prototype.open.call(app, latest);
    pending.reject(new Error('Obsolete parse failure'));
    assert.equal(await older, undefined);
    assert.equal(app._model, newest);
    assert.equal(first.disposed, 0);
});

test('browser ignores stale success, error, and explicit superseded completions', async () => {
    const first = makeContext('first');
    const latest = makeContext('latest');
    const pending = deferred();
    const started = deferred();
    const host = browserHost();
    host._view.open = async (context) => {
        if (context === first) {
            started.resolve();
            return pending.promise;
        }
        return {};
    };
    const older = host._openContext(first);
    await started.promise;
    assert.equal(await host._openContext(latest), '');
    const shown = host._view.shown.length;
    pending.resolve({});
    assert.equal(await older, undefined);
    assert.equal(host.document.title, 'latest');
    assert.equal(host._view.shown.length, shown);

    const failing = deferred();
    host._view.open = () => failing.promise;
    const olderFailure = host._openContext(first);
    await Promise.resolve();
    host._view.open = async () => ({});
    await host._openContext(latest);
    failing.reject(new Error('Obsolete load failure'));
    assert.equal(await olderFailure, undefined);
    assert.equal(host._view.errors.length, 0);
    assert.equal(host.document.title, 'latest');

    host._view.open = async () => undefined;
    assert.equal(await host._openContext(first), undefined);
    assert.equal(host.document.title, 'latest');
    host._view.open = async () => null;
    assert.equal(await host._openContext(first), 'context-open-failed');
    assert.equal(host.document.title, '');
});

test('browser request order wins even when older context creation finishes last', async () => {
    const pending = deferred();
    const host = browserHost();
    const opened = [];
    host._request = (url) => url.endsWith('first.json') ? pending.promise : Promise.resolve(new base.BinaryStream(new Uint8Array(0)));
    host._view.open = async (context) => {
        opened.push(context.identifier);
        return {};
    };
    const older = BrowserHost.prototype._openModel.call(host, 'https://example.test/first.json', 'first.json');
    assert.equal(await BrowserHost.prototype._openModel.call(host, 'https://example.test/latest.json', 'latest.json'), '');
    pending.resolve(new base.BinaryStream(new Uint8Array(0)));
    assert.equal(await older, undefined);
    assert.deepEqual(opened, ['latest.json']);
    assert.equal(host.document.title, 'latest.json');
});

test('desktop ignores stale contexts and closes their source and stream', async () => {
    const first = makeContext('first');
    const latest = makeContext('latest');
    const pending = deferred();
    const recents = [];
    const updates = [];
    const titles = [];
    const opened = [];
    const open = await desktopMethod(recents);
    const host = { _view: makeView(), _telemetry: { set() {} },
        _context: (path) => path === 'first' ? pending.promise : Promise.resolve(latest),
        _title: (title) => titles.push(title), update: (options) => updates.push(options)
    };
    host._view.open = async (context) => {
        opened.push(context.identifier);
        return {};
    };
    const older = open.call(host, { path: 'first', label: 'First' });
    await open.call(host, { path: 'latest', label: 'Latest' });
    pending.resolve(first);
    await older;
    assert.deepEqual(opened, ['latest']);
    assert.deepEqual(titles, ['Latest']);
    assert.deepEqual(updates.map((update) => update.path), ['latest']);
    assert.deepEqual(recents, [['update-recents', 'latest']]);
    assert.equal(first.disposed, 1);
    assert.equal(first.streamClosed, 1);
    assert.equal(latest.streamClosed, 1);
});

test('desktop stale rendering and read failures cannot update title, recents, or errors', async () => {
    const first = makeContext('first');
    const latest = makeContext('latest');
    const pending = deferred();
    const started = deferred();
    const recents = [];
    const titles = [];
    const updates = [];
    const open = await desktopMethod(recents);
    const host = { _view: makeView(), _telemetry: { set() {} },
        _context: async (path) => path === 'first' ? first : latest,
        _title: (title) => titles.push(title), update: (options) => updates.push(options)
    };
    host._view.open = async (context) => {
        if (context === first) {
            started.resolve();
            return pending.promise;
        }
        return {};
    };
    const older = open.call(host, { path: 'first', label: 'First' });
    await started.promise;
    await open.call(host, { path: 'latest', label: 'Latest' });
    pending.resolve({});
    await older;
    assert.deepEqual(titles, ['Latest']);
    assert.deepEqual(updates.map((update) => update.path), ['latest']);
    assert.deepEqual(recents, [['update-recents', 'latest']]);

    const reading = deferred();
    host._context = (path) => path === 'first' ? reading.promise : Promise.resolve(latest);
    const olderRead = open.call(host, { path: 'first', label: 'First' });
    await open.call(host, { path: 'latest', label: 'Latest' });
    reading.reject(new Error('Obsolete read failure'));
    await olderRead;
    assert.equal(host._view.errors.length, 0);
    assert.equal(updates.length, 2);
});

test('a superseded rollback cannot report an old error over a newer graph', async () => {
    await Promise.all([false, true].map(async (rejectRollback) => {
        const previous = {};
        const failed = {};
        const latest = {};
        const rollingBack = deferred();
        const finishRollback = deferred();
        const app = { _model: previous, _path: [], async _updatePath(model) {
            this._model = model;
            if (model === failed) {
                throw new Error('Older layout failed');
            }
            if (model === previous) {
                rollingBack.resolve();
                await finishRollback.promise;
            }
        } };
        const older = View.prototype._updateTarget.call(app, failed, []);
        await rollingBack.promise;
        await View.prototype._updateTarget.call(app, latest, []);
        if (rejectRollback) {
            finishRollback.reject(new Error('Obsolete rollback failure'));
        } else {
            finishRollback.resolve();
        }
        assert.equal(await older, undefined);
        assert.equal(app._model, latest);
    }));
});
