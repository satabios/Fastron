import * as child_process from 'node:child_process';
import * as fs from 'node:fs/promises';

child_process.execFileSync('cargo', ['build', '--manifest-path', 'rust/Cargo.toml', '--target', 'wasm32-unknown-unknown', '--release'], { stdio: 'inherit' });
await fs.copyFile('rust/target/wasm32-unknown-unknown/release/fastron_index.wasm', 'source/model-index.wasm');
