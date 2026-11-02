import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const yaml = createRequire(import.meta.url)('js-yaml');
const workflow = yaml.load(await fs.readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf-8'));
const signing = ['CSC_LINK', 'CSC_KEY_PASSWORD', 'APPLE_API_KEY', 'APPLE_API_KEY_ID', 'APPLE_API_ISSUER'];

test('publishing handles absent, partial and complete credentials without masking failures', async (t) => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'fastron-publishing-'));
    t.after(() => fs.rm(home, { recursive: true, force: true }));
    const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : 'bash';
    const stubs = `
npx() {
    printf 'npx %s\\n' "$*"
    if [[ "$*" == *"--win"* && -n "$CSC_LINK$CSC_KEY_PASSWORD" ]]; then return 31; fi
}
npm() { printf 'npm %s\\n' "$*"; return "$MOCK_NPM_EXIT"; }
sudo() { printf 'sudo %s\\n' "$*"; }
`;
    const job = workflow.jobs.publish;
    const step = (name) => job.steps.find((item) => item.name === name);
    const run = (name, target, env = {}) => spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c',
        stubs + step(name).run.replaceAll(`\${{ matrix.os }}`, target)], {
        encoding: 'utf-8',
        env: {
            ...process.env,
            ...Object.fromEntries([...signing, 'GITHUB_USER', 'GITHUB_TOKEN', 'WINGET_TOKEN', 'TWINE_PASSWORD', 'MOCK_NPM_EXIT'].map((key) => [key, ''])),
            HOME: home.replaceAll('\\', '/'),
            MOCK_NPM_EXIT: '0',
            ...env
        }
    });
    const succeeds = (result) => assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.equal(job.permissions.contents, 'write');
    assert.equal(step('Publish Electron').env.GITHUB_TOKEN, `\${{ secrets.GH_TOKEN || github.token }}`);

    const unsigned = run('Publish Electron', 'macos-latest');
    succeeds(unsigned);
    assert.match(unsigned.stdout, /--mac --universal --publish always --config.mac.identity=null --config.mac.notarize=false/);
    assert.doesNotMatch(unsigned.stdout, /npm run publish electron mac/);

    const credentials = Object.fromEntries(signing.map((key) => [key, 'test-key']));
    for (const key of signing) {
        const partial = run('Publish Electron', 'macos-latest', { ...credentials, [key]: '' });
        assert.equal(partial.status, 1, key);
        assert.match(partial.stdout, /Incomplete macOS signing/);
        assert.doesNotMatch(partial.stdout, /--publish always|npm run publish/);
    }
    const signed = run('Publish Electron', 'macos-latest', credentials);
    succeeds(signed);
    assert.match(signed.stdout, /npm run publish electron mac/);
    assert.doesNotMatch(signed.stdout, /--config.mac.identity=null/);
    assert.equal(await fs.readFile(path.join(home, '.private_keys', 'AuthKey_test-key.p8'), 'utf-8'), 'test-key\n');
    const keyFile = path.join(home, 'existing-key.p8');
    await fs.writeFile(keyFile, 'existing key');
    succeeds(run('Publish Electron', 'macos-latest', { ...credentials, APPLE_API_KEY: keyFile.replaceAll('\\', '/') }));
    assert.equal(await fs.readFile(keyFile, 'utf-8'), 'existing key');
    const failed = run('Publish Electron', 'macos-latest', { ...credentials, MOCK_NPM_EXIT: '17' });
    assert.equal(failed.status, 17);
    assert.doesNotMatch(failed.stdout, /--config.mac.identity=null/);

    const windows = run('Publish Electron', 'windows-latest');
    succeeds(windows);
    assert.match(windows.stdout, /--win --x64 --arm64 --publish always --config.win.azureSignOptions=/);
    succeeds(run('Publish Electron', 'windows-latest', credentials));
    const linux = run('Publish Electron', 'ubuntu-latest');
    succeeds(linux);
    assert.match(linux.stdout, /npm run publish electron linux/);
    for (const name of ['Publish Python', 'Publish winget']) {
        const absent = run(name, '');
        succeeds(absent);
        assert.match(absent.stdout, /Skipping/);
        assert.doesNotMatch(absent.stdout, /npm run publish/);
    }
    const python = run('Publish Python', '', { TWINE_PASSWORD: 'test-token' });
    succeeds(python);
    assert.match(python.stdout, /npm run publish python/);
    const winget = { GITHUB_USER: 'test-user', GITHUB_TOKEN: 'test-token', WINGET_TOKEN: 'test-token' };
    for (const key of Object.keys(winget)) {
        assert.doesNotMatch(run('Publish winget', '', { ...winget, [key]: '' }).stdout, /npm run publish/);
    }
    const configured = run('Publish winget', '', winget);
    succeeds(configured);
    assert.match(configured.stdout, /npm run publish winget/);
});

