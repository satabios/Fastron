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
| Tensor attributes and per-layer cache outputs prevented exact repetition proof in Qwen | Folding left thousands of operators visible despite preserved layer/module scopes | Fall back to explicitly labeled indexed module runs with at least two instances, preserve every boundary tensor, split at intervening operations and open individual instances lazily |
| Standalone module scopes acquired misleading stack badges and expansion was hidden in the sidebar | Embeddings looked repetitive and individual stacks were difficult to unpack | Leave standalone operators unfolded; add keyboard-accessible Expand stack/Fold stack header controls that preserve other stacks and center the changed stack |
| A multiplier alone gave little indication of a folded block's contents | Users had to open the sidebar to understand a stack | Add two lightweight card outlines within layout bounds, the actual index range and a selected-instance component preview from metadata; distant labels retain the multiplier and expansion removes the folded-card decoration |
| Scope-based grouping depended on exporter naming | Renamed ONNX operators lost useful Transformer/Attention/MLP boundaries | Recognize pre-norm residual Transformer patterns from ops, concrete shapes and wiring; test MHA, MQA, GQA, renamed graphs, invalid broadcasts, preserved boundary taps and zero payload reads |

Overview shapes have accessible names, keyboard activation and compact type labels. Labels stay approximately 12 screen pixels high, with a small spatial grid suppressing neighboring labels to avoid overlap; node data and controls remain deferred. Selected/focused nodes keep detail; image export always materializes complete node content, then restores the interactive overview. Initial loading remains at its normal zoom and weight loading remains on demand. Repeated-block analysis is opt-in after loading through **View → Fold Repeated Blocks** or the toolbar; results are reused when folding again, and the option resets to off for each newly opened model. Execution-graph stacking now uses the generic topology matcher described below; named inventory matching is retained only for weight-only formats. The shipped WASM was rebuilt alongside its Rust source in the previous optimization.

Desktop smoke tests also now use independent Electron profiles, avoiding shared-profile launch failures and changes to a normal application's profile.

## Measurements

The supplied `qwen3_vl_p2b_instruct_d28_1111111011011100010_slim.onnx` contains 19,449 operators and 27,466 displayed connections including graph ports. A fresh local Chromium session with an HTTP range source took about **4.5 seconds** from navigation to visible nodes after these fixes; reopening with the layout cache took about **1.0 second**. Parsing took about 0.12 seconds, folding analysis was skipped, layout took 3.2 seconds, and tile indexing took 0.11 seconds. Before the fix, normalization alone took 13.3 seconds and parent-chain preparation another 7.1 seconds; the subsequent crossing-minimization run did not finish within the worker budget. The optimized run used 99,851 temporary routing nodes instead of 4,385,996. Normal graphs below the routing budget retain their previous geometry (including the existing 1,000/10,000-node and compound-graph checksums).

Large graphs that reach this budget use simpler exterior routes for the longest connections. All operator nodes, edge endpoints, direction and labels remain present; the rank calculation still uses every connection. Weights remain on demand, and folding remains off until requested. Layout cache keys were advanced so old geometry is recomputed once.

The local Electron run opened the same Qwen file with visible operators in about **4.0 seconds**. The original scope fallback grouped layers 3–27 into a **25-instance module group**, leaving layers 0–2 as raw operators and producing **2,625 displayed nodes**. The unrolled decoder matcher added on 2026-10-18 recognizes all 28 layers from operations and connections. Layers 0–2 become individual functions with their intervening residual Adds preserved; layers 3–27 remain a ×25 stack. The result is **608 displayed nodes** plus two input/output bundles. Selecting an instance exposes its real operators and original parameter offsets. The separate `qwen3_vl_p2b_instruct_vision_slim.onnx` contains 1,170 operators; its 24 vision blocks still form four **×6** stacks split by deepstack mergers, producing **70 displayed nodes**. Patch/positional embeddings and merger operations remain unfolded. Browser checks verify navigation causes no extra source reads.

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

## PyTorch module hierarchy assessment — 2026-10-17 (historical recognizer)

