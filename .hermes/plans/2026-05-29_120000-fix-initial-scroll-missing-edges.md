# Fix: Initial View Scrolls to Middle + Missing Edge Connectors on ARM

**Date:** 2026-05-29  
**Files:** `source/view.js`, `source/grapher.js`

---

## Goal

Fix two rendering bugs in the Fastron standalone Electron app:

1. **Bug A** — On first load, the viewport scrolls to the middle of the graph instead of the input nodes.
2. **Bug B** — On Qualcomm Snapdragon (ARM) hardware, some edge connectors are missing (not rendered) while others are visible. Intermittent.

---

## Current Context / Root Cause Analysis

### Bug A — Input node scroll fails

Three code paths attempt to scroll to input nodes at load time. All three can silently fall through to center-graph fallback:

#### Path 1 — `restore()` in view.js ~line 2685
Called after layout completes. If the container is still hidden (Electron shows the window after `app.js` finishes loading), `clientWidth=0` → `_needsZoomFit=true` is set, and `scrollTo()` is a no-op on a zero-size container.

#### Path 2 — `register()` in view.js ~line 2748
Called synchronously when the container becomes visible. Checks `_needsZoomFit` and applies zoom + scroll. This is the correct rescue path — but it has a subtle race:

With **viewport culling enabled** (large graphs trigger it), the initial `_onViewportChange` hasn't fired yet (it's scheduled with `setTimeout(..., 100)`). The `_inputNodes` array holds `view.Input` objects whose `.x`/`.y` are set by Dagre layout — those values should be present since layout runs before register(). The guard `typeof node.x === 'number'` should pass. **However**, `_inputNodes` is never cleared between model loads (no `delete this._inputNodes` or `this._inputNodes = []` before a new model). On reload/model switch, stale `view.Input` objects from the previous model remain in `_inputNodes`, and their `.element` is detached. Their `.x`/`.y` values from the old layout are used, pointing to wrong coordinates in the new graph's coordinate space.

#### Path 3 — `applyZoomFit()` RAF in view.js ~line 956
Last resort, up to 3 animation frame retries. Same `_inputNodes` stale data problem. Also: this path calls `target._updateZoom(zoom)` first, which triggers a CSS `transform` and may cause the container's `scrollLeft`/`scrollTop` to reset to 0, invalidating any earlier scroll position.

**Primary cause of Bug A:**
`_inputNodes` accumulates stale nodes across renders. The fix is to reset `_inputNodes` to `[]` at the start of each graph build, before `createInput()` is called.

**Secondary cause of Bug A:**
The deferred `_needsZoomFit` path (RAF, 3 retries) calls `_updateZoom` which can reset scroll, then immediately tries `_scrollToGraphBounds` — but `_updateZoom` applies a CSS `scale` transform that invalidates layout geometry synchronously, and the `scrollTo` may land in the wrong place. The retry should re-read input node positions from the live DOM after the zoom is applied.

---

### Bug B — Missing edge connectors on Snapdragon ARM

The rendering pipeline for edges with viewport culling is:

1. `updateViewportVisibility()` → computes `addedEdges` delta
2. `updateVisibleElements()` → calls `_buildVisibleNodes(newNodeIds)` then `_buildVisibleEdges(addedEdges)`
3. `_buildVisibleNodes` processes nodes in **async chunks** via `requestIdleCallback(..., { timeout: 300 })`
4. After each chunk, adjacent edges are re-updated to use real node sizes

**The race on ARM:**

On Snapdragon's heterogeneous cores (efficiency + performance), `requestIdleCallback` fires on efficiency cores with very short idle windows. The 300ms timeout guarantees eventual execution but does NOT guarantee that all node chunks finish before `_buildVisibleEdges` runs.

`_buildVisibleEdges` is called with all `addedEdges` immediately after `_buildVisibleNodes` is invoked — not after it completes. If an edge's endpoint node hasn't been built yet (its DOM element is `null`), `edge.label.update()` calls `intersectRect()` on a null element, returns a zero-length or undefined path, and the SVG `<path d="">` is left empty. The edge becomes invisible.

The specific ARM timing issue: on x86 desktop the idle chunks complete fast enough that by the time the first `_buildVisibleEdges` call executes, nodes are usually already built. On Snapdragon the idle windows are shorter and more fragmented, so there is a much larger window where `_buildVisibleEdges` runs before all adjacent nodes have DOM elements.

