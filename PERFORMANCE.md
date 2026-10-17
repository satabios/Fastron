# Performance review — 2026-10-16

This review covered Rust indexing, source reads, repeated-block folding, worker/layout handoff, SVG construction, viewport lifetime, selection and export. It did not audit every format decoder. Model Explorer was inspected at commit `0340b90e36d74007101edee342123e51416eba41`.

## Fixed in this change

| Finding | Effect | Change and regression coverage |
| --- | --- | --- |
| Failed WASM initialization was cached permanently | An interrupted download or compile failure disabled indexed loading for later opens in the same worker | Share pending compilation, clear the cache on failure, and test concurrent failure followed by missing-file and invalid-WASM recovery |
| Deferred viewport work survived graph unregistration | Switching models could continue constructing obsolete nodes/edges; delayed refreshes could run after navigating back | Invalidate queued builds and restore callbacks, detach the old viewport, and ignore callbacks belonging to an earlier registration; test node/edge queues and registration retries |
| Opening a blocked IndexedDB layout cache never settled | An optional cache could prevent a model from reaching layout | Continue without the cache while blocked, accept a later successful open, and close the connection on version changes; test all three states |
| Distant zoom still constructed complete node controls | A large overview retained rich model objects and thousands of unreadable labels | Below 40% zoom, large deferred graphs use one shape per ordinary node. Preserve category/dtype colors, comparison markers, geometry and connections; restore detail for zoom, selection, search and export |
| Rust integer reads allocated a temporary vector for each scalar | Protobuf varint bytes and GGUF fields repeatedly invoked the allocator despite already being buffered | Decode directly from the current window when the entire scalar fits. Retain the existing refill path. Test capture, all fixed widths, window boundaries, EOF and payload skips |
| Folding ignored parameter sharing within a block | A representative could hide a change from a shared parameter to separate parameters of identical type | Include parameter reference roles in structural signatures, using names or anonymous initializer identity; check shared and independent tensors without reading values |
| Image export could outlive navigation or overlap another export | Obsolete graphs kept materializing, detached canvases could throw, and one export could hide another's SVG | Cancel materialization when its graph is unregistered, serialize exports, and skip queued exports whose graph changed; cover cancellation and failure recovery |
| Canvas failures escaped the PNG image callback | Allocation or drawing errors could leave the export promise pending | Reject the export promise for callback errors and report a clear allocation error; test null contexts and drawing exceptions |
| Long ONNX connections expanded into millions of Dagre dummy nodes | Opening the 19,449-node Qwen example spent over 20 seconds preparing 4.4 million routing nodes before crossing minimization even began | Keep ranks from every connection, bound dummy-node expansion to the greater of 100,000 and four times the real layout-node count, and restore the longest links as rounded exterior routes; preserve endpoints, labels, cycles and compound groups |
| Widely separated graph inputs centered an empty region | The Qwen example's 64 inputs span most of the graph, leaving no visible nodes at their combined center | Center the earliest real input when the input group cannot fit the viewport; preserve combined centering for nearby inputs |
| Orthogonal routes used broad curve hulls for tile indexing | Long exterior routes indexed large empty areas and inflated memory | Index each straight segment and its rounded corners; preserve stroke coverage, cached routing style and full route/label bounds |
| Electron discarded initial scroll offsets while the graph was hidden | A completed layout could still open on a blank canvas | Restore graph position after the target becomes visible, preserve saved selection/zoom, and reject stale callbacks |
| Tensor attributes and per-layer cache outputs prevented exact repetition proof in Qwen | Folding left thousands of operators visible despite preserved layer/module scopes | Fall back to an explicitly labeled module hierarchy, preserve every boundary tensor, split at intervening operations and open individual instances lazily |

Overview shapes have accessible names, keyboard activation and compact type labels. Labels stay approximately 12 screen pixels high, with a small spatial grid suppressing neighboring labels to avoid overlap; node data and controls remain deferred. Selected/focused nodes keep detail; image export always materializes complete node content, then restores the interactive overview. Initial loading remains at its normal zoom and weight loading remains on demand. Repeated-block analysis is opt-in after loading through **View → Fold Repeated Blocks** or the toolbar; results are reused when folding again, and the option resets to off for each newly opened model. Module-hierarchy code is imported only when requested folding cannot prove exact repetition. The shipped WASM was rebuilt alongside its Rust source in the previous optimization.