The architecture-specific recognizer below remains an offline diagnostic utility. The application now uses generic topology matching; its current results and limits are in the next subsection.

The supplied text and vision exports identify their producer as PyTorch 2.10.0. Both retain useful node scope names, but neither contains node, graph or model origin metadata. Rust's metadata index preserves non-payload protobuf fields, so this absence is not caused by the indexer. The reference PyTorch listing describes module ownership; the exported ONNX dependencies determine execution order and every boundary tensor. Reused modules can have multiple exported call sites: text layer 0 contains 16 `q_norm` scopes and eight `k_norm` scopes, despite a single registered module of each name in the supplied listing.

PyTorch's [`ModuleList.__repr__`](https://github.com/pytorch/pytorch/blob/main/torch/nn/modules/container.py) produces `(0–27): 28 x` by comparing adjacent modules' printed representations. This is a useful architecture summary, but does not prove weight equality, identical exported graphs or identical execution connections. Fastron therefore uses the module hierarchy for ownership and the ONNX graph for connections.

| Exported block | Normalization before attention | Attention | Normalization before MLP | MLP | Explicit residual Adds | Total operators |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Vision block 0 | 1 | 37 | 1 | 5 | 2 | 46 |
| Text layer 0 | 7 | 647 | 7 | 11 | 2 | 674 |

The user supplied the stock `Qwen/Qwen3-VL-2B-Instruct` PyTorch hierarchy on 2026-10-18. It confirms 24 vision blocks, 28 text decoder layers, text projection widths Q 2048→2048 / K,V 2048→1024 / output 2048→2048, 128-wide Q/K normalization, and gated MLP widths 2048→6144→2048. The actual-export checks now assert these shapes and two normalization parameter identities reused 16 and eight times within each inspected text layer. Vision checks assert the unpacked Q/K/V/output projections and 1024→4096→1024 MLP corresponding to the printed packed QKV/MLP modules. These checks use metadata only. They do not establish decomposed epsilon or exponent values, or recover source-class provenance from the modified export.

The vision matcher now identifies all 24 complete Transformer blocks using operations, concrete shapes and residual wiring, without consulting module names. The example `/visual/Add` → `/visual/blocks.0/Add` spans the attention half; a whole block also includes the following normalization, MLP and residual Add. Four ×6 stacks preserve the intervening deepstack merger branches and leave 70 nodes visible. Renaming every node and tensor preserves the same detected member indices. A local metadata-only scan took about 33 ms; this excludes model loading, layout and paint.

Opening a vision block shows LayerNormalization → Attention → Add → LayerNormalization → MLP → Add, with 37 attention and five MLP operators available through their **ƒ** icons. Function groups have no ×1 badge. Text decoder blocks now show Normalization → Grouped-query attention → Add → Normalization → MLP → Add without consulting scope names. A regular layer contains 646 attention operators and 11 MLP operators. Its attention view has **15 nodes**, including eight KV groups sharing two query heads each; a selected group opens its 79 original operators. Layer 0 has one extra shared-mask Equal operation, so its attention view has 16 nodes and KV runs of one and seven. All recognition used descriptors with zero additional source reads and no canonical rich-node construction.

Attention recognition validates both dynamic MatMuls, last-axis Softmax, projections and residual shapes. It permits shared KV heads rather than requiring equal Q/K/V head counts: tests cover MHA, MQA broadcasting (including lower-rank KV tensors), GQA KV repetition through Expand/Tile, and GQA with a separate broadcast group axis. Different head configurations can have the same Attention category but cannot share a stack unless their metadata/connectivity fingerprints match. Invalid head broadcasts remain unfolded. Weight equality is never inferred.