**Confirming evidence in the code:**
- `grapher.js line 345–363`: "Re-update edges connected to newly built nodes so that intersectRect uses the actual node sizes." This shows the dev was aware of the race but placed the fix INSIDE the node-build chunk, not gating edge visibility.
- `grapher.js line 533–536`: When a node enters the viewport and has a simplified placeholder, it's shown immediately "so that any already-visible edge connecting to this node has a DOM target." This is a partial fix that only applies to simplified placeholders.

---

## Proposed Approach

### Fix A1 — Clear `_inputNodes` before each graph build

In `view.js`, in the graph context factory (the `Builder` or equivalent) where `createInput()` is called, reset `_inputNodes` before the build loop so stale objects from previous renders don't accumulate.

### Fix A2 — Guard input node positions against stale objects

In all three scroll-to-input-nodes code blocks (`restore()`, `register()`, `applyZoomFit()`), add a check that the `view.Input` object's `element` is actually attached to the current document before using its `.x`/`.y` coordinates.

### Fix A3 — Post-zoom scroll stabilization

In `applyZoomFit` RAF, after `_updateZoom()`, defer the `_scrollToGraphBounds` call to the next frame (`requestAnimationFrame`) so the CSS transform has flushed before `scrollTo` is issued. This prevents the zoom-then-scroll race.

### Fix B1 — Gate `_buildVisibleEdges` behind node build completion

Change `_buildVisibleEdges` so edges whose endpoint nodes are not yet built are queued and retried after those nodes finish building. Specifically:
- In `_buildVisibleEdges` (and the delta path in `updateVisibleElements`), for each edge, check if its endpoint nodes (`v` and `w`) have built DOM elements. If either is unbuilt, defer that edge into a pending list.
- At the end of each `_buildVisibleNodes` chunk (after the edge-re-update pass at line 345), process any edges in the pending list whose endpoints are now built.

### Fix B2 — Increase `requestIdleCallback` timeout on ARM

