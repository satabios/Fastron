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

ONNX, GGUF and Safetensors use a small Rust/WASM index in a source worker. JavaScript parsers retain complete metadata and construct rich nodes on demand; tensor payloads stay in the original file. Electron creates its Node workers in the main process and forwards bounded requests from the renderer over IPC; workers read local or mounted files. VS Code runs the worker in the workspace extension host, including Remote SSH, and sends metadata and requested byte ranges to the webview. Browser workers read selected files or HTTP servers with versioned byte ranges; other HTTP servers retain full-download loading. Other formats retain their existing loaders.

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
node test/browser-repeated.mjs # Folding, instance selection, search, weights and SVG
```

A reusable benchmark generates a sparse 256 MB Safetensors fixture and compares indexed reads against a full scan. It can add latency per read or use a real mounted model later:

```bash
node test/benchmark-loading.mjs --latency=10 --size=256
node test/benchmark-loading.mjs /mnt/models/model.onnx
node test/benchmark-loading.mjs --fixture=scattered-onnx --size=64 --latency=10
node test/benchmark-loading.mjs --fixture=large-gguf --size=64 --latency=10
node test/benchmark-loading.mjs --fixture=contiguous-onnx --size=2
```

The benchmark reports source bytes, read requests and elapsed time; it does not measure SVG rendering or predict SMB/NFS throughput. Graph/layout regression checks are separate: `node test/dagre-layout.mjs`.

The rendering benchmark indexes a long diagonal edge and queries both a small viewport and the full overview:

```bash
node test/benchmark-rendering.mjs 300
```

Culling uses conservative curve hulls and label bounds, preserving existing SVG paths. Overview queries scan occupied tiles when this is cheaper than visiting the full grid. Format decoders load on demand; concurrent opens share pending metadata requests. Large deferred graphs retain font readiness checks and skip the two-frame DOM measurement wait.

Deferred graphs allocate no offscreen leaf SVG placeholders, including graphs with 501–5,000 nodes. Visible nodes and edges are built on entry and evicted from a bounded detached cache after leaving; layout retains dimensions and connections for the displayed graph. Small graphs keep exact DOM measurement. Panning and zooming do not request tensor payloads.

Below 40% zoom, large deferred graphs show lightweight node shapes with category/dtype colors instead of constructing unreadable labels and controls. Zooming in, selecting or finding a node restores its details; image export always includes complete content. Keyboard activation remains available. See [PERFORMANCE.md](PERFORMANCE.md) for the measured results, bug fixes, and remaining Model Explorer techniques worth adapting.

For large indexed graphs, eviction also drops ordinary nodes' rich model wrappers, headers, argument controls and callbacks. Text dimensions are measured without SVG, then those temporary objects are released. Search reconstructs a distant node from its catalog entry; a bounded cache retains nearby nodes and selection keeps active objects pinned. Nested graph/object nodes keep the existing construction path because they contribute child layout nodes. Enabling full rendering and exporting images can materialize the whole graph explicitly.

Edge routing is retained in one lossless `Float64Array`; visible edges reconstruct their point objects, and eviction returns them to packed storage. Edges crossing the viewport use locked geometry without constructing their distant endpoints' UI. Node dimensions, topology and the spatial index remain resident to preserve layout and navigation. This is bounded rich-object memory, not disk paging of all model metadata or geometry. Canonical metadata and ONNX initializer metadata are still retained, and initial exact repetition checks still scan later blocks.

```bash
node test/benchmark-viewport.mjs
node test/benchmark-viewport.mjs --overview
node test/benchmark-index.mjs
```

This compares retained and viewport-managed model/UI objects for 2,048 displayed nodes per format in fresh processes, using a mock DOM and a 64-entry nearby cache. It reports retained heap, array-buffer memory, node/header counts and preparation time, verifies identical node geometry, and asserts no source reads during rendering. It does not measure browser paint or SMB/NFS latency. The retained case uses a plain array to keep all rich nodes alive; the viewport case uses the indexed catalog and packed routes. Reconstructing evicted objects trades some CPU for lower retained memory.

Scattered ONNX payloads use small probes after bulk skips and grow their read windows for sequential metadata. This reduces payload overread; first-open request latency still depends on how the file interleaves metadata and weights. GGUF and Safetensors headers are retained during their first scan. Single packed ONNX float32/float64 fields also support bounded previews; unsupported or mixed encodings keep full decode and export.

Force layout uses the existing layout worker and the same numerical kernel as serial fallback. Serial fallback and comparator candidate scans yield to interaction without changing graph connections or comparison scores. Detached SVG elements have a bounded cache; selected/focused elements remain pinned, and export materializes the complete graph. Render/open generations prevent obsolete work from replacing a newer model or its window title.

Distribution builds validate slim metadata and separated examples against the development originals before omitting duplicate originals. Keep development metadata in `source/`; regenerate with `npm run slim-metadata` after metadata edits. Browser startup loads entry modules first, and operator examples are fetched when documentation opens.

## Repeated blocks

Models open unfolded with viewport rendering and on-demand weights. Initial loading skips all pattern analysis. Click the **Graph Stacking** toolbar button beside Zoom Out, or **View → Fold Repeated Blocks**, to enable it. Results are cached for that graph; the option resets to off when another model opens.

Execution graphs use one generic topology matcher. There are no CNN/attention/normalizer/MLP operator templates, architecture-specific acceptance rules, or module-name fallbacks in this path. It compares operator types, domains, versions and overloads; scalar attributes and their types; tensor dtype, shape, layout and quantization; optional argument positions; parameter aliasing; and internal connections. Tensor attributes supply headers while their payloads remain opaque. ONNX tensor attributes are distinct from actual subgraphs, and empty optional inputs retain their argument slots.

A rolling hash rejects unlikely consecutive sequences cheaply. Every accepted instance is then checked against its full metadata and connection signature. Adjacent instances must share a real data/state connection, and consecutive pairs must preserve cross-instance connection roles. Disconnected lookalikes are not sequential stacks. Candidate boundaries keep a fork with its branches. After repeats are selected, dependency closures group remaining branches and joins into individual functions; those functions have no ×1 badge. The algorithm uses topological order and is bounded to 1,024 operators per motif/branch region; it yields and supports cancellation.

This works with unfamiliar operator names and domains. CNN, explicit/unrolled recurrent, MHA/MQA/GQA, fused-attention and gated-MLP fixtures exercise the same matcher. Changing every operator name/domain consistently preserves their group indices. The folder check also renames every node and tensor in every supplied model and requires identical matches. A separate name-based inventory matcher remains for weight-only formats such as Safetensors/GGUF, which have no execution connections.

Cards use **Repeated pattern** and preview their actual operation types. The **Representative instance** selector exposes the chosen instance's original operators and parameters. **Expand stack** / **Fold stack** controls affect one stack and support keyboard activation; the toolbar expands or folds the whole graph. **Open module** or **ƒ** opens the selected region, where the same generic matcher can expose smaller repeats. Find reveals hidden operators. Image export uses the displayed graph; comparison and parameter totals use the complete canonical graph.

A pattern may span several source modules, or a fraction of one: matching exported topology does not recover an exact PyTorch class hierarchy. The supplied ResNet50 still produces four separate transition functions and ×2/×3/×5/×2 runs, reducing 122 operators to 14 displayed nodes. The supplied Qwen text and vision exports display 521 and 25 nodes respectively; these generic motif counts are not counts of PyTorch decoder/vision layers.

Signatures preserve named/generated symbolic constraints. Anonymous axes remain unresolved metadata, not inferred equal dimensions. Missing rank metadata, nested/control-flow nodes and unsupported attributes form boundaries. Matching does not prove equal weights, opaque constants or runtime computation. Different quantization metadata splits runs; the supplied QNN JSON currently forms individual branch functions without a repeat badge. All original connections, external taps, graph outputs and per-instance parameter references remain available.

```bash
node test/pattern-folder.mjs graph-examples
node test/resnet-folding.mjs /path/to/resnet50.onnx
node test/browser-repeated.mjs /path/to/efficientvit_b3.onnx /path/to/qwen-text.onnx /path/to/qwen-vision.onnx /path/to/resnet50.onnx
```

The folder check covers ONNX and model JSON, uses the toolbar's finder and cache, verifies renaming and canonical expansion, and asserts zero additional source reads during analysis. The supplied folder has no standalone LSTM or Llama export; recurrent and Llama-like GQA/gated-MLP coverage uses synthetic fixtures. Noncontiguous or oversized motifs remain visible rather than invoking unbounded subgraph-isomorphism search.

ONNX retains compact protobuf records and initializer metadata. Expanding a stack does not retain every rich node outside the viewport. Enabling weights does not bulk-load tensors; a preview or export reads the chosen tensor on demand. Later instances' metadata must still be checked for exceptions, so repetition cannot safely be inferred from block 0 alone.

The existing Rust/WASM index continues bounded file indexing; the shared JavaScript matcher performs metadata-only analysis. The inventory benchmark below compares exact named weight/block repetition rather than the current topology matcher. Its layout timings exclude browser paint and do not predict SMB/NFS throughput:

```bash
node test/benchmark-repeated.mjs
node test/benchmark-repeated.mjs --latency=10
```