Dedicated fixtures now cover fused attention, dynamic shapes, RMSNorm and gated MLPs. The fused matcher follows the [ONNX Attention schema](https://onnx.ai/onnx/operators/onnx__Attention.html) for 3D/4D Q/K/V and the separate [ONNX Runtime operator schemas](https://github.com/microsoft/onnxruntime/blob/main/docs/ContribOperators.md) for 3D MultiHeadAttention/GroupQueryAttention and Attention with merged QKV weights. Domains, head divisibility, projection widths, K/V sequence constraints and output dimensions are checked; arbitrary custom operators named Attention do not qualify. Auxiliary outputs remain real connections when folding or selecting another instance.

Symbolic batch and sequence dimensions are accepted when equality and broadcasting can be established from metadata. Generated dimension labels are normalized by equality relationships for stack signatures; named dimensions and parameter bindings remain literal. Unknown rank, anonymous dimensions, incompatible symbols and unknown projection widths remain unsupported. This does not run shape inference or assume that unrelated dynamic dimensions are equal.

Normalization supports explicit RMSNormalization and legacy SimplifiedLayerNormalization plus the [ONNX RMS square/mean/root computation](https://onnx.ai/onnx/operators/onnx__RMSNormalization.html), with division or reciprocal multiplication and precision casts. These decompositions become expandable RMSNorm functions. The three-projection MLP matcher validates both expansion branches, the activation and multiplicative merge before the down projection; tests cover GLU, GEGLU, Swish and decomposed SiLU/SwiGLU. Initializers in the fixtures throw on payload access, including scalar constants, so these scans cannot silently fetch tensor data.

The supplied Qwen text export uses a separate **computation pattern** match for its unrolled 16 Softmax/32 MatMul attention. It checks each score/probability/value path, Q/K/V projection provenance, shared cache pairs, ScatterElements axes, concrete head widths and complete output merging. Contiguous KV regions are found from dependency closures rather than node paths. Opaque ConstantOfShape payloads and Pow exponents remain unread; power normalization is labeled generically and generated dimensions remain unresolved in the original metadata. Pattern signatures preserve symbolic equality roles, scalar attributes, parameter aliasing and all boundary connections, but do not claim constants, dynamic shapes or computation are identical. The sidebar makes that distinction explicit. A local full-model pattern scan took about 0.45 seconds, excluding initial model loading, layout and paint. Renaming every node and tensor preserves the detected groups.

Recognition remains bounded to residual regions of 2,048 operators and up to 128 unrolled query branches with the tested cache layout. Packed fused layouts beyond the tested forms, conflicting named dimensions, missing shape metadata and noncontiguous normalizer lowerings remain unsupported. Initial loading still skips all folding work.

### Generic topology matching — current application path

Execution graphs now use the same matcher for every operator type and domain. No model/module names or CNN/Transformer/RNN templates determine recognition. Consecutive typed operator signatures feed a rolling hash to reject candidates cheaply; full signatures verify every match and consecutive pairs verify cross-instance wiring. Signatures include attribute types, optional input slots, operator overloads, tensor shape/dtype/layout/quantization and parameter sharing. Opaque tensor attributes expose headers without payload reads. Fork/branch boundaries guide alignment; remaining branch closures become individual functions without repeat badges. Architecture-specific diagnostic helpers no longer select application groups.

All eight supplied ONNX/QNN models in `graph-examples` passed renaming, canonical expansion, exposed-connection and zero-additional-read checks on 2026-10-18. Counts exclude input/output bundles:

| Export | Operators | Displayed |
| --- | ---: | ---: |
| ResNet50 | 122 | 14 |
| EfficientViT B3 | 682 | 39 |
| Qwen text | 19,449 | 521 |
| Qwen vision | 1,170 | 25 |
| Audio encoder | 1,337 | 859 |
| Vision encoder | 1,026 | 165 |
| Merged decoder | 1,287 | 131 |
| QNN JSON | 6,636 | 73 |

ResNet50 retains ×2/×3/×5/×2 runs and four separate transition functions. Qwen text has ×3 and ×24 motif runs; vision has ×3 and ×6 runs. These are repeated exported regions, which can span multiple source modules, not asserted counts of PyTorch layers. The QNN file's differing quantization metadata prevents repeat runs; its 48 branch functions remain separate. Cards show their real operator summaries and **Representative instance** selection rather than guessing source classes.

Local metadata-only analysis took roughly 4 ms for ResNet50, 60 ms for Qwen vision, 0.8 seconds for Qwen text and 1.9 seconds for the QNN JSON, excluding load/layout/paint. A first generic prototype grouped small branches before searching repeats and took about eight seconds on Qwen text; finding raw sequence repeats first and verifying hash candidates avoids that cost. These measurements precede the nested preview and Rust candidate search below.

Synthetic CNN, explicit LSTM/GRU/RNN, unrolled LSTM, symbolic MHA/MQA/GQA and fused-attention/gated-MLP fixtures exercise the same algorithm. Consistently replacing all operator names and domains with unfamiliar ones preserves their matches. Different attributes, tensor metadata, optional slots, parameter sharing and state connections cannot be folded into a single verified run. No standalone LSTM or Llama export was supplied.

Initial loading still skips analysis and weights remain on demand. Each motif/branch closure is bounded to 1,024 operators; matching yields and cancels. Missing ranks, control flow, unsupported metadata and noncontiguous or larger motifs remain visible. Anonymous dimensions stay unresolved and tensor payloads are not compared, so a visual match is not proof of identical runtime computation. Weight-only Safetensors/GGUF retain the named inventory matcher because they have no execution topology.

```bash
node test/pattern-folder.mjs graph-examples
node test/resnet-folding.mjs /path/to/resnet50.onnx
```

### Nested presentation and Rust candidates (2026-10-19)

The Qwen vision root remains 25 display nodes. Its first stage frame shows three copies of `[6 × 46 operators] + [14 other operators]`; the following deck covers the final six 46-operator blocks. Source-only annotations account for blocks 0–23 as `3 × 6 + 6`. The complete model contains 1,170 operators; those repeated regions cover 1,146. The fourteen tail operators are not asserted to be an architecture-specific merger class. Each inline inspection opens the selected stage's own canonical indices and parameter references.

For graphs of at least 512 operators, the existing Rust/WASM asset now also supplies a candidate index. It links matching operator tokens, bounds motif periods to 1,024, and applies the existing missing-metadata and fork rules. Only compact tokens and flags cross the WASM boundary; weights never do. Full signatures, cross-instance wiring and all connection preservation checks remain authoritative in JavaScript. The index is disposed on completion, error or cancellation; the JavaScript search remains the fallback. The shared WASM asset grew from 31,461 to 38,280 bytes, without a new dependency.

One local 20,000-token synthetic benchmark measured approximately 59 ms for the JavaScript candidate search and 4.4 ms for the Rust/WASM index including setup, with identical candidate outputs. This is a candidate-kernel comparison, not a whole-model speedup. Full toolbar analysis including the new previews measured around 0.10 seconds for Qwen vision and 1.08 seconds for Qwen text; layout, paint and initial load are excluded. All eight supplied model files still preserve renamed matches, canonical expansion and zero extra source reads or rich-node construction. Source indices disappear when names are removed; grouping does not change.

The supplied five-pass proposal is a design reference, not a replacement correctness specification. Remaining work requires stronger evidence than the prototype provides:

| Proposed technique | Required before implementation |
| --- | --- |
| Conversion/transpose edge badges | Preserve ordered operations, attributes, both tensor identities and every consumer/output. Equal element counts do not establish semantic equivalence; quantization is numerically significant. |
| Parallel repeat bundles | Verify disjoint branch interiors, complete signatures, fan-out/reconvergence and all boundary mappings. Existing repeat badges describe verified serial dependencies only. |
| Variant and transition containers | Establish complete block boundaries and retain each variant and its exact order. Equal interfaces alone do not prove common layers, and filenames cannot establish a 28-layer count. |
| Indexed tensor buses | Retain every tensor's dtype, quantization, instance index and inspection/selection mapping; endpoint/shape deduplication loses information. |
| Full compound layout and global navigation | The current inline recipes reuse bounded node geometry. Pinned interactive barcodes, a separate canvas gutter, recursively routed child graphs and incremental stage layouts remain unimplemented. |

The supplied Python prototype also leaves serial-fold edges pointing at removed nodes and deduplicates distinct tensor edges. It is not executed or shipped. No 24-layer equivalence claim is inferred for the QNN export while its quantization metadata differs.

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
