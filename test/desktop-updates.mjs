import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

const source = await fs.readFile(new URL('../source/app.js', import.meta.url), 'utf8');
const start = source.indexOf('    async _checkForUpdates() {');
const end = source.indexOf('\n    _about() {', start);

const fixture = ({ packaged = true, configured = true } = {}) => {
    const application = new EventEmitter();
    application.isPackaged = packaged;
    const autoUpdater = new EventEmitter();
    autoUpdater.app = { appUpdateConfigPath: 'app-update.yml' };
    let checks = 0;
    autoUpdater.checkForUpdates = async () => {
        checks++;
        return null;
    };
    const timers = new Set();
    const messages = [];
    const context = { electron: { app: application }, updater: { default: { autoUpdater } },
        fs: { existsSync: () => configured }, console: { log: (message) => messages.push(message) },
        setInterval(callback, delay) {
            const timer = { callback, delay, unref() {} };
            timers.add(timer);
            return timer;
        },
        clearInterval(timer) {
            timers.delete(timer);
        } };
    const target = vm.runInNewContext(`({ ${source.slice(start, end)} })`, context);
    return { application, autoUpdater, target, timers, messages, checks: () => checks };
};

test('desktop startup finishes its main module before readiness and starts updates after the view', async () => {
    const application = new EventEmitter();
    application.setAppUserModelId = () => {};
    application.requestSingleInstanceLock = () => true;
    application.whenReady = () => assert.fail('Awaiting ready here deadlocks the Electron main ES module.');
    const calls = [];
    const begin = source.indexOf('    async start() {');
    const finish = source.indexOf('\n    get environment()', begin);
    const method = source.slice(begin, finish).replaceAll('import.meta.url', '"file:///source/app.js"');
    const target = vm.runInNewContext(`({ ${method} })`, {
        electron: { app: application, ipcMain: new EventEmitter() }, registerModelSources() {},
        fs: { readFileSync: () => '{}' }, path: { dirname: (name) => name, join: (...names) => names.join('/') },
        url: { fileURLToPath: (name) => name }, process: { argv: [] }
    });
    target._parseCommandLine = () => {};
    target._ready = () => calls.push('view');
    target._checkForUpdates = () => calls.push('updates');
    await target.start();
    assert.deepEqual(calls, []);
    application.emit('ready');
    assert.deepEqual(calls, ['view', 'updates']);
});

test('desktop updater skips development builds and missing update configuration', async () => {
    await Promise.all([{ packaged: false }, { configured: false }].map(async (options) => {
        const { target, timers, checks } = fixture(options);
        await target._checkForUpdates();
        assert.equal(checks(), 0);
        assert.equal(timers.size, 0);
    }));
});

test('desktop updater downloads automatically, polls every six hours and cleans up on quit', async () => {
    const { application, autoUpdater, target, timers, checks } = fixture();
    await target._checkForUpdates();
    assert.equal(checks(), 1);
    assert.equal(autoUpdater.autoDownload, true);
    assert.equal(autoUpdater.autoInstallOnAppQuit, true);
    const [timer] = timers;
    assert.equal(timer.delay, 6 * 60 * 60 * 1000);
    await timer.callback();
    assert.equal(checks(), 2);
    assert.equal(timers.size, 1);
    application.emit('will-quit');
    assert.equal(timers.size, 0);
    await target._checkForUpdates();
    assert.equal(checks(), 2);
});

test('desktop updater prevents overlapping checks through completion of the download', async () => {
    const { autoUpdater, target } = fixture();
    let finishCheck = null;
    let finishDownload = null;
    let checks = 0;
    const downloadPromise = new Promise((resolve) => {
        finishDownload = resolve;
    });
    autoUpdater.checkForUpdates = () => {
        checks++;
        return new Promise((resolve) => {
            finishCheck = resolve;
        });
    };
    const pending = target._checkForUpdates();
    await target._checkForUpdates();
    assert.equal(checks, 1);
    finishCheck({ downloadPromise });
    await target._checkForUpdates();
    assert.equal(checks, 1);
    finishDownload();
    await pending;
    assert.equal(target._checkingUpdate, false);
});

test('desktop updater stops polling after staging without forcing a restart', async () => {
    const { autoUpdater, target, timers, checks } = fixture();
    autoUpdater.quitAndInstall = () => assert.fail('Must wait for normal application quit.');
    await target._checkForUpdates();
    autoUpdater.emit('update-downloaded');
    assert.equal(timers.size, 0);
    await target._checkForUpdates();
    assert.equal(checks(), 1);
});

test('desktop updater contains synchronous, check and download failures and retries later', async () => {
    const { autoUpdater, target, messages } = fixture();
    autoUpdater.checkForUpdates = () => {
        throw new Error('synchronous failure');
    };
    await target._checkForUpdates();
    autoUpdater.checkForUpdates = async () => {
        throw new Error('check failure');
    };
    await target._checkForUpdates();
    autoUpdater.checkForUpdates = async () => ({ downloadPromise: Promise.reject(new Error('download failure')) });
    await target._checkForUpdates();
    assert.deepEqual(messages, ['synchronous failure', 'check failure', 'download failure']);
    assert.equal(target._checkingUpdate, false);
    autoUpdater.checkForUpdates = async () => null;
    await target._checkForUpdates();
    assert.equal(messages.length, 3);
});