Desktop smoke tests also now use independent Electron profiles, avoiding shared-profile launch failures and changes to a normal application's profile.

## Measurements

The supplied `qwen3_vl_p2b_instruct_d28_1111111011011100010_slim.onnx` contains 19,449 operators and 27,466 displayed connections including graph ports. A fresh local Chromium session with an HTTP range source took about **4.5 seconds** from navigation to visible nodes after these fixes; reopening with the layout cache took about **1.0 second**. Parsing took about 0.12 seconds, folding analysis was skipped, layout took 3.2 seconds, and tile indexing took 0.11 seconds. Before the fix, normalization alone took 13.3 seconds and parent-chain preparation another 7.1 seconds; the subsequent crossing-minimization run did not finish within the worker budget. The optimized run used 99,851 temporary routing nodes instead of 4,385,996. Normal graphs below the routing budget retain their previous geometry (including the existing 1,000/10,000-node and compound-graph checksums).

Large graphs that reach this budget use simpler exterior routes for the longest connections. All operator nodes, edge endpoints, direction and labels remain present; the rank calculation still uses every connection. Weights remain on demand, and folding remains off until requested. Layout cache keys were advanced so old geometry is recomputed once.

The local Electron run opened the same Qwen file with visible operators in about **4.0 seconds**. After opting into folding, its preserved scopes produce **12 main nodes** plus two input/output bundles. Layers 0–2 stay separate around their additional residual connections; layers 3–27 form a **25-instance module group**. Selecting an instance exposes its own attention/MLP submodules and original parameter offsets. The file contains text-model layers, not the vision tower from the complete PyTorch architecture. The browser check verifies module navigation causes no extra source reads. Scope grouping counts instances and does not claim their operations, constants or weights are identical.

To check this or another local model without browser overhead:

```bash
node test/benchmark-model-opening.mjs /path/to/model.onnx
node test/benchmark-model-opening.mjs /path/to/model.onnx --fold
```

This benchmark uses the mock DOM and serial layout. It checks stable node/connection counts, finite routes, disabled initial folding and zero additional source reads during rendering. Its timings and instantaneous heap use do not represent browser paint, process peak RSS or network-mount latency.

Run the synthetic overview benchmark:

```bash
node test/benchmark-viewport.mjs --overview
```

Both modes show the same 2,048-node graph in fresh Node processes. The detailed mode represents the former behavior of building every visible label; the overview mode uses 25% zoom. The harness drains all queued builds, checks identical node geometry checksums, and rejects source reads during rendering. Unique node SVG elements exclude edge elements.

| Format | Retained heap, detail → overview | Node SVG elements, detail → overview |
| --- | --- | --- |
| Safetensors | 54.38 → 20.22 MiB | 43,008 → 6,144 |
| GGUF | 53.40 → 19.21 MiB | 43,008 → 6,144 |
| ONNX | 49.69 → 31.96 MiB | 21,514 → 6,154 |

That is approximately 36–64% less retained heap and 71–86% fewer node SVG elements in this synthetic overview, including the compact type-label elements. Ordinary rich node/header counts fell from 2,048 to zero; ONNX still retains graph ports, edges and canonical metadata. Node counts, connections and weight offsets are unchanged. These are mock DOM construction/memory measurements, not browser frame rates, real process RSS, or remote-drive throughput.

Run the warm Rust/WASM CPU benchmark:

```bash
node test/benchmark-index.mjs
```

The fixture has 32,768 displayed nodes with tiny weights, five warm-up iterations and ten measured iterations. Source reads copy from an in-memory file; results include metadata/range SHA-256 hashes. On this ARM Mac with Node 25.2.1, both revisions built with Rust 1.99.0:

| Format | Median indexing, previous → buffered scalar reads | Source requests |
| --- | --- | --- |
| ONNX | 43.50 → 32.72 ms | 227 in both revisions |
| GGUF | 7.45 → 4.78 ms | 54 in both revisions |

