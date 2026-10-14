
// -------------------------------------------------------------------------
// Force-directed layout with AABB collision detection.
//
// Activated by setting  graph.options.layout = 'force'  before calling
// graph.layout().  Produces a clean, non-overlapping arrangement for any
// graph topology using a spring-repulsion model:
//
//   • Coulomb repulsion  — every pair of nodes pushes apart (O(n²))
//   • Hooke spring       — edges pull their endpoints toward an ideal length
//   • Centroid gravity   — weak pull toward the centre of mass prevents drift
//   • AABB collision     — per-step bounding-box separation with padding
//   • Final clean pass   — guaranteed no-overlap after the simulation ends
//
// Node dimensions come from the already-measured node.width / node.height
// values, so the layout is always based on the true rendered sizes.
// -------------------------------------------------------------------------
const steps = function* (nodes, edges) {
    let lastYield = performance.now();
    const NODE_PADDING  = 20;   // minimum gap between node bounding boxes (px)
    const ITERATIONS    = 400;  // simulation steps
    const INITIAL_TEMP  = 200;  // initial max displacement per step (px)
    const COOLING       = 0.972; // temperature multiplier per iteration
    const REPULSION     = 10000; // Coulomb constant
    const SPRING_K      = 0.06; // Hooke spring stiffness
    const GRAVITY       = 0.03; // centroid gravity strength
    const COL_PASSES    = 4;    // AABB resolution passes per step

    // Build a fast lookup map.
    const nodeMap = new Map();
    for (const node of nodes) {
        nodeMap.set(node.v, node);
    }

    // Initialise positions in a regular grid to avoid a degenerate start
    // state where all nodes are at the origin (zero repulsion gradient).
    const cols  = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    const avgW  = nodes.length > 0
        ? nodes.reduce((s, n) => s + (n.width  || 100), 0) / nodes.length : 100;
    const avgH  = nodes.length > 0
        ? nodes.reduce((s, n) => s + (n.height ||  40), 0) / nodes.length :  40;
    const cellW = avgW + NODE_PADDING * 3;
    const cellH = avgH + NODE_PADDING * 3;
    nodes.forEach((node, i) => {
        node.x  = (i % cols) * cellW + cellW / 2;
        node.y  = Math.floor(i / cols) * cellH + cellH / 2;
        node.fx = 0;
        node.fy = 0;
    });

    // Pre-compute ideal edge rest lengths from actual node dimensions so
    // that connected nodes are pulled to a distance that leaves clear space
    // between their bounding boxes.
    const edgeRestLen = new Map();
    for (const edge of edges) {
        const a = nodeMap.get(edge.v);
        const b = nodeMap.get(edge.w);
        if (!a || !b) {
            continue;
        }
        const aw = (a.width  || 100) / 2;
        const bw = (b.width  || 100) / 2;
        const ah = (a.height ||  40) / 2;
        const bh = (b.height ||  40) / 2;
        edgeRestLen.set(`${edge.v}:${edge.w}`,
            Math.sqrt((aw + bw) ** 2 + (ah + bh) ** 2) + NODE_PADDING * 4);
    }

    let temp = INITIAL_TEMP;

    for (let iter = 0; iter < ITERATIONS; iter++) {

        // --- Reset per-step forces ---
        for (const node of nodes) {
            node.fx = 0; node.fy = 0;
        }

        // --- Coulomb repulsion between every pair of nodes ---
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a  = nodes[i];
                const b  = nodes[j];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const d2 = dx * dx + dy * dy || 1;
                const d  = Math.sqrt(d2);
                const f  = REPULSION / d2;
                const fx = (dx / d) * f;
                const fy = (dy / d) * f;
                a.fx -= fx;  a.fy -= fy;
                b.fx += fx;  b.fy += fy;
            }
            // Bound cooperative fallback work between timer yields.
            if ((i & 31) === 31 && performance.now() - lastYield >= 8) {
                yield;
                lastYield = performance.now();
            }
        }

        // --- Hooke spring attraction along edges ---
        for (const edge of edges) {
            const a = nodeMap.get(edge.v);
            const b = nodeMap.get(edge.w);
            if (!a || !b) {
                continue;
            }
            const dx   = b.x - a.x;
            const dy   = b.y - a.y;
            const d    = Math.sqrt(dx * dx + dy * dy) || 1;
            const rest = edgeRestLen.get(`${edge.v}:${edge.w}`) || NODE_PADDING * 6;
            const f    = SPRING_K * (d - rest);
            const fx   = (dx / d) * f;
            const fy   = (dy / d) * f;
            a.fx += fx;  a.fy += fy;
            b.fx -= fx;  b.fy -= fy;
        }

        // --- Weak gravity toward centroid to prevent unbounded drift ---
        let cx = 0;
        let cy = 0;
        for (const node of nodes) {
            cx += node.x; cy += node.y;
        }
        cx /= nodes.length || 1;
        cy /= nodes.length || 1;
        for (const node of nodes) {
            node.fx -= GRAVITY * (node.x - cx);
            node.fy -= GRAVITY * (node.y - cy);
        }

        // --- Apply forces, clamped to current temperature ---
        for (const node of nodes) {
            const mag  = Math.sqrt(node.fx * node.fx + node.fy * node.fy) || 1;
            const step = Math.min(mag, temp);
            node.x += (node.fx / mag) * step;
            node.y += (node.fy / mag) * step;
        }

        // --- AABB collision resolution (multiple passes per step) ---
        for (let pass = 0; pass < COL_PASSES; pass++) {
            for (let i = 0; i < nodes.length; i++) {
                for (let j = i + 1; j < nodes.length; j++) {
                    const a  = nodes[i];
                    const b  = nodes[j];
                    const aw = (a.width  || 100) / 2 + NODE_PADDING / 2;
                    const ah = (a.height ||  40) / 2 + NODE_PADDING / 2;
                    const bw = (b.width  || 100) / 2 + NODE_PADDING / 2;
                    const bh = (b.height ||  40) / 2 + NODE_PADDING / 2;
                    const dx = b.x - a.x;
                    const dy = b.y - a.y;
                    const ox = (aw + bw) - Math.abs(dx);
                    const oy = (ah + bh) - Math.abs(dy);
                    if (ox > 0 && oy > 0) {
                        if (ox < oy) {
                            const push = ox / 2 + 0.5;
                            if (dx >= 0) {
                                a.x -= push; b.x += push;
                            } else         {
                                a.x += push; b.x -= push;
                            }
                        } else {
                            const push = oy / 2 + 0.5;
                            if (dy >= 0) {
                                a.y -= push; b.y += push;
                            } else         {
                                a.y += push; b.y -= push;
                            }
                        }
                    }
                }
                // Bound cooperative fallback work between timer yields.
                if ((i & 31) === 31 && performance.now() - lastYield >= 8) {
                    yield;
                    lastYield = performance.now();
                }
            }
        }

        temp *= COOLING;
    }

    // --- Final guaranteed no-overlap pass ---
    // Runs iteratively until the layout is clean or the safety limit is hit.
    let dirty = true;
    for (let guard = 0; dirty && guard < 100; guard++) {
        dirty = false;
        for (let i = 0; i < nodes.length; i++) {
            for (let j = i + 1; j < nodes.length; j++) {
                const a  = nodes[i];
                const b  = nodes[j];
                const aw = (a.width  || 100) / 2 + NODE_PADDING;
                const ah = (a.height ||  40) / 2 + NODE_PADDING;
                const bw = (b.width  || 100) / 2 + NODE_PADDING;
                const bh = (b.height ||  40) / 2 + NODE_PADDING;
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const ox = (aw + bw) - Math.abs(dx);
                const oy = (ah + bh) - Math.abs(dy);
                if (ox > 0 && oy > 0) {
                    dirty = true;
                    if (ox < oy) {
                        const push = ox / 2 + 1;
                        if (dx >= 0) {
                            a.x -= push; b.x += push;
                        } else         {
                            a.x += push; b.x -= push;
                        }
                    } else {
                        const push = oy / 2 + 1;
                        if (dy >= 0) {
                            a.y -= push; b.y += push;
                        } else         {
                            a.y += push; b.y -= push;
                        }
                    }
                }
            }
            // Bound cooperative fallback work between timer yields.
            if ((i & 31) === 31 && performance.now() - lastYield >= 8) {
                yield;
                lastYield = performance.now();
            }
        }
    }

    // --- Translate so the layout starts at a consistent margin ---
    const margin = NODE_PADDING * 2;
    const minX = nodes.reduce((m, n) => Math.min(m, n.x - (n.width  || 100) / 2), Infinity);
    const minY = nodes.reduce((m, n) => Math.min(m, n.y - (n.height ||  40) / 2), Infinity);
    for (const node of nodes) {
        node.x += margin - minX;
        node.y += margin - minY;
    }

    // --- Build per-node edge index for parallel edge fan-out ---
    const forceOutEdges = new Map();
    for (const edge of edges) {
        if (!nodeMap.has(edge.v) || !nodeMap.has(edge.w)) {
            continue;
        }
        if (!forceOutEdges.has(edge.v)) {
            forceOutEdges.set(edge.v, []);
        }
        forceOutEdges.get(edge.v).push(edge);
    }
    const forcePairIndex = new Map();
    for (const edgeList of forceOutEdges.values()) {
        const byTarget = new Map();
        for (const edge of edgeList) {
            if (!byTarget.has(edge.w)) {
                byTarget.set(edge.w, []);
            }
            byTarget.get(edge.w).push(edge);
        }
        for (const [, group] of byTarget) {
            for (let i = 0; i < group.length; i++) {
                forcePairIndex.set(`${group[i].v}\x00${group[i].w}`, { index: i, total: group.length });
            }
        }
    }

    // --- Generate edge waypoints ---
    // Clean 3-point route: source → midpoint → target.
    // Parallel edges get a subtle lateral offset (3px) to prevent overlap.
    for (const edge of edges) {
        const src = nodeMap.get(edge.v);
        const tgt = nodeMap.get(edge.w);
        if (!src || !tgt) {
            edge.points = []; continue;
        }
        const mx = (src.x + tgt.x) / 2;
        const my = (src.y + tgt.y) / 2;
        const pairInfo = forcePairIndex.get(`${edge.v}\x00${edge.w}`);
        if (pairInfo && pairInfo.total > 1) {
            const dx = tgt.x - src.x;
            const dy = tgt.y - src.y;
            const len = Math.sqrt(dx * dx + dy * dy) || 1;
            const px = -dy / len;
            const py = dx / len;
            const off = (pairInfo.index - (pairInfo.total - 1) / 2) * 3;
            edge.points = [
                { x: src.x, y: src.y },
                { x: mx + px * off, y: my + py * off },
                { x: tgt.x, y: tgt.y }
            ];
        } else {
            edge.points = [
                { x: src.x, y: src.y },
                { x: mx, y: my },
                { x: tgt.x, y: tgt.y }
            ];
        }
        if (edge.width || edge.height) {
            edge.x = edge.points[1].x;
            edge.y = edge.points[1].y;
        }
    }
};

export const layout = (nodes, edges) => {
    const iterator = steps(nodes, edges);
    while (!iterator.next().done) {
        // Worker computation proceeds without yielding to its event loop.
    }
};

export const layoutAsync = async (nodes, edges) => {
    const iterator = steps(nodes, edges);
    while (!iterator.next().done) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }
};
