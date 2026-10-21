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

Overview shapes have accessible names, keyboard activation and compact type labels. Labels stay approximately 12 screen pixels high, with a small spatial grid suppressing neighboring labels to avoid overlap; node data and controls remain deferred. Selected/focused nodes keep detail; image export always materializes complete node content, then restores the interactive overview. Initial loading remains at its normal zoom and weight loading remains on demand. Repeated-block analysis is opt-in after loading through **View → Fold Repeated Blocks** or the toolbar; results are reused when folding again, and the option resets to off for each newly opened model. Execution-graph stacking now prefers verified Transformer boundaries and uses generic topology matching for unclaimed operators; named inventory matching is retained only for weight-only formats. The shipped WASM was rebuilt alongside its Rust source in the previous optimization.

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

The recognizer below originally ran as an offline diagnostic utility. The Transformer-first application path added on 2026-10-19 now reuses its conservative attention/MLP residual boundaries before generic topology matching. The audit below records current coverage and unsupported exports.

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

### Generic topology matching — fallback and earlier measurements

The generic matcher handles every operator type and domain without model/module names or CNN/Transformer/RNN templates. It now runs outside verified Transformer regions, or across the full graph when architectural recognition finds no supported blocks. Consecutive typed operator signatures feed a rolling hash to reject candidates cheaply; full signatures verify every match and consecutive pairs verify cross-instance wiring. Signatures include attribute types, optional input slots, operator overloads, tensor shape/dtype/layout/quantization and parameter sharing. Opaque tensor attributes expose headers without payload reads. Fork/branch boundaries guide alignment; remaining branch closures become individual functions without repeat badges. The following measurements describe the earlier generic-only application path.

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

### Nested presentation and Rust candidates (2026-10-19, earlier generic path)

Before the Transformer-first path below, the Qwen vision root contained 25 display nodes. Its first stage frame shows three copies of `[6 × 46 operators] + [14 other operators]`; the following deck covers the final six 46-operator blocks. Source-only annotations account for blocks 0–23 as `3 × 6 + 6`. The complete model contains 1,170 operators; those repeated regions cover 1,146. The fourteen tail operators are not asserted to be an architecture-specific merger class. Each inline inspection opens the selected stage's own canonical indices and parameter references.

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

## Transformer-first presentation and Softmax audit — 2026-10-19

The main folding path now prefers verified pre-norm Attention → residual Add → pre-norm MLP → residual Add blocks. Architectural boundaries are established from operations, shapes, projections and wiring before searching for exporter-order repetition. This prevents a recurring group of several Transformer layers from replacing the actual layer count. Different metadata or intervening operations split runs; they do not merge distinct variants. Generic matching remains active outside the recognized blocks and across unsupported graphs. Initial loading still skips all folding work.

