import fs from 'node:fs';
import path from 'node:path';

const folder = path.resolve(process.argv[2] || 'dist/profile-orion');
const median = (values) => {
    const sorted = values.toSorted((a, b) => a - b);
    const index = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[index] : (sorted[index - 1] + sorted[index]) / 2;
};
for (const run of fs.readdirSync(folder)) {
    const directory = path.join(folder, run);
    if (!fs.statSync(directory).isDirectory() || !fs.existsSync(path.join(directory, 'report.json'))) {
        continue;
    }
    const summary = { run, report: JSON.parse(fs.readFileSync(path.join(directory, 'report.json'))) };
    const ioFile = fs.readdirSync(directory).find((file) => file.endsWith('-io.json'));
    if (ioFile) {
        const io = JSON.parse(fs.readFileSync(path.join(directory, ioFile)));
        const reads = io.reads;
        const sizes = {};
        for (const read of reads) {
            sizes[read.requested] ||= { calls: 0, milliseconds: 0 };
            const entry = sizes[read.requested];
            entry.calls++;
            entry.milliseconds += read.milliseconds;
        }
        summary.io = { operations: io.operations, sizes,
            medianReadMs: reads.length ? median(reads.map((read) => read.milliseconds)) : 0,
            slowestReads: reads.toSorted((a, b) => b.milliseconds - a.milliseconds).slice(0, 10) };
    }
    summary.sampledStacks = {};
    for (const file of fs.readdirSync(directory).filter((file) => file.endsWith('.cpuprofile'))) {
        const profile = JSON.parse(fs.readFileSync(path.join(directory, file)));
        const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
        const costs = new Map();
        for (let index = 0; index < (profile.samples || []).length; index++) {
            const node = nodes.get(profile.samples[index]);
            const frame = node.callFrame;
            const key = `${frame.functionName || '(anonymous)'} ${frame.url}:${frame.lineNumber + 1}`;
            costs.set(key, (costs.get(key) || 0) + (profile.timeDeltas?.[index] || 0) / 1000);
        }
        summary.sampledStacks[file] = Array.from(costs, ([frame, sampledMs]) => ({ frame, sampledMs }))
            .sort((a, b) => b.sampledMs - a.sampledMs).slice(0, 20);
    }
    summary.caveat = 'V8 sampled time includes native waits/idle; use filesystem timers to separate network wait, not sampled stacks alone.';
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}