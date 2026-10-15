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
