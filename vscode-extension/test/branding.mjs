import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
const app = JSON.parse(fs.readFileSync(path.join(root, '../package.json'), 'utf-8'));
const commands = new Map();
const panels = [];
const errors = [];
const uri = (fsPath) => ({ fsPath, toString: () => pathToFileURL(fsPath).href });
const vscode = {
    Uri: { file: uri, joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
    ViewColumn: { One: 1 },
    commands: {
        registerCommand(name, callback) {
            commands.set(name, callback);
            return { dispose() {} };
        },
        executeCommand: (name, ...args) => commands.get(name)(...args)
    },
    window: {
        activeTextEditor: { document: { fileName: '/notes/not-a-model.txt' }, viewColumn: 1 },
        showErrorMessage: (message) => errors.push(message),
        createWebviewPanel(type, title, column, options) {
            const panel = { title, options, webview: { cspSource: 'vscode-resource:', asWebviewUri: (value) => value,
                onDidReceiveMessage(callback) {
                    panel.receive = callback;
                } }, onDidDispose() {} };
            panels.push(panel);
            return panel;
        }
    }
};
const compiled = fs.readFileSync(path.join(root, 'out/extension.js'), 'utf-8');
const module = { exports: {} };
vm.runInNewContext(compiled, { module, exports: module.exports, console, require: (name) => {
    if (name === 'vscode') {
        return vscode;
    }
    if (name === './modelSource') {
        return { ModelSource: class {
            dispose() {}
        } };
    }
    return require(name);
} });
module.exports.activate({ subscriptions: [], extensionPath: root, extensionUri: uri(root), extension: { packageJSON: manifest } });

await commands.get('fastron.open_webbrowser')();
const panel = panels[0];
assert.equal(panel.title, 'Fastron');
assert.ok(panel.options.localResourceRoots.length);
assert.match(panel.webview.html, /class="logo-glyph"[^>]*>FASTRON<\/text>/);
assert.match(panel.webview.html, new RegExp(`<meta name="version" content="${manifest.version.replaceAll('.', '\\.')}"`));
assert.doesNotMatch(panel.webview.html, /netron\.app|<iframe|%version%/);
await panel.receive({ command: 'request_model' });
assert.deepEqual(errors, [], 'An empty viewer must not try to stat an undefined file.');

commands.get('fastron.open')(uri('/models/example.onnx'));
assert.equal(panels[1].title, 'example.onnx [Fastron]');
assert.equal(manifest.version, app.version);
for (const icon of [manifest.icon, ...Object.values(manifest.contributes.languages[0].icon), 'webview/netron/icon.png']) {
    assert.deepEqual(fs.readFileSync(path.join(root, icon)), fs.readFileSync(path.join(root, '../source/icon.png')));
}
assert.deepEqual(fs.readFileSync(path.join(root, 'webview/netron/favicon.ico')), fs.readFileSync(path.join(root, '../source/favicon.ico')));
process.stdout.write('VS Code branding: local viewer, Fastron wordmark/icons, package version and empty startup passed.\n');
