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

Models open unfolded with viewport rendering and on-demand weights; initial loading skips repeated-block analysis. After the graph loads, click the **Graph Stacking** toolbar button beside Zoom Out, or choose **View → Fold Repeated Blocks**, to scan and stack matching blocks. Click it again to expand all blocks. The verified result is cached for that model, so expanding and folding again does not repeat the scan. Folding resets to off when opening another model and is not restored from saved startup preferences.

Verified consecutive `layers.N`, `blocks.N`, `blk.N` and `h.N` paths fold into one representative block with a clickable ×N badge. The badge lets users select a real layer or expand that stack; **View → Expand Repeated Blocks** expands all stacks. Find can reveal a hidden layer. Each instance keeps its own parameter offsets, and tensor preview/export reads that selected instance. Image export uses the displayed graph; model comparison and parameter totals use all instances.

Folding compares exact operator types, relative names, attributes, tensor types, quantization and connection roles. Different layers split runs. Unsupported nested/control-flow blocks, irregular connections and externally tapped intermediate outputs remain unfolded. Safetensors/GGUF show repeated weight structure, not inferred execution operators. All metadata still needs indexing; ONNX retains raw protobuf records and initializer metadata. This saves rich node objects, layout and SVG work, without merging weights or skipping metadata validation.

If exact repetition cannot be established, preserved indexed block scopes can instead group runs containing at least two module instances. Here **×N counts exported module instances**, which may have different operations or weights. Standalone scopes such as patch/positional embeddings and isolated layers retain their original operators. Contiguous runs preserve the original DAG; intervening residual operations remain explicit. Input/output bundles retain every named tensor. Click a module badge to select an instance, then **Open module** (or its **ƒ** icon) to inspect its real operators. Find expands the containing group when needed. This view uses exported scope names; it cannot recover absent PyTorch class names or modules omitted from the ONNX export.

At distant zoom, large graphs retain readable type labels for a spaced selection of nodes. Nearby labels are suppressed to avoid overlap, while each node remains accessible through its full name and type. This adds one lightweight text element per visible overview node without constructing its full controls or reading weights.

ONNX-generated dimension labels such as `unk__34` are matched by their equality relationships within a block. Named dimensions, concrete sizes, anonymous dimensions and symbols bound to parameters remain distinct. This recognizes repeated attention stacks without altering the original shape metadata or treating unknown dimensions as wildcards.

For the EfficientViT B3 example, provide your local model (the 186 MiB file is not bundled):

```bash
node test/efficientvit-folding.mjs /path/to/efficientvit_b3.onnx
node test/browser-repeated.mjs /path/to/efficientvit_b3.onnx
```

This export has 682 nodes. Four verified stacks (×3, ×5, ×5, ×8) reduce the displayed graph to 206 nodes; previously only two stacks were detected, leaving 646 nodes. The first attention block in each later stage remains separate because its anonymous batch dimension lacks the inferred equality relationships present in subsequent blocks. The checks cover every stack's representative selection, expansion, boundary connectivity, and zero additional source reads during folding; the optional browser example also verifies folded and expanded SVG export.

The folded overview constructs the first verified block in each stack on demand. After exact verification, the repeat index retains numeric layer/node indices and stack boundaries; per-instance boundary maps and signatures are discarded. Selected-instance details come from the canonical metadata only when needed. Expanded projections remain lazy catalogs, so expanding a stack does not retain every rich node outside the viewport. Opening, searching, expanding, panning and enabling weights do not bulk-load payloads; inspecting an enabled tensor (or explicitly requesting a per-tensor preview/export) reads its data on demand. Repetition cannot safely be inferred from block 0 alone: a later block may differ or expose a connection, so metadata validation remains necessary unless a format supplies a trustworthy repeat declaration.

The shared JavaScript analysis yields during large scans and does not read tensor bytes. The existing Rust/WASM index continues to perform bounded file indexing. Benchmark before moving structural detection across another language boundary:

```bash
node test/benchmark-repeated.mjs
node test/benchmark-repeated.mjs --latency=10
```

This generates sparse 24/96/256-layer ONNX, GGUF and Safetensors files and compares expanded/folded graphs in fresh processes. JSON rows report node materialization, retained heap, source bytes/requests, indexing/parsing, preparation, fixed-size layout and a selected-layer preview. Layout timing excludes browser paint; latency is synthetic and does not predict real SMB/NFS throughput. Initial index reads remain the same because payloads were already lazy.
