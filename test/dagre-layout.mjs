// Regression: dagre positions must match the golden checksums of the pre-fix layout.
import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { execFileSync } from 'child_process';
import { layout } from '../source/dagre.js';

const graph = (n) => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const nodes = Array.from({ length: n }, (_, i) => ({ v: `n${i}`, width: 150, height: 65, parent: undefined }));
    const edges = [];
    for (let k = 0; k < Math.floor(n * 1.5); k++) {
        const i = Math.floor(rnd() * (n - 1));
        const span = rnd() < 0.2 ? 1 + Math.floor(rnd() * Math.min(200, n - 1 - i)) : 1 + Math.floor(rnd() * 3);
        const j = Math.min(n - 1, i + span);
        if (i !== j) {
            edges.push({ v: `n${i}`, w: `n${j}`, minlen: 1, weight: 1, width: 0, height: 0, labeloffset: 10, labelpos: 'r' });
        }
    }
    return { nodes, edges, options: n > 3000 ? { ranker: 'longest-path' } : {} };
};

const checksum = (nodes) => {
    let h = 0;
    for (const n of nodes) {
        h = (Math.imul(h, 31) + Math.round(n.x * 1000) + Math.round(n.y * 1000)) | 0;
    }
    return h;
};

const golden = { 1000: -1266456784, 10000: -399528 };
let failed = false;
for (const [n, expected] of Object.entries(golden)) {
    const { nodes, edges, options } = graph(Number(n));
    layout(nodes, edges, { ranksep: 50, edgesep: 20, nodesep: 50, rankdir: 'tb', ...options }, {});
    const actual = checksum(nodes);
    const ok = actual === expected;
    failed ||= !ok;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} dagre layout N=${n} checksum=${actual} expected=${expected}\n`);
}
// Compound (parent/child) graphs: working tree must match HEAD exactly (findType2Conflicts removal must be a no-op here).
const compound = (groups, size) => {
    const nodes = [];
    const edges = [];
    const edge = (v, w) => ({ v, w, minlen: 1, weight: 1, width: 0, height: 0, labeloffset: 10, labelpos: 'r' });
    for (let g = 0; g < groups; g++) {
        nodes.push({ v: `g${g}`, width: 0, height: 0, parent: undefined });
    }
    for (let g = 0; g < groups; g++) {
        for (let i = 0; i < size; i++) {
            nodes.push({ v: `g${g}_${i}`, width: 150, height: 65, parent: `g${g}` });
        }
        for (let i = 0; i + 1 < size; i++) {
            edges.push(edge(`g${g}_${i}`, `g${g}_${i + 1}`));
        }
        if (g + 1 < groups) {
            edges.push(edge(`g${g}_${size - 1}`, `g${g + 1}_0`));
            edges.push(edge(`g${g}_0`, `g${g + 1}_${size - 1}`));
        }
    }
    return { nodes, edges };
};

const headPath = '/tmp/fastron-bench/dagre-head.mjs';
fs.mkdirSync(path.dirname(headPath), { recursive: true });
const repo = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
fs.writeFileSync(headPath, execFileSync('git', ['show', 'HEAD:source/dagre.js'], { cwd: repo, encoding: 'utf8' }));
const head = await import(url.pathToFileURL(headPath).href);
for (const [groups, size] of [[4, 6], [30, 8]]) {
    const run = (mod) => {
        const { nodes, edges } = compound(groups, size);
        mod.layout(nodes, edges, { ranksep: 50, edgesep: 20, nodesep: 50, rankdir: 'tb' }, {});
        return checksum(nodes);
    };
    const expected = run(head);
    const actual = run({ layout });
    const ok = actual === expected;
    failed ||= !ok;
    process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} compound groups=${groups} size=${size} head=${expected} worktree=${actual}\n`);
}
process.exitCode = failed ? 1 : 0;
