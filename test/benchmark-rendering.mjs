import { TileManager } from '../source/grapher.js';
import { performance } from 'node:perf_hooks';

const tiles = Number(process.argv[2] || 300);
if (!Number.isSafeInteger(tiles) || tiles < 1 || tiles > 1000) {
    throw new Error('Choose a diagonal length of 1 to 1000 tiles.');
}
const manager = new TileManager(300);
const start = performance.now();
manager.addEdge('diagonal', [{ x: 10, y: 10 }, { x: tiles * 300 + 10, y: tiles * 300 + 10 }]);
const indexMs = performance.now() - start;
manager.queryViewport({ x: 0, y: 0, width: 100, height: 100 }, 0);
const queryStart = performance.now();
const visible = manager.queryViewport({ x: 10, y: tiles * 150, width: 100, height: 100 }, 0);
const queryMs = performance.now() - queryStart;
const overviewStart = performance.now();
for (let i = 0; i < 100; i++) {
    manager.queryViewport({ x: 0, y: 0, width: tiles * 300 + 100, height: tiles * 300 + 100 }, 0);
}
const overviewMsPerQuery = (performance.now() - overviewStart) / 100;
const short = new TileManager(300);
const shortStart = performance.now();
for (let i = 0; i < 10000; i++) {
    const x = (i % 10) * 300;
    const y = (Math.floor(i / 10) % 10) * 300;
    short.addEdge(`e${i}`, [{ x: x + 20, y: y + 20 }, { x: x + 60, y: y + 70 }, { x: x + 120, y: y + 110 }]);
}
const shortEdgesMs = performance.now() - shortStart;
process.stdout.write(`${JSON.stringify({ diagonalTiles: tiles, indexMs, queryMs, overviewMsPerQuery,
    shortEdgesMs, shortEdgeCount: 10000, indexedTiles: manager.getTileInfo().tileCount, irrelevantEdgesInViewport: visible.edges.size }, null, 2)}\n`);
