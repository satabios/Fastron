# How to Develop Fastron

## Debugging

Fastron can run as both an [Electron](https://electronjs.org) app or a web app.

To start the Electron app, install [Node.js](https://nodejs.org) and run: 

```bash
git clone https://github.com/satabios/Fastron
cd Fastron
npm run setup
npm start
```

To debug the Electron app, open the folder in [Visual Studio Code](https://code.visualstudio.com) and press <kbd>F5</kbd>. To attach the debugger to the render process select the `Debug` tab and pick `Desktop View` before launching.

To build and launch the web app, pick `Browser` in the `Debug` tab or run this command:

```bash
python package.py build start --browse
```

## Validation

To validate changes run:

```bash
npm run test:unit # Offline stream, lazy weight, and viewport regressions
npm run lint
npm test [format] # e.g. npm test onnx
```

## Loading performance

ONNX, GGUF and Safetensors use a small Rust/WASM index in a source worker. Existing JavaScript parsers build the complete graph from its metadata; tensor payloads stay in the original file. Electron creates its Node workers in the main process and forwards bounded requests from the renderer over IPC; workers read local or mounted files. VS Code runs the worker in the workspace extension host, including Remote SSH, and sends metadata and requested byte ranges to the webview. Browser workers read selected files or HTTP servers with versioned byte ranges; other HTTP servers retain full-download loading. Other formats retain their existing loaders.

Numeric tensors with contiguous storage show at most 1,000 values on demand. Packed, sparse and strided tensors use their existing full decode. Export still reads the full tensor. Sources pin file versions and reject changed files rather than combining stale metadata with new weights. Referenced files must stay inside the model directory (or the browser's selected files).

The compiled `source/model-index.wasm` ships with the application; users need no Rust installation. To rebuild it:

```bash
rustup target add wasm32-unknown-unknown
npm run build:index
cargo test --manifest-path rust/Cargo.toml
npm run test:unit
npm run test:source --prefix vscode-extension
python test/server-ranges.py
node test/browser-loading.mjs # Requires Playwright Chromium
```

A reusable benchmark generates a sparse 256 MB Safetensors fixture and compares indexed reads against a full scan. It can add latency per read or use a real mounted model later:

```bash
node test/benchmark-loading.mjs --latency=10 --size=256
node test/benchmark-loading.mjs /mnt/models/model.onnx
```

The benchmark reports source bytes, read requests and elapsed time; it does not measure SVG rendering or predict SMB/NFS throughput. Graph/layout regression checks are separate: `node test/dagre-layout.mjs`.

The rendering benchmark indexes a long diagonal edge and queries both a small viewport and the full overview:

```bash
node test/benchmark-rendering.mjs 300
```

Culling uses conservative curve hulls and label bounds, preserving existing SVG paths. Overview queries scan occupied tiles when this is cheaper than visiting the full grid. Format decoders load on demand; concurrent opens share pending metadata requests. Large deferred graphs retain font readiness checks and skip the two-frame DOM measurement wait.