Cards for repeated Transformer runs show the total detected Transformer count, detected-order indices, a canonical normalization/attention/MLP residual recipe, and the selected block's Softmax count. The stack-click fact sheet reports how many graph Softmax operators lie inside verified blocks. Named source modules and Softmax counts do not determine architectural boundaries. One canonical anatomy and compact architecture facts follow the presentation approach of [Sebastian Raschka's LLM Architecture Gallery](https://sebastianraschka.com/llm-architecture-gallery/); its model counts are not used as evidence for these exports.

The real-model audit on the Ryzen 9 9950X3D / Node v24.13.0 checkout produced:

| Export | Operators | Explicit Softmax ops | Detected Transformer blocks | Softmax ops per detected block | Transformer run sizes | Displayed nodes | Analysis (ms) |
| --- | ---: | ---: | ---: | --- | --- | ---: | ---: |
| Qwen vision | 1,170 | 24 | 24 | 1 | 6 + 6 + 6 + 6 | 66 | 33 |
| Qwen text | 19,449 | 448 | 28 | 16 | 1 + 1 + 1 + 25 | 524 | 598 |
| Audio encoder | 1,337 | 12 | Unverified | — | Generic fallback | 859 | 60 |
| Vision encoder | 1,026 | 16 | Unverified | — | Generic fallback | 165 | 89 |
| Merged decoder | 1,287 | 23 | Unverified | — | Generic fallback | 131 | 53 |
| QNN JSON | 6,636 | 336 | Unverified | — | Generic fallback | 73 | 1,396 |
| ResNet50 | 122 | 0 | 0 | — | Generic fallback | 14 | 9 |
| EfficientViT B3 | 682 | 0 | 0 | — | Generic fallback | 39 | 25 |

All 24 Qwen vision Softmax operators and all 448 Qwen text Softmax operators are accounted for inside the detected blocks. Text attention unrolls 16 query heads per layer, so treating each Softmax as a Transformer would overcount by 16×. Unit fixtures also cover fused attention with three blocks and zero explicit Softmax operators. The unsupported audio/vision/decoder exports contain symbolic or missing intermediate shapes and different normalization/attention lowerings; the quantized QNN export is outside the current ONNX floating-point recognizer. Their Softmax inventories are diagnostics, not asserted Transformer counts. In particular, 336 QNN Softmax operators alone cannot establish 24 layers.

Every supplied export passed renamed-node/tensor matching, exact canonical expansion, exposed-connection checks, zero additional source reads and zero rich-node construction. The new application regression fixture verifies 24 Transformer blocks despite eight recurring three-block variants. Separate tests preserve generic repetition outside protected Transformer regions and reject Softmax-only evidence without the residual recipe. Timings include application analysis and presentation preparation; they exclude model opening, layout and paint, and are single local observations.

Reproduce the audit, including the generic-only repeat counts for comparison:

```bash
node test/architecture-folder.mjs graph-examples
```

This audit supersedes the earlier generic-only displayed counts for the two supported Qwen exports. It does not claim support for every Transformer lowering or attach architecture labels to unsupported patterns.

### Architecture profiles and gallery references

Verified blocks now carry a feature profile alongside their repeat signature. Profiles report normalization, MHA/MQA/GQA when established, explicit/fused/unrolled attention, dense or gated MLP activation, hidden/intermediate widths, and evidence ranges. These labels are derived from the recognized computation paths, not operator-name presence alone. For example, SwiGLU requires the verified SiLU gate, a separate up projection, multiplicative merge and down projection; GELU on a separate branch cannot establish it.

The initial reference catalogue uses two gallery recipes: classic LayerNorm + MHA + GELU dense blocks (shared by GPT-2), and RMSNorm + GQA blocks (shared by Llama 3 and Qwen3). These are shared-feature comparisons, not model identification. Known conflicting features reject a reference recipe; unverified features produce an explicitly partial match. Positional encoding, attention masking and source model identity remain unresolved unless separately established. The gallery is linked from the fact sheet and is not fetched during model loading.

| Supplied export | Observed block profile | Reference comparison |
| --- | --- | --- |
| Qwen vision | LayerNorm · MHA with 16 query / 16 KV heads · GELU MLP, 1024 → 4096 → 1024 | Shared features with the classic dense Transformer recipe; this does not identify GPT-2 or establish a text decoder |
| Qwen text | Unresolved normalization · GQA with 16 query / 8 KV heads · SwiGLU, 2048 → 6144 → 2048 | Partial RMSNorm/GQA recipe match: GQA is established; the opaque Pow normalization exponent remains unread |

Qwen vision packs its heads into the leading dimension through Split/Concat, then broadcasts spatial/query dimensions during attention. Reading the second MatMul dimension as a head count would incorrectly label it MQA. The profile now verifies all Q/K/V feature partitions, their ordered Split/Concat mapping and the complete output-head merge before reporting 16-head MHA. Ambiguous slice/concat/expand layouts retain the generic SDPA label instead of guessing head sharing. Fused and unrolled layouts use their separately validated schema/provenance evidence.

Regression tests cover dense and gated recipes, MQA, fused GQA, opaque-normalization partial matches, packed-head provenance, duplicated-slice rejection, and profile invariance after renaming. All profiles remain metadata-only and do not modify grouping or inference semantics. The reference catalogue is deliberately limited to the verified feature recipes above; it does not identify arbitrary architectures from the full gallery.

### Individual blocks expanded inline

Execution-graph stacks now support **Expand selected block inline** in the representative selector sidebar, plus an **Expand block N inline** header control. The chosen instance uses its original operators, parameter references and tensor shape labels in the parent graph. The surrounding instances become independent collapsed runs. For a 25-block run, opening block 0 leaves a ×24 remainder; opening block 12 leaves ×12 runs on either side. Several instances can remain open simultaneously. **Fold block N** on the first exposed operator or **Fold selected block inline** in the sidebar merges the collapsed neighbors again.

Inline state is tracked per original group and instance position, separately from full-stack expansion. A collapsed remainder retains the original instance indices and its own boundary tensors and representative. Expanding one remainder leaves the other remainder and unrelated stacks alone. Full-stack controls and disabling/re-enabling Graph Stacking reset partial expansion consistently. Interleaved module scopes whose instances do not occupy ordered contiguous regions retain full-stack expansion only, because partial contraction could change the dependency graph.

Regression fixtures exercise the first, middle and last instance in a 25-block Transformer, multiple open instances, singleton remainders, external attention taps, exact tensor-type/shape identities, complete canonical expansion, fold-back and full-stack transitions. Real Qwen text and vision browser checks cover inline controls, both remainder counts, native tensor labels, folding back, and zero additional model source reads. Layout still runs for the projected parent graph after each change; this does not introduce incremental layout.

### Full-block inspection without nested stacks

The representative sidebar now offers **Open full block** beside **Open module**. The former opens the selected canonical instance in a separate view and bypasses repeated/structural folding for that target only; the latter keeps the default nested presentation. Back navigation retains the parent stack state. Full inspection retains original parameter references and tensor types, displays available tensor shapes even when names mode is enabled, and removes the normal 16-character edge-shape suppression. Missing shapes remain unknown; inspection does not run inference or fetch tensor weights.

Subgraph construction and its inspection flag are created only on click. With Graph Stacking disabled, the first-open presentation still returns before analysis, imports, operator enumeration or repeat-state allocation. A regression test verifies this using an operator getter and analysis callback that throw if accessed. Layout of the selected block is still required when opening it; this is not incremental layout or model paging.

First-open spot checks using `node test/benchmark-model-opening.mjs graph-examples/qwen3_vl_p2b_instruct_d28_1111111011011100010_slim.onnx` (mock DOM, serial layout) retained 19,449 displayed operators, 27,466 connections, 163,515 route points and **zero source bytes during rendering**. Before/after measurements in milliseconds were index 47.4/46.7, parse 113.4/123.9, prepare 232.5/231.6, layout 3192.1/3185.1 and tile indexing 134.3/137.8. The final after run ran without the browser/unit suites. These single-run measurements show no material first-open difference in this spot check, but do not establish a statistically bounded performance change or browser paint performance. The first-open guard verifies that this feature adds no eager block-analysis work.

Lint and all 19 unit test files pass. Browser regressions pass for EfficientViT, Qwen text, Qwen vision and ResNet: exact selected-block operator counts, no nested repeat cards, available Qwen tensor shape labels, return navigation and default module inspection, with zero additional model bytes fetched.

## Local machine benchmarks — 2026-10-19

Measured on an AMD Ryzen 9 9950X3D (16 cores / 32 threads), approximately 29 GiB RAM, Linux x86_64 and Node v24.13.0. The checkout was based on `658dba33ea0bca5d3e5e503ed9c1c68f16681c2f`, including the uncommitted stack schematic changes. Benchmarks ran sequentially. All ten existing benchmark commands and the additional stack-click harness completed successfully. The folding and viewport commands required a retry outside the execution sandbox because their Node child processes were initially blocked with `EPERM`.

These measurements use synthetic fixtures and the mock DOM. No real ONNX/QNN models, comparison against the previous Git revision, browser paint/FPS, GPU rendering, remote mounts or end-to-end UI latency were measured in this run. Earlier real-model measurements above are separate runs on other hardware.

### Stack-click interaction

The synthetic graph contains eight operators per attention/MLP layer. Each case uses 20 warmups and 100 measured samples for schematic extraction and stack-click construction. Initial folding analysis is a single measurement per size. Click timing includes the fact sheet, instance selector and SVG construction in the mock DOM; browser event dispatch, layout, paint and compositing are excluded. JIT and garbage collection can affect comparisons across sizes.

| Layers | Original operators | Initial folding analysis (ms) | Click median (ms) | Click p95 (ms) | Click max (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 24 | 192 | 11.11 | 0.042 | 0.066 | 0.192 |
| 96 | 768 | 27.76 | 0.057 | 0.075 | 0.260 |
| 256 | 2,048 | 51.27 | 0.054 | 0.099 | 0.475 |
| 1,024 | 8,192 | 158.95 | 0.125 | 0.148 | 0.433 |

All cases folded to one displayed node and used 25 SVG elements for the representative anatomy. Assertions verified attention/MLP zones and residual connections; throwing getters guarded against weight reads and canonical rich-node construction. Both remained zero. Schematic extraction alone had medians of 0.010–0.019 ms. The full click still constructs one selector option per instance, so its work grows with the instance count even though extraction examines one representative.

### Rust/WASM and metadata indexing

The 20,000-token candidate kernel took **29.03 ms in JavaScript** and **2.29 ms in Rust/WASM**, approximately **12.7× faster** for this kernel, with identical candidate outputs. This is one timing per implementation and excludes metadata signatures, whole-model parsing, layout and paint; it does not establish an application-wide speedup.

Warm metadata indexing used five warmups and ten measured iterations, with source reads copied from an in-memory file:

| Format | Fixture operators/modules | Median indexing (ms) | Source requests |
| --- | ---: | ---: | ---: |
| ONNX | 32,768 | 23.65 | 244 |
| GGUF | 32,768 | 3.71 | 54 |

### Folding and viewport

For 256 layers (512 original nodes), folding reduced the displayed graph to two nodes:

| Format | Expanded layout (ms) | Folded layout (ms) | Expanded heap (MiB) | Folded heap (MiB) |
| --- | ---: | ---: | ---: | ---: |
| Safetensors | 10.44 | 3.09 | 8.36 | 7.37 |
| GGUF | 10.46 | 2.93 | 8.15 | 7.08 |
| ONNX | 30.49 | 3.33 | 11.87 | 10.89 |

These cases use fresh processes, fixed 150×65 layout nodes and sparse 4 MiB tensors. Every tensor preview read exactly four bytes. This existing folding benchmark exercises `repeatedBlocks`, separately from the new schematic pipeline; layout times exclude model opening and folding preparation.

For 2,048 displayed nodes, viewport eviction retained 47 model objects for Safetensors/GGUF and 32 for ONNX, versus 2,048 without eviction. All viewport and overview cases preserved geometry and performed zero source reads during rendering. Full-detail versus overview results were:

| Format | Detail → overview mock-DOM render (ms) | Detail → overview heap (MiB) |
| --- | --- | --- |
| Safetensors | 35.74 → 9.46 | 54.86 → 20.61 |
| GGUF | 35.22 → 7.47 | 54.09 → 19.61 |
| ONNX | 31.48 → 14.30 | 55.33 → 37.47 |

The spatial-index microbenchmark indexed 10,000 short edges in 4.72 ms. A 300-tile diagonal took 0.50 ms to index; its viewport query took 0.004 ms and returned zero irrelevant edges. Overview queries averaged 0.039 ms over 100 queries. These are CPU timings, not browser frame times.

### Synthetic loading

Sparse fixtures contain approximately 256 MiB of tensor/payload data with no simulated network latency. Cold indexing includes WASM compilation; full scans run afterward. Sparse storage and page-cache ordering make these unsuitable for physical-disk or network-throughput claims. Each case was measured once.

| Fixture | Index time (ms) | Full byte scan (ms) | Bytes avoided |
| --- | ---: | ---: | ---: |
| Safetensors | 1.35 | 3.93 | 99.976% |
| Scattered ONNX tensors | 1.85 | 3.95 | 99.963% |
| Contiguous ONNX metadata | 199.55 | 4.13 | 0.000% |
| Large GGUF header | 2.70 | 4.37 | 99.105% |

The contiguous-ONNX fixture puts 256 MiB in a non-tensor protobuf field. The index must preserve that metadata and reads everything, making indexing substantially slower than a byte scan in this adverse case. It does not demonstrate tensor-weight skipping.

### Reproduction

Run the existing benchmarks from the project root:

```bash
node test/benchmark-index.mjs
node test/pattern-index.mjs --benchmark
node test/benchmark-repeated.mjs
node test/benchmark-rendering.mjs
node test/benchmark-viewport.mjs
node test/benchmark-viewport.mjs --overview
node test/benchmark-loading.mjs --fixture=safetensors --size=256
node test/benchmark-loading.mjs --fixture=scattered-onnx --size=256
node test/benchmark-loading.mjs --fixture=contiguous-onnx --size=256
node test/benchmark-loading.mjs --fixture=large-gguf --size=256
```

The additional stack-click harness and raw logs were saved locally under `/tmp/fastron-local-bench-20261019/`, including `stack-click.mjs`, `results.json` and `runs.json`. These temporary artifacts are not checked into the repository and may be removed by system cleanup; the measurements and methodology are recorded here.

## What to adapt from Model Explorer next

| Priority | Technique and evidence | Fit for Fastron |
| --- | --- | --- |
| Applied | Zoom-dependent detail: [`updateNodeBgColorWhenFar()`](https://github.com/google-ai-edge/model-explorer/blob/0340b90e36d74007101edee342123e51416eba41/src/ui/src/components/visualizer/webgl_renderer.ts#L1673) adjusts distant-node presentation and hides optional SVG text | Adapted the idea to Fastron's SVG renderer by avoiding rich node construction. No renderer dependency or upstream code was copied |
| Next for layout/memory | Hierarchical expansion and local layout: [`GraphExpander`](https://github.com/google-ai-edge/model-explorer/blob/0340b90e36d74007101edee342123e51416eba41/src/ui/src/components/visualizer/worker/graph_expander.ts) lays out children and their ancestors | Keep collapsed groups as boundary summaries and compute child geometry when expanded. This addresses graph-wide geometry that viewport DOM culling cannot remove. Preserve every external port, control edge and search target; names alone are insufficient evidence for semantic folding |
| Next for dense overview paint | GPU instancing: [`webgl_rounded_rectangles.ts`](https://github.com/google-ai-edge/model-explorer/blob/0340b90e36d74007101edee342123e51416eba41/src/ui/src/components/visualizer/webgl_rounded_rectangles.ts) uses instanced typed buffers; [`webgl_texts.ts`](https://github.com/google-ai-edge/model-explorer/blob/0340b90e36d74007101edee342123e51416eba41/src/ui/src/components/visualizer/webgl_texts.ts) batches glyphs with a font atlas | Profile browser paint on dense graphs after LOD. Prototype batched edge rendering first if edges dominate. Retain accessible DOM overlays, selection/hit testing, context-loss recovery and full SVG export before replacing the default renderer |
| Next for worker overhead | Worker-owned hierarchy and layout state: [`worker_service.ts`](https://github.com/google-ai-edge/model-explorer/blob/0340b90e36d74007101edee342123e51416eba41/src/ui/src/components/visualizer/worker_service.ts) and the graph expander | Fastron already moves indexing/layout into workers, but layout sends object arrays each way. Measure serialization and peak memory, then use persistent worker state and transferable packed geometry where it matters |

Keep Fastron's exact repeated-block validation. Model Explorer's [`IdenticalGroupsFinder`](https://github.com/google-ai-edge/model-explorer/blob/0340b90e36d74007101edee342123e51416eba41/src/ui/src/components/visualizer/worker/identical_groups_finder.ts) groups structural hashes for visualization. That is useful for finding candidates, but a hash match alone must not decide whether Fastron can hide an instance or report two models as equal.

Further Rust work should follow measured CPU costs: compact topology indexes and structural signatures are candidates. Moving rendering code to Rust cannot by itself remove SVG elements, browser layout/paint, or network round trips. For remote weights, request count, metadata placement, source-version checks and bounded previews still matter more than scalar decode time.

## Native source optimizations — 2026-10-20

The supplied Windows ARM64 Orion/SMB profile reported two initial `realpath` calls taking 3.82 seconds combined in one run and 3.18 seconds in another. Its 572 filesystem reads included 474 post-skip 256-byte probes; reads dominated the slower run. Those are supplied observations, not measurements reproduced on this Linux machine. The source worker already retained one descriptor across indexing, so per-read descriptor caching was not added.

The native open handler now reuses its canonical initial path in `describe(initial=true)`. Referenced files still undergo `realpath` and directory-containment checks. File metadata validation and descriptor version checks before/after indexing and tensor reads remain in place. A worker-level regression counts one initial canonicalization and verifies that a referenced symlink escaping the model directory is rejected.

Native indexing also uses a bounded adaptive read-ahead cache. Isolated post-skip probes remain exact, normally 256 bytes. Only when another small request immediately follows the cached window does it fetch up to 4 KiB, serving following requests from that window. Large sequential windows remain unchanged. Extra speculative reads are bounded to less than 4 KiB per refill, though cumulative extra bytes depend on the model. The cache exists only for the index pass; tensor previews/full reads retain exact requested ranges. Browser/HTTP sources retain their original policy and do not import the native helper. No Rust/WASM changes were required.

Local comparisons using the same native-index read policy:

| Fixture | Source requests, exact → adaptive | Source bytes, exact → adaptive | Index time, exact → adaptive |
| --- | ---: | ---: | ---: |
| Qwen vision, no injected latency | 266 → 263 | 653,435 → 656,507 | 9.08 → 5.87 ms |
| Qwen text, 1 ms injected per read | 214 → 212 | 7,159,548 → 7,160,060 | 248.92 → 246.43 ms |
| 128 scattered ONNX tensors with 1,700-byte metadata tails, 2 ms injected per read | 385 → 257 | 294,823 → 619,943 | 812.85 → 542.06 ms |

These are sequential single-run spot checks with fresh WASM compilation, not controlled physical-disk/cache measurements. The synthetic case reduces requests by 33% while reading 325,120 extra bytes; it still avoids 96.35% of the 16,996,743-byte file. The real Qwen improvements are much smaller. Matching SHA-256 metadata/range hashes were checked for Qwen vision and the synthetic case; unit fixtures compare metadata and ranges byte-for-byte. No Orion/SMB end-to-end speedup is established. Mandatory probes at widely separated tensor boundaries remain; removing one redundant path resolution does not eliminate the other filesystem metadata operations.

Reproduce the synthetic comparison:

```bash
node test/benchmark-loading.mjs --fixture=metadata-scattered-onnx --size=16 --latency=2 --exact-reads
node test/benchmark-loading.mjs --fixture=metadata-scattered-onnx --size=16 --latency=2
```

The benchmark now defaults to the production native read policy, with `--exact-reads` providing the previous behavior, and reports SHA-256 hashes for metadata and tensor ranges. Full-scan behavior is unchanged. Tests cover cache hits/misses, isolated probes, EOF, invalid ranges, failed-read retry, payload offsets, mutation and symlink containment. ESLint and all 19 unit test files pass. A fresh 19,449-operator Qwen opening retained all 27,466 connections and 163,515 route points, with zero source bytes during rendering (index 40.40 ms, parse 106.58 ms, preparation 257.23 ms, serial layout 3400.74 ms, tile indexing 138.91 ms; mock DOM, excludes paint/network). Raw local results are under `/tmp/fastron-*-before.json`, `/tmp/fastron-*-after.json`, `/tmp/fastron-local-*.json` and `/tmp/fastron-open-optimized.log`.

## Windows identity and session index cache — 2026-10-20

Windows ARM64 validation reproduced ten source-test failures caused by Node reporting `stat.dev = 0` through path stat but a volume serial number through descriptor stat. Native version tokens now omit the unreliable device component on Windows only, retaining canonical path, inode, size, nanosecond modification time and change time. Other platforms retain device identity. Descriptor validation before and after indexing and weight reads remains mandatory; the descriptor also closes when the initial stat/check fails.

Native repeat opens now reuse a session-local metadata index, bounded to eight entries and a 64 MiB accounted budget with least-recently-used eviction. Accounting includes metadata and a conservative range-object allowance; it is not a process RSS cap. ONNX, GGUF and Safetensors indexes qualify; full-file fallback formats do not. The cache lives in the Electron main-process transport (or the Node process), survives source-worker disposal, and disappears on application exit. No disk sidecar or tensor-payload cache is created. Each candidate is checked against fresh canonical-path/stat information and both descriptor version checks before reuse. Referenced files still resolve and validate independently; tensor previews still use their exact requested ranges and pinned versions. Cache copies prevent consumer mutation or transferred buffers from changing retained entries. Different path spellings may miss the cache safely.

Three same-process opens of the supplied 1,246,470,107-byte Orion model on Windows ARM64 / Node v22.14.0, each using a fresh source worker, measured:

| Open | Source open/index | Parse | Model filesystem reads | Model bytes read |
| --- | ---: | ---: | ---: | ---: |
| Initial, no retained index | 114.401 s | 60.68 ms | 570 | 6,032,115 |
| Retained index | 4.540 s | 35.25 ms | 0 | 0 |
| Retained index | 1.222 s | 18.46 ms | 0 | 0 |

All opens retained 1,386 model operators and identical metadata/range SHA-256 hashes, also matching the earlier exact/adaptive Orion comparison. Cached opens still performed one realpath, one stat, one open and two descriptor stats. These metadata operations took approximately 4.49 s and 1.17 s, explaining most remaining source time. Initial reads took 107.29 s in this observation. OS/server cache state and network latency were uncontrolled: the elapsed-time ratios are not an isolated causal speedup measurement. The directly verified improvement is elimination of all 570 model-data reads on unchanged repeat opens. First opens, reopened applications, evicted entries and changed models still require indexing. Filesystem version tokens rely on the server reporting coherent identity/timestamps; they are not content hashes.

Reproduce with `node test/benchmark-source-reopen.mjs <model.onnx> <output.json>`. The harness asserts matching metadata/range hashes, stable operator counts and zero model bytes on cache hits; it excludes layout, Electron IPC and paint. Raw observations are in `dist/benchmark-onnx/native-cache/orion-reopen.json`, with worker CPU/I/O profiles in `dist/profile-orion/native-cache-reopen/` (local artifacts, not checked in).

All 39 focused loading/source/Electron tests pass, including cache bounds/eviction, ownership of transferred metadata, all three indexed formats, changed/replaced/deleted files, descriptor mutations before/after cache reuse, lazy previews and Electron session lifetime. The full 19-file suite passed 275 tests with one unrelated publishing-test failure: this checkout lacked `js-yaml`; supplying it exposed an absent hard-coded Git Bash executable. Changed JavaScript files pass ESLint. Browser paint and NFS have not been remeasured.

## Windows desktop metadata round trips and actual rendering — 2026-10-20

Desktop opening previously ran `existsSync` plus `statSync`, then another `statSync` during context creation. It now runs one asynchronous path stat and passes that result into context creation. This removes two desktop metadata requests on successful opens and avoids blocking the renderer on the retained network stat. Pending stat requests are ordered separately from accepted model opens: a late result cannot replace a newer request, and an unsupported path cannot cancel an accepted model still loading. Directory enumeration and other legacy format reads are unchanged.

The native worker now derives file length/version from the initial descriptor stat instead of a separate path stat followed by the descriptor stat. The same descriptor remains open for indexing, with the second descriptor stat still required afterward. Cache candidates are matched against that fresh descriptor identity. Preview reads still validate before and after reading, and companion paths still canonicalize and enforce directory containment. POSIX opens use nonblocking mode before the regular-file check so a FIFO cannot stall the worker. This saves one worker path stat without relaxing mutation checks. For the indexed desktop path this is three fewer explicit metadata calls per successful open in total; syscall counts do not imply an exact number of SMB wire requests.

The new `test/benchmark-desktop-opening.mjs` launches actual Electron with an independent application profile, waits for the current request's spinner-to-default transition and visible graph nodes, then waits two animation frames and captures screenshots. Its isolated-tooling launcher converts resolved Windows paths to file URLs. The remote LM Head model rendered 24 viewport node elements in 5.714 s initially and 0.323/0.292 s on repeat opens. The 1.25 GB Orion feature extractor rendered 22 viewport node elements in 134.229 s initially and 6.168/3.025 s on repeat opens. Viewport element counts are not total operator counts. Screenshots confirm populated, legible graphs; first-open delays still include remote data access. These are current-state observations with uncontrolled server/OS caches, not bounded before/after speedup or frame-rate claims. The earlier launcher baseline did not enforce the same completed-request transition, so its repeat times are not used as comparative evidence.

No renderer timing, graphics-driver flags or GPU backend changes were made. Large deferred graphs already bypass frame-waiting measurement through metadata sizing. Windows `Atomics.wait` scheduling behavior does not establish animation-frame costs; frame scheduling will require its own controlled measurement before changes. No long tasks were reported by this diagnostic observer for these final desktop trials; that observation is not proof that all renderer tasks or GPU work were short.

All 278 tests in the 18 platform-available unit files pass; the publishing file remains excluded because of the previously established Git Bash environment blocker. Changed files pass ESLint and whitespace checks. New regressions cover asynchronous metadata ordering, rejection without canceling an accepted open, no redundant native path stat, invalid-directory rejection and descriptor mutation before/after cached reuse. Actual-UI artifacts are under `dist/benchmark-onnx/windows-native/desktop-after.json` and `desktop-orion.json`, with screenshots alongside them (local artifacts, not checked in). This tests a Windows client over the supplied UNC shares; it does not certify every server OS, SMB configuration or NFS mount.

The final source-worker profile independently verified zero path-stat calls, one realpath, one open and two descriptor stats on every Orion open. Source open/index took 109.635 s initially and 4.110/0.795 s on cache hits; all metadata/range hashes and 1,386 operators matched. Cache hits read zero model bytes. The initial 570 reads took 107.10 s, so eliminating redundant metadata calls does not solve first-open scattered-read latency. Raw source observations are in `dist/benchmark-onnx/windows-native/source-orion.json`, with I/O/CPU profiles in `dist/profile-orion/windows-native/`.

## Cross-platform integration validation — 2026-10-20

The captured native optimizations are integrated in the checkout: descriptor-based identity checks, one initial canonicalization, adaptive metadata reads, the bounded session index cache, asynchronous desktop metadata ordering and Electron source lifetime cancellation. PowerShell is needed only for the standalone snapshot installer, not for running these optimizations.

The shared source transport now imports and allocates the native metadata cache lazily on the first native open. Browser and Electron renderer module loading no longer fetch this native-only module. Concurrent native opens share initialization; failed initialization can retry, and disposal during initialization prevents an obsolete request from being sent. Cache hits still require fresh descriptor validation; exact tensor previews and first-open folding behavior are unchanged.

Fresh local Linux processes using `test/benchmark-source-reopen.mjs`, with a fresh source worker for every trial, observed:

| Model | Operators | Initial source open/index | Repeat source open/index | Initial bytes read | Repeat bytes read |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qwen vision | 1,170 | 23.80 ms | 17.82 / 17.54 ms | 656,516 | 0 / 0 |
| Qwen text | 19,449 | 39.18 ms | 21.59 / 17.78 ms | 7,160,069 | 0 / 0 |

Metadata/range SHA-256 hashes and operator counts matched on every open. These single-run observations exclude parsing, layout, paint and Electron IPC, use uncontrolled OS caches, and ran while the browser regression suite was active. They establish cache reuse and zero repeat model-data reads, not a controlled throughput comparison or an SMB performance claim. Reports are saved locally as `/tmp/fastron-integrated-reopen-vision.json` and `/tmp/fastron-integrated-reopen-text.json`.

ESLint and all 19 unit test files pass, including cancellation during lazy cache initialization. Browser checks for Safetensors, GGUF, ONNX, viewport eviction, folding and SVG export pass, with an explicit assertion that no `model-source-cache.mjs` request occurs. The browser log is `/tmp/fastron-native-cache-browser.log`.

## Windows first-open identity changes — 2026-10-20

Windows users reported `Model file changed while reading` on the first open of local files, with the next open succeeding. The particular changing stat field has not yet been captured on the affected machine. Initial native Windows opens now retry indexing exactly once after a post-read identity mismatch. The failed snapshot and candidate cached index are discarded, the descriptor is reopened, and a fresh index must pass both descriptor checks. Repeated instability still fails. Normal opens retain the existing two descriptor stats; retries add work only after a failed attempt. Linux/browser behavior and preview offset pinning are unchanged.

Identity errors now name the changed fields and their expected/observed values (device, inode, size, modification timestamp or change timestamp), rather than asserting a change without evidence. No timestamp or identity field is ignored to accommodate this report. Regressions emulate Windows initial-read mutation, verify that only the freshly rebuilt metadata is returned, reject a second unstable attempt, and reject changed preview reads without retrying them. These tests run on Linux with the Windows branch exercised; reproducing the affected Windows filesystem behavior remains necessary to identify its underlying cause.

## Remaining limits

Canonical metadata, ONNX initializer records, displayed graph topology, layout and the spatial index remain resident. Repetition checks still inspect later instances' metadata. Generic formats and HTTP servers without usable versioned ranges can retain full-download behavior. The new overview only simplifies ordinary nodes in large deferred graphs; it does not page the entire model or replace edge rendering with a GPU backend.

Earlier validation covers unit regressions, Rust tests, cached model validation, browser loading/folding/weight previews/exports, and desktop/browser smoke tests. The Windows Orion SMB observations above supplement the earlier Linux-only native checks; representative NFS and Remote SSH models remain untested. Use `test/benchmark-loading.mjs` with a real mounted model and the remote benchmark instructions in `CONTRIBUTING.md` before making remote-throughput claims.