Detect ARM/low-power environments and increase the idle callback timeout from 300ms to 600ms, or unconditionally bump it to 500ms (safe on all platforms since it's an upper bound, not a minimum wait).

### Fix B3 — Re-register edges that were skipped during initial viewport scan

After the initial `setTimeout(() => _onViewportChange(...), 100)` fires and all visible nodes finish building, do a single pass over all visible edges and call `update()` on any whose path is empty (`d=""` or `d` attribute missing). This is a safety net.

---

## Step-by-Step Plan

### Step 1 — Diagnose `_inputNodes` stale accumulation

**File:** `source/view.js`  
**Search:** `this._inputNodes = this._inputNodes || []`  
Verify there is no reset before this. Find the function that triggers graph build (likely `render()` or a graph context init method).  
**Action:** Before the graph is built (before the first `createInput()` can be called), add:
```js
this._inputNodes = [];
```

### Step 2 — Guard stale input node coordinates

**File:** `source/view.js`  
In all three scroll-to-input-nodes blocks (lines ~988, ~2665, ~2705), add an element-attached guard inside the loop:
```js
for (const node of inputNodes) {
    if (!node.element || !node.element.isConnected) continue; // guard: skip stale nodes
    if (typeof node.x === 'number' && typeof node.y === 'number') {
        // ... bounds calculation
    }
}
```

### Step 3 — Stabilize zoom-then-scroll in `applyZoomFit`

**File:** `source/view.js` ~line 968  
After `target._updateZoom(zoom)`, wrap the scroll logic in an additional `requestAnimationFrame`:
```js
target._updateZoom(zoom);
requestAnimationFrame(() => {
    // existing scroll-to-input-nodes logic here
});
return;
```

### Step 4 — Pending-edge queue in `_buildVisibleNodes`

**File:** `source/grapher.js`  
Add a `this._pendingEdgeUpdates = new Set()` field. In `_buildVisibleEdges`, before calling `_ensureEdgeElementBuildOnly`, check:
```js
const vEntry = this._nodes.get(edgeEntry.v);
const wEntry = this._nodes.get(edgeEntry.w);
if ((vEntry && !vEntry.label.element) || (wEntry && !wEntry.label.element)) {
    this._pendingEdgeUpdates.add(edgeKey);
    continue;
}
```
Then in `_buildVisibleNodes`, at the end of each chunk's Pass 3, after the adjacency edge re-update loop, drain `_pendingEdgeUpdates` for any edge whose both endpoints are now built:
```js
for (const edgeKey of this._pendingEdgeUpdates) {
    const edgeEntry = this._edges.get(edgeKey);
    if (!edgeEntry) { this._pendingEdgeUpdates.delete(edgeKey); continue; }
    const vEntry = this._nodes.get(edgeEntry.v);
    const wEntry = this._nodes.get(edgeEntry.w);
    if (vEntry && vEntry.label.element && wEntry && wEntry.label.element) {
        this._buildVisibleEdges([edgeKey], document);
        this._pendingEdgeUpdates.delete(edgeKey);
    }
}
```

### Step 5 — Increase idle callback timeout

**File:** `source/grapher.js`  
Change:
```js
requestIdleCallback(() => process(ids), { timeout: 300 });
```
To:
```js
requestIdleCallback(() => process(ids), { timeout: 500 });
```
Both in `_buildVisibleNodes` and `_buildVisibleEdges`.

### Step 6 — Safety net: re-scan visible edges after initial viewport build

**File:** `source/view.js`  
In the `setTimeout(() => { _onViewportChange(...); }, 100)` block (line ~2787), after the viewport change fires, schedule a second pass after the first idle period to find edges with no path and re-trigger their build:
```js
setTimeout(() => {
    const viewport = this._getViewportBounds();
    this._onViewportChange(viewport);
    // Safety net: after initial build, re-trigger any edge whose path is empty.
    requestIdleCallback(() => {
        if (this._graph) {
            this._graph._retryEmptyEdges(document);
        }
    }, { timeout: 600 });
}, 100);
```
Add `_retryEmptyEdges(document)` to `grapher.Graph`:
```js
_retryEmptyEdges(document) {
    if (!this._visibleEdges) return;
    for (const edgeKey of this._visibleEdges) {
        const edgeEntry = this._edges.get(edgeKey);
        if (!edgeEntry || !edgeEntry.label.element) continue;
        const pathEl = edgeEntry.label.element.querySelector('path');
        if (pathEl && (!pathEl.getAttribute('d') || pathEl.getAttribute('d') === '')) {
            edgeEntry.label.update();
        }
    }
}
```

---

## Files Likely to Change

| File | Changes |
|------|---------|
| `source/view.js` | Reset `_inputNodes=[]` before graph build; add `isConnected` guards in 3 scroll blocks; wrap scroll after zoom in extra rAF; add safety-net edge re-scan after initial viewport |
| `source/grapher.js` | Add `_pendingEdgeUpdates` Set; drain pending edges at end of each `_buildVisibleNodes` chunk; bump idle timeout 300→500ms in both build methods; add `_retryEmptyEdges()` method |

---

## Tests / Validation

1. **Bug A regression test:** Open a large ONNX model (e.g., GPT-2, ResNet) in the Electron app. On first open, the view should scroll to and center the input node(s), not the graph center.
2. **Bug A reload test:** Close model, re-open same model. Scroll position should still be at input nodes.
3. **Bug B regression test:** Open a large model on Windows ARM (Snapdragon). After load, all edges visible in the viewport must be rendered with visible paths. Scroll around — no edges should appear/disappear with connectors missing.
4. **Bug B stress test:** Open a model with >1000 nodes on a low-power machine (or throttle CPU via DevTools). Verify no edges are left with empty paths after the graph settles.
5. **Existing behavior:** Opening a small model (<500 nodes, no viewport culling) should behave identically to before.

---

## Risks & Tradeoffs

| Risk | Mitigation |
|------|-----------|
| Adding `_pendingEdgeUpdates` draining inside `_buildVisibleNodes` may slightly increase chunk processing time | Drain is O(pending edges) which is bounded by visible edges — acceptable overhead |
| Extra rAF in `applyZoomFit` adds ~16ms latency to zoom-then-scroll on fresh load | Negligible; the current behavior is already deferred by RAF anyway |
| `isConnected` check may be costly on Firefox versions < 51 | `isConnected` has universal browser support; not a concern for Electron |
| `_retryEmptyEdges` safety net fires even when no edges are broken | Guard on empty `d` attribute keeps it a no-op when everything rendered correctly |

---

## Open Questions

1. Does `view.Input` / `view.Node` expose a reliable way to tell if the object belongs to the current render cycle other than `element.isConnected`? Using a render-cycle ID (e.g., a monotonically incrementing `_renderVersion` on the graph context) would be more robust than DOM attachment checks.
2. Is viewport culling always enabled for the standalone Electron app, or is it gated on node count? (From code: `useEstimatedNodeSizes()` returns true when >500 nodes and both `_viewportCulling` and `_deferredNodeBuild` are true.) Bug A may only manifest on large models.
3. Is there a test model on Snapdragon that reliably reproduces Bug B? If so, it should be added to the test suite with a headless Playwright test.