test('CI pins Electron tooling to Node 24, installs despite a skip flag and stops on installer errors', async (t) => {
    const build = yaml.load(await fs.readFile(new URL('../.github/workflows/build.yml', import.meta.url), 'utf-8'));
    for (const job of [build.jobs.build, workflow.jobs.publish]) {
        assert.equal(job.steps.find((item) => item.name === 'Install Node.js').with['node-version'], '24');
    }
    const step = build.jobs.build.steps.find((item) => item.name === 'Install Electron runtime');
    const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'fastron-electron-setup-'));
    t.after(() => fs.rm(folder, { recursive: true, force: true }));
    const require = createRequire(import.meta.url);
    const source = path.dirname(require.resolve('electron/package.json'));
    const target = path.join(folder, 'node_modules', 'electron');
    const getter = path.join(folder, 'node_modules', '@electron', 'get');
    const extractor = path.join(folder, 'node_modules', 'extract-zip');
    await Promise.all([target, getter, extractor].map((directory) => fs.mkdir(directory, { recursive: true })));
    await Promise.all(['install.js', 'index.js', 'package.json', 'checksums.json'].map((name) => fs.copyFile(path.join(source, name), path.join(target, name))));
    const { version } = JSON.parse(await fs.readFile(path.join(target, 'package.json'), 'utf-8'));
    const binary = { darwin: 'Electron.app/Contents/MacOS/Electron', win32: 'electron.exe', linux: 'electron' }[process.platform];
    await fs.writeFile(path.join(getter, 'index.js'), `exports.downloadArtifact = async () => {
        if (process.env.FASTRON_TEST_DOWNLOAD_FAIL) { throw new Error('Fixture download failed'); }
        return 'fixture.zip';
    };`);
    await fs.writeFile(path.join(extractor, 'index.js'), `module.exports = async (_, { dir }) => {
        const fs = require('node:fs'); const path = require('node:path');
        const binary = path.join(dir, ${JSON.stringify(binary)});
        fs.mkdirSync(path.dirname(binary), { recursive: true });
        fs.writeFileSync(binary, 'fixture executable', { mode: 0o755 });
        fs.writeFileSync(path.join(dir, 'version'), ${JSON.stringify(version)});
    };`);
    const bash = process.platform === 'win32' ? path.join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : 'bash';
    const env = { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1', ELECTRON_OVERRIDE_DIST_PATH: '', npm_config_platform: '', npm_config_arch: '' };
    const skipped = spawnSync(process.execPath, [path.join(target, 'install.js')], { cwd: folder, env, encoding: 'utf-8' });
    assert.equal(skipped.status, 0, skipped.error?.message || skipped.stderr);
    await assert.rejects(fs.access(path.join(target, 'path.txt')), /ENOENT/);
    const run = (extra = {}) => spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', step.run], {
        cwd: folder, encoding: 'utf-8', env: { ...env, ...extra }
    });
    const installed = run();
    assert.equal(installed.status, 0, installed.error?.message || installed.stderr);
    assert.equal(await fs.readFile(path.join(target, 'path.txt'), 'utf-8'), binary);
    const repeated = run();
    assert.equal(repeated.status, 0, repeated.error?.message || repeated.stderr);
    await fs.writeFile(path.join(target, 'dist', 'version'), 'incomplete');
    const failed = run({ FASTRON_TEST_DOWNLOAD_FAIL: '1' });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Fixture download failed/);
});
