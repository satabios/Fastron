import { dimensions, patternAttributes, patternSignature } from './pattern-signature.js';
import { ModuleBlocks } from './module-blocks.js';
import { nodeDescriptions } from './repeated-blocks.js';

const values = (args) => (args || []).flatMap((arg) => arg.value || []);
const nested = (node) => node._hasSubgraphs || node.type?.nodes || node.chain?.length || node.blocks?.length || node.nodes?.length || node.inner || node.controlDependencies?.length;

class PatternBlocks extends ModuleBlocks {
    subgraph(indices, name, scope) {
        const graph = super.subgraph(indices, name, scope);
        graph._patternRegion = true;
        return graph;
    }
}

// Bounded contiguous motifs preserve source order and every external port; they do not assert equal weights.
export const patternBlocks = async (graph, current = () => true, excluded = []) => {
    if (!current()) {
        return null;
    }
    const nodes = [];
    const producers = new Map();
    const consumers = new Map();
    let deadline = Date.now() + 8;
    const yieldWork = async () => {
        if (Date.now() >= deadline) {
            deadline = Date.now() + 8;
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });
        }
        return current();
    };
    for (const node of nodeDescriptions(graph)) {
        const index = nodes.length;
        for (const value of values(node.outputs)) {
            if (value?.name) {
                if (producers.has(value.name)) {
                    return null;
                }
                producers.set(value.name, index);
            }
        }
        nodes.push(node);
        // eslint-disable-next-line no-await-in-loop
        if (index % 256 === 0 && !await yieldWork()) {
            return null;
        }
    }
    for (let i = 0; i < nodes.length; i++) {
        for (const value of values(nodes[i].inputs).filter((item) => item?.name && !item.initializer)) {
            if (producers.has(value.name) && producers.get(value.name) >= i) {
                return null;
            }
            if (!consumers.has(value.name)) {
                consumers.set(value.name, []);
            }
            consumers.get(value.name).push(i);
        }
    }
    for (const value of values(graph.outputs)) {
        if (!consumers.has(value.name)) {
            consumers.set(value.name, []);
        }
        consumers.get(value.name).push(-1);
    }
    const attributes = new Map();
    const attrs = (i) => {
        if (!attributes.has(i)) {
            attributes.set(i, patternAttributes(nodes[i], true));
        }
        return attributes.get(i);
    };
    // Anonymous axes describe unresolved metadata, never an inferred equality between tensors.
    const signature = (start, end) => patternSignature(nodes, start, end, attrs, true);
    const valid = new Uint8Array(nodes.length);
    const protectedNodes = new Uint8Array(nodes.length);
    for (const group of excluded) {
        protectedNodes.fill(1, group.anchor, group.members.at(-1) + 1);
    }
    const tokens = new Map();
    const intern = (key) => {
        if (!tokens.has(key)) {
            tokens.set(key, tokens.size);
        }
        return tokens.get(key);
    };
    const single = [];
    for (let i = 0; i < nodes.length; i++) {
        if (!protectedNodes[i] && !nested(nodes[i]) && values(nodes[i].outputs).length &&
            [...values(nodes[i].inputs), ...values(nodes[i].outputs)].every((value) => value.initializer || value.name)) {
            try {
                single[i] = intern(signature(i, i));
                valid[i] = 1;
            } catch {
                // Unsupported attributes or unknown tensor metadata form a boundary.
            }
        }
        // eslint-disable-next-line no-await-in-loop
        if (i % 128 === 0 && !await yieldWork()) {
            return null;
        }
    }
    const connected = (start, end) => {
        const seen = new Set([start]);
        const pending = [start];
        while (pending.length) {
            const i = pending.pop();
            const adjacent = [...values(nodes[i].inputs).filter((value) => !value.initializer).map((value) => producers.get(value.name)),
                ...values(nodes[i].outputs).flatMap((value) => consumers.get(value.name) || [])];
            for (const j of adjacent) {
                if (j >= start && j <= end && !seen.has(j)) {
                    seen.add(j);
                    pending.push(j);
                }
            }
        }
        return seen.size === end - start + 1;
    };
    const linked = (a, b, c) => {
        for (let i = b; i <= c; i++) {
            if (values(nodes[i].inputs).some((value) => !value.initializer && producers.get(value.name) >= a && producers.get(value.name) < b)) {
                return true;
            }
        }
        return false;
    };
    const groups = [];
    const covered = new Uint8Array(nodes.length);
    const group = (start, period, repeats) => {
        const end = start + period * repeats - 1;
        const title = repeats > 1 ? 'Repeated pattern' : 'Operation group';
        const blocks = Array.from({ length: repeats }, (_, n) => ({ index: n, scope: '',
            components: [...new Set(nodes.slice(start + n * period, start + (n + 1) * period).map((node) => node.type.name))],
            indices: Uint32Array.from({ length: period }, (_, offset) => start + n * period + offset) }));
        groups.push({ title, kind: 'pattern', unit: 'instance', label: title, scope: `${title} ${groups.length + 1}`, anchor: start,
            members: Uint32Array.from({ length: end - start + 1 }, (_, offset) => start + offset), blocks });
        covered.fill(1, start, end + 1);
    };
    const flags = new Uint8Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
        const users = new Set(values(nodes[i].outputs).flatMap((value) => consumers.get(value.name) || []).filter((index) => index >= 0));
        const entry = values(nodes[i].inputs).some((value) => !value.initializer &&
            (!producers.has(value.name) || new Set((consumers.get(value.name) || []).filter((index) => index >= 0)).size > 1)) ? 1 : 0;
        flags[i] = valid[i] | (entry << 1) | (users.size > 1 ? 4 : 0);
    }
    let accelerator = null;
    if (nodes.length >= 512) {
        try {
            const { patternIndex } = await import('./pattern-index.mjs');
            accelerator = await patternIndex(single, flags);
        } catch {
            // Browsers without WASM access retain the exact JavaScript search.
        }
    }
    let prefix = null;
    let power = null;
    let missing = null;
    let forks = null;
    if (!accelerator) {
        prefix = new Uint32Array(nodes.length + 1);
        power = new Uint32Array(nodes.length + 1);
        missing = new Uint32Array(nodes.length + 1);
        forks = new Uint32Array(nodes.length + 1);
        power[0] = 1;
        for (let i = 0; i < nodes.length; i++) {
            prefix[i + 1] = (Math.imul(prefix[i], 16777619) + (single[i] ?? 0) + 1) >>> 0;
            power[i + 1] = Math.imul(power[i], 16777619) >>> 0;
            missing[i + 1] = missing[i] + (valid[i] ? 0 : 1);
            forks[i + 1] = forks[i] + ((flags[i] & 4) ? 1 : 0);
        }
    }
    // Hashes reject candidates cheaply; full signatures and wiring always verify a match.
    const hash = (start, count) => (prefix[start + count] - Math.imul(prefix[start], power[count])) >>> 0;
    const candidates = (start) => {
        if (accelerator) {
            return accelerator.candidates(start);
        }
        const result = [];
        for (let period = 1; period <= 1024 && start + 2 * period <= nodes.length; period++) {
            if (missing[start + period] !== missing[start]) {
                break;
            }
            if (single[start + period] !== single[start] || (period > 1 && !(flags[start] & 2) && forks[start + period] !== forks[start])) {
                continue;
            }
            const token = hash(start, period);
            let repeats = 1;
            while (start + (repeats + 1) * period <= nodes.length &&
                missing[start + (repeats + 1) * period] === missing[start + repeats * period] &&
                hash(start + repeats * period, period) === token) {
                repeats++;
            }
            if (repeats > 1) {
                result.push(period, repeats);
            }
        }
        return result;
    };
    try {
        if (!current()) {
            return null;
        }
        for (let start = 0; start < nodes.length;) {
            let best = null;
            if (valid[start]) {
                // shortcut: bound each motif to 1,024 operators; larger motifs need a hierarchical index.
                const options = candidates(start);
                for (let at = 0; at < options.length; at += 2) {
                    const period = options[at];
                    const repeats = options[at + 1];
                    if (repeats < 2 || (best && period * repeats - 1 <= best.saved) || !connected(start, start + period - 1)) {
                        continue;
                    }
                    const key = signature(start, start + period - 1);
                    let verified = 1;
                    let connection = null;
                    for (; verified < repeats; verified++) {
                        const at = start + verified * period;
                        if (!linked(at - period, at, at + period - 1) || signature(at, at + period - 1) !== key) {
                            break;
                        }
                        const pair = signature(at - period, at + period - 1);
                        if (connection !== null && pair !== connection) {
                            break;
                        }
                        connection = pair;
                        // eslint-disable-next-line no-await-in-loop
                        if (verified % 128 === 0 && !await yieldWork()) {
                            return null;
                        }
                    }
                    const saved = period * verified - 1;
                    if (verified > 1 && (!best || saved > best.saved)) {
                        best = { period, repeats: verified, saved };
                        if (start + period * verified === nodes.length) {
                            break;
                        }
                    }
                    // eslint-disable-next-line no-await-in-loop
                    if (!await yieldWork()) {
                        return null;
                    }
                }
            }
            if (best) {
                group(start, best.period, best.repeats);
                start += best.period * best.repeats;
            } else {
                start++;
            }
            // eslint-disable-next-line no-await-in-loop
            if (start % 64 === 0 && !await yieldWork()) {
                return null;
            }
        }
    } finally {
        accelerator?.dispose();
    }
    const ancestors = (value, floor, stop = null) => {
        const seen = new Map();
        const pending = [value];
        while (pending.length) {
            const item = pending.pop();
            if (!item?.name || item.initializer || seen.has(item.name)) {
                continue;
            }
            const index = producers.get(item.name) ?? -1;
            seen.set(item.name, index);
            if (index >= floor && valid[index] && !covered[index] && item.name !== stop) {
                pending.push(...values(nodes[index].inputs));
            }
        }
        return seen;
    };
    const regions = [];
    for (let end = 0; end < nodes.length; end++) {
        const node = nodes[end];
        const inputs = values(node.inputs).filter((value) => !value.initializer);
        const output = values(node.outputs)[0];
        if (valid[end] && !covered[end] && inputs.length >= 2 && new Set(inputs.map((value) => value.name)).size === inputs.length) {
            // shortcut: limit branch ancestry to 1,024 operators; larger/noncontiguous regions stay visible.
            const floor = Math.max(0, end - 1023);
            const ancestry = inputs.map((input) => ancestors(input, floor));
            const common = [...ancestry[0]].filter(([name]) => ancestry.every((items) => items.has(name)))
                .sort((a, b) => b[1] - a[1])[0];
            if (common && common[1] >= floor - 1) {
                const members = new Set([end]);
                for (const input of inputs) {
                    for (const [name, index] of ancestors(input, Math.max(floor, common[1] + 1), common[0])) {
                        if (name !== common[0] && index > common[1]) {
                            members.add(index);
                        }
                    }
                }
                const start = Math.min(...members);
                if (members.size === end - start + 1 && members.size >= 2 && [...members].every((i) => valid[i] && !covered[i])) {
                    const users = consumers.get(output.name) || [];
                    const next = nodes[end + 1];
                    const dims = dimensions(output, true);
                    const following = values(next?.outputs);
                    const tail = users.length === 1 && users[0] === end + 1 && valid[end + 1] && !covered[end + 1] &&
                        values(next.inputs).length === 1 && following.length === 1 && dims &&
                        following[0].type?.dataType === output.type?.dataType &&
                        dimensions(following[0], true)?.length === dims.length &&
                        dimensions(following[0], true).every((dim, i) => dim === dims[i]);
                    const last = tail ? end + 1 : end;
                    if (last - start < 1024 && (!graph._patternRegion || start !== 0 || last !== nodes.length - 1)) {
                        regions.push({ start, end: last });
                    }
                }
            }
        }
        // eslint-disable-next-line no-await-in-loop
        if (end % 64 === 0 && !await yieldWork()) {
            return null;
        }
    }
    for (const region of regions.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start)) {
        if (!covered.subarray(region.start, region.end + 1).some(Boolean)) {
            group(region.start, region.end - region.start + 1, 1);
        }
    }
    if (!groups.length || !current()) {
        return null;
    }
    const ordered = groups.sort((a, b) => a.anchor - b.anchor).map((item, id) => ({ ...item, id }));
    return new PatternBlocks(graph, ordered, producers, consumers);
};