Metadata and range hashes matched between revisions. These measurements suggest about 25% and 36% less CPU time for these metadata-heavy fixtures. They exclude network latency and do not predict the same improvement in end-to-end loading. Safetensors primarily reads a JSON header, so this scalar optimization is not expected to materially change its indexing time.

## What to adapt from Model Explorer next

| Priority | Technique and evidence | Fit for Fastron |
| --- | --- | --- |
| Applied | Zoom-dependent detail: [`updateNodeBgColorWhenFar()`](https://github.com/google-ai-edge/model-explorer/blob/0340b90e36d74007101edee342123e51416eba41/src/ui/src/components/visualizer/webgl_renderer.ts#L1673) adjusts distant-node presentation and hides optional SVG text | Adapted the idea to Fastron's SVG renderer by avoiding rich node construction. No renderer dependency or upstream code was copied |
| Next for layout/memory | Hierarchical expansion and local layout: [`GraphExpander`](https://github.com/google-ai-edge/model-explorer/blob/0340b90e36d74007101edee342123e51416eba41/src/ui/src/components/visualizer/worker/graph_expander.ts) lays out children and their ancestors | Keep collapsed groups as boundary summaries and compute child geometry when expanded. This addresses graph-wide geometry that viewport DOM culling cannot remove. Preserve every external port, control edge and search target; names alone are insufficient evidence for semantic folding |
| Next for dense overview paint | GPU instancing: [`webgl_rounded_rectangles.ts`](https://github.com/google-ai-edge/model-explorer/blob/0340b90e36d74007101edee342123e51416eba41/src/ui/src/components/visualizer/webgl_rounded_rectangles.ts) uses instanced typed buffers; [`webgl_texts.ts`](https://github.com/google-ai-edge/model-explorer/blob/0340b90e36d74007101edee342123e51416eba41/src/ui/src/components/visualizer/webgl_texts.ts) batches glyphs with a font atlas | Profile browser paint on dense graphs after LOD. Prototype batched edge rendering first if edges dominate. Retain accessible DOM overlays, selection/hit testing, context-loss recovery and full SVG export before replacing the default renderer |
| Next for worker overhead | Worker-owned hierarchy and layout state: [`worker_service.ts`](https://github.com/google-ai-edge/model-explorer/blob/0340b90e36d74007101edee342123e51416eba41/src/ui/src/components/visualizer/worker_service.ts) and the graph expander | Fastron already moves indexing/layout into workers, but layout sends object arrays each way. Measure serialization and peak memory, then use persistent worker state and transferable packed geometry where it matters |

Keep Fastron's exact repeated-block validation. Model Explorer's [`IdenticalGroupsFinder`](https://github.com/google-ai-edge/model-explorer/blob/0340b90e36d74007101edee342123e51416eba41/src/ui/src/components/visualizer/worker/identical_groups_finder.ts) groups structural hashes for visualization. That is useful for finding candidates, but a hash match alone must not decide whether Fastron can hide an instance or report two models as equal.

Further Rust work should follow measured CPU costs: compact topology indexes and structural signatures are candidates. Moving rendering code to Rust cannot by itself remove SVG elements, browser layout/paint, or network round trips. For remote weights, request count, metadata placement, source-version checks and bounded previews still matter more than scalar decode time.

## Remaining limits

Canonical metadata, ONNX initializer records, displayed graph topology, layout and the spatial index remain resident. Repetition checks still inspect later instances' metadata. Generic formats and HTTP servers without usable versioned ranges can retain full-download behavior. The new overview only simplifies ordinary nodes in large deferred graphs; it does not page the entire model or replace edge rendering with a GPU backend.

Validation covers unit regressions, Rust tests, cached model validation, browser loading/folding/weight previews/exports, and desktop/browser smoke tests. No representative SMB/NFS or Remote SSH model was available; use `test/benchmark-loading.mjs` with a real mounted model and the remote benchmark instructions in `CONTRIBUTING.md` before making remote-throughput claims.
