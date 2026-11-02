import { NodeCatalog, nodeCatalog, nodeDescriptions, overlay } from './repeated-blocks.js';
import { loadAnalysisModule } from './model-index.mjs';

const absent = 0xffffffff;
const utf8 = new TextEncoder();
const bodyTypes = new Set(['graph', 'graph[]', 'function', 'function[]']);
const outputs = (node) => node.chain?.at(-1)?.outputs?.length ? node.chain.at(-1).outputs : node.outputs || [];
const tensorHeader = (tensor) => tensor ? { type: tensor.type, category: tensor.category, encoding: tensor.encoding,
    layout: tensor.layout, quantization: tensor.quantization } : null;
const attributeValue = (arg) => {
    if (arg.tensorMetadata) {
        return arg.tensorMetadata;
    }
    if (arg.type === 'tensor') {
        return tensorHeader(arg.value);
    }
    if (arg.type === 'tensor[]') {
        return arg.value?.map(tensorHeader);
    }
    return arg.value;
};
const portMetadata = (args) => (args || []).filter((arg) => !bodyTypes.has(arg.type)).map((arg) => ({ name: arg.name, type: arg.type,
    values: Array.isArray(arg.value) ? arg.value.map((value) => ({ type: value?.type, quantization: value?.quantization,
        initializer: tensorHeader(value?.initializer) })) : arg.value }));
const typeKey = (node) => `${node.type?.module || node.type?.domain || ''}\0${node.type?.name || ''}\0${node.type?.overload || ''}`;
const nodeMetadata = (node) => ({ type: typeKey(node), version: node.type?.version,
    attributes: (node.attributes || []).filter((arg) => !bodyTypes.has(arg.type)).map((arg) => ({ name: arg.name, type: arg.type, value: attributeValue(arg) }))
        .sort((a, b) => String(a.name).localeCompare(String(b.name))),
    inputs: portMetadata(node.inputs), outputs: portMetadata(node.outputs),
    chain: (node.chain || []).map(nodeMetadata), inner: node.inner ? nodeMetadata(node.inner) : undefined });

class Writer {
    constructor() {
        this.data = new Uint8Array(4096); this.length = 0;
    }
    reserve(size) {
        if (this.length + size > 0x10000000) {
            throw new Error('Graph analysis metadata exceeds 256 MiB.');
        }
        if (this.length + size > this.data.length) {
            const data = new Uint8Array(Math.max(this.length + size, this.data.length * 2));
            data.set(this.data); this.data = data;
        }
    }
    u32(value) {
        this.reserve(4); new DataView(this.data.buffer).setUint32(this.length, value, true); this.length += 4;
    }
    bytes(value) {
        this.u32(value.length); this.reserve(value.length); this.data.set(value, this.length); this.length += value.length;
    }
    list(items, write) {
        this.u32(items.length); for (const item of items) {
            write(item);
        }
    }
    finish() {
        return this.data.slice(0, this.length);
    }
}

// A typed arena preserves cycles and binary attributes without ever visiting weight bodies.
class Metadata {
    constructor(identities) {
        this.identities = identities; this.strings = ['']; this.ids = new Map([['', 0]]); this.arena = []; this.seen = new WeakMap();
        this.scalars = new Map();
        this.tuples = new Map();
        this.structures = new Map();
        this.keys = new WeakMap();
    }
    string(value) {
        value = String(value ?? '');
        if (!this.ids.has(value)) {
            this.ids.set(value, this.strings.length); this.strings.push(value);
        }
        return this.ids.get(value);
    }
    tuple(items) {
        const key = items.join(',');
        if (!this.tuples.has(key)) {
            const index = this.arena.length;
            this.arena.push({ tag: 8, kind: this.string('analysis tuple'), identity: 0, atom: new Uint8Array(),
                props: items.map((value, index) => [this.string(index), value]) });
            this.tuples.set(key, index);
        }
        return this.tuples.get(key);
    }
    header(tensor) {
        return tensor ? this.tuple([tensor.type, tensor.category, tensor.encoding, tensor.layout, tensor.quantization].map((value) => this.value(value))) : this.value(null);
    }
    key(value) {
        if (value === null || !['object', 'function'].includes(typeof value)) {
            return this.value(value);
        }
        if (!this.keys.has(value)) {
            if (!this.identities.has(value)) {
                this.identities.set(value, this.identities.next++);
            }
            this.keys.set(value, this.arena.length);
            this.arena.push({ tag: 11, kind: 0, identity: this.identities.get(value), atom: new Uint8Array(), props: [] });
        }
        return this.keys.get(value);
    }
    value(value) {
        const object = value !== null && typeof value === 'object';
        if (object && this.seen.has(value)) {
            return this.seen.get(value);
        }
        const scalar = object ? null : `${typeof value}:${Object.is(value, -0) ? '-0' : String(value)}`;
        if (scalar !== null && this.scalars.has(scalar)) {
            return this.scalars.get(scalar);
        }
        const index = this.arena.length;
        const entry = { tag: 0, kind: 0, identity: 0, atom: new Uint8Array(), props: [] };
        this.arena.push(entry);
        if (scalar !== null) {
            this.scalars.set(scalar, index);
        }
        const bytes = (text) => utf8.encode(text);
        const number = (value) => {
            const data = new Uint8Array(8); new DataView(data.buffer).setFloat64(0, Number.isNaN(value) ? NaN : value, true); return data;
        };
        if (value === undefined) {
            return index;
        }
        if (value === null) {
            entry.tag = 1; return index;
        }
        if (typeof value === 'boolean') {
            entry.tag = 2; entry.atom = Uint8Array.of(Number(value)); return index;
        }
        if (typeof value === 'number') {
            entry.tag = 3; entry.atom = number(value); return index;
        }
        if (typeof value === 'string') {
            entry.tag = 4; entry.atom = new Uint8Array(value.length * 2);
            const view = new DataView(entry.atom.buffer);
            for (let at = 0; at < value.length; at++) {
                view.setUint16(at * 2, value.charCodeAt(at), true);
            }
            return index;
        }
        if (typeof value === 'bigint') {
            entry.tag = 5; entry.atom = bytes(value.toString()); return index;
        }
        if (!object) {
            throw new Error(`Unsupported analysis metadata: ${typeof value}.`);
        }
        this.seen.set(value, index);
        if (!this.identities.has(value)) {
            this.identities.set(value, this.identities.next++);
        }
        entry.identity = this.identities.get(value);
        const constructor = value.constructor;
        if (constructor && !this.identities.has(constructor)) {
            this.identities.set(constructor, this.identities.next++);
        }
        entry.kind = this.string(`${constructor?.name || ''}:${constructor ? this.identities.get(constructor) : 0}`);
        if (value instanceof Date) {
            entry.tag = 7; entry.atom = number(value.getTime());
        } else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
            entry.tag = 6;
            entry.atom = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        } else if (value instanceof Map) {
            entry.tag = 9; entry.props = Array.from(value, ([key, item]) => [this.key(key), this.value(item)]);
        } else if (value instanceof Set) {
            entry.tag = 10; entry.props = Array.from(value, (item) => [this.key(item), 0]);
        } else {
            entry.tag = 8;
            const source = value.type?.shape && ('values' in value || 'encoding' in value) ? tensorHeader(value) : value;
            entry.props = Object.keys(source).sort().map((key) => [this.string(key), this.value(source[key])]);
        }
        if (entry.tag === 8) {
            const signature = `${entry.kind}:${entry.props.map(([key, value]) => `${key},${value}`).join(';')}`;
            if (this.structures.has(signature)) {
                const existing = this.structures.get(signature);
                this.seen.set(value, existing);
                if (index === this.arena.length - 1) {
                    this.arena.pop();
                }
                return existing;
            }
            this.structures.set(signature, index);
        }
        return index;
    }
}

export class AnalysisEncoder {
    constructor() {
        this.targets = []; this.ids = new WeakMap(); this.identities = new WeakMap(); this.identities.next = 1;
    }
    register(target) {
        if (!target || !Array.isArray(target.nodes)) {
            return absent;
        }
        if (!this.ids.has(target)) {
            this.ids.set(target, this.targets.length); this.targets.push({ target });
        }
        return this.ids.get(target);
    }
    async encode(id, current = () => true) {
        const record = this.targets[id];
        if (record.bytes || record.uploaded) {
            return record;
        }
        const { target } = record;
        const metadata = new Metadata(this.identities);
        const noChain = metadata.value([]);
        const tensors = []; const tensorIds = new WeakMap();
        const tensor = (value) => {
            if (!value || typeof value !== 'object') {
                throw new Error('Invalid analysis tensor.');
            }
            if (!tensorIds.has(value)) {
                tensorIds.set(value, tensors.length); tensors.push(value);
            }
            return tensorIds.get(value);
        };
        const ports = (args) => (args || []).filter((arg) => !bodyTypes.has(arg.type)).map((arg) => ({
            name: metadata.string(arg.name), type: metadata.string(arg.type), meta: metadata.value(Array.isArray(arg.value) ? undefined : arg.value),
            values: Array.isArray(arg.value) ? arg.value.map(tensor) : [] }));
        const nodes = []; const descriptions = []; const bodyRecords = [];
        record.descriptions = descriptions;
        const catalog = nodeCatalog(target.nodes);
        let deadline = performance.now() + 4;
        for (const description of nodeDescriptions(target)) {
            if (!current()) {
                throw new Error('Analysis cancelled.');
            }
            const index = nodes.length;
            descriptions.push(description);
            const descriptionAttributes = description.attributes || [];
            const hasBodies = description._hasSubgraphs || description.type?.type === 'function' ||
                Array.isArray(description.type?.nodes) || description.inner || description.chain?.length ||
                descriptionAttributes.some((arg) => bodyTypes.has(arg.type)) ||
                ['inputs', 'blocks'].some((key) => description[key]?.some((arg) => bodyTypes.has(arg.type)));
            const original = hasBodies && catalog ? target.nodes[index] : description;
            const attributes = original === description ? descriptionAttributes : original.attributes || [];
            const bodies = []; const declarations = [];
            const body = (target, slot) => {
                const graph = this.register(target);
                if (graph === absent) {
                    throw new Error(`Function body unavailable: ${slot}.`);
                }
                bodies.push({ slot, graph });
            };
            const visitBodies = (node, prefix = '') => {
                if (Array.isArray(node.type?.nodes)) {
                    body(node.type, `${prefix}type`);
                } else if (node.type?.type === 'function') {
                    throw new Error('Function definition is unavailable. Nested bodies have not been compared.');
                }
                for (const collection of ['inputs', 'attributes', 'blocks']) {
                    for (const [position, arg] of (node[collection] || []).entries()) {
                        if (bodyTypes.has(arg.type)) {
                            const graphs = arg.type.endsWith('[]') ? arg.value : [arg.value];
                            if (!Array.isArray(graphs)) {
                                throw new Error('Subgraph array is unavailable. Nested bodies have not been compared.');
                            }
                            declarations.push([`${prefix}${collection}/${arg.name}/${position}`, arg.type, graphs.length]);
                            for (const [at, graph] of graphs.entries()) {
                                body(graph, `${prefix}${collection}/${arg.name}/${position}/${at}`);
                            }
                        }
                    }
                }
                (node.chain || []).forEach((child, at) => visitBodies(child, `${prefix}chain/${at}/`));
                if (node.inner) {
                    visitBodies(node.inner, `${prefix}inner/`);
                }
            };
            if (hasBodies) {
                visitBodies(original);
            }
            bodyRecords.push(bodies);
            let scope = original.group;
            if (typeof scope !== 'string') {
                scope = original.name?.includes('/') ? original.name.slice(0, original.name.lastIndexOf('/')) : '';
                if (typeof original._scope === 'string') {
                    scope = original._scope;
                }
            }
            nodes.push({ name: metadata.string(original.name || original.identifier), group: metadata.string(original.group),
                scope: metadata.string(scope), type: metadata.string(typeKey(original)), meta: metadata.tuple([
                    metadata.value(original.type?.version), original.chain?.length ? metadata.value(original.chain.map(nodeMetadata)) : noChain,
                    metadata.value(original.inner ? nodeMetadata(original.inner) : undefined), declarations.length ? metadata.value(declarations) : noChain]),
                attrs: attributes.filter((arg) => !bodyTypes.has(arg.type)).map((arg) => [metadata.string(arg.name), metadata.string(arg.type), metadata.value(attributeValue(arg))]),
                inputs: ports(original.inputs), outputs: ports(outputs(original)), controls: (original.controlDependencies || []).map(tensor),
                bodies: bodies.map((body) => [metadata.string(body.slot), body.graph]) });
            if (hasBodies) {
                catalog?.evict(index);
            }
            if (performance.now() > deadline) {
                // eslint-disable-next-line no-await-in-loop
                await new Promise((resolve) => {
                    setTimeout(resolve, 0);
                });
                // eslint-disable-next-line require-atomic-updates -- Each encode owns its sequential deadline.
                deadline = performance.now() + 4;
            }
        }
        const inputs = ports(target.inputs); const graphOutputs = ports(target.outputs);
        const interfaceMeta = metadata.value({ inputs: portMetadata(target.inputs), outputs: portMetadata(target.outputs),
            attributes: (target.attributes || []).filter((arg) => !bodyTypes.has(arg.type))
                .map((arg) => ({ name: arg.name, type: arg.type, value: attributeValue(arg) })).sort((a, b) => String(a.name).localeCompare(String(b.name))) });
        const pause = async () => {
            if (!current()) {
                throw new Error('Analysis cancelled.');
            }
            if (performance.now() > deadline) {
                await new Promise((resolve) => {
                    setTimeout(resolve, 0);
                });
                // eslint-disable-next-line require-atomic-updates -- pause calls are awaited in order.
                deadline = performance.now() + 4;
            }
        };
        // These ordered buffers yield periodically to keep the renderer responsive.
        /* eslint-disable no-await-in-loop */
        const tensorRecords = [];
        for (const value of tensors) {
            tensorRecords.push({ name: metadata.string(value.name),
                meta: metadata.tuple([metadata.value(value.type), metadata.value(value.quantization), metadata.header(value.initializer)]),
                dtype: metadata.string(value.type?.dataType), dimensions: Array.isArray(value.type?.shape?.dimensions) ? value.type.shape.dimensions.map((d) => metadata.value(d)) : null,
                initializer: Boolean(value.initializer) });
            if (tensorRecords.length % 1024 === 0) {
                await pause();
            }
        }
        const writer = new Writer();
        writer.u32(0x32414746); writer.u32(id);
        writer.u32(metadata.strings.length);
        let count = 0;
        for (const item of metadata.strings) {
            if (item.isWellFormed && !item.isWellFormed()) {
                throw new Error('Invalid Unicode in graph metadata key.');
            }
            writer.bytes(utf8.encode(item));
            if (++count % 1024 === 0) {
                await pause();
            }
        }
        writer.u32(metadata.arena.length); count = 0;
        for (const item of metadata.arena) {
            writer.u32(item.tag); writer.u32(item.kind); writer.u32(item.identity); writer.bytes(item.atom);
            writer.list(item.props, ([a, b]) => {
                writer.u32(a); writer.u32(b);
            });
            if (++count % 1024 === 0) {
                await pause();
            }
        }
        writer.u32(tensorRecords.length); count = 0;
        for (const item of tensorRecords) {
            writer.u32(item.name); writer.u32(item.meta); writer.u32(item.dtype); writer.u32(Number(item.initializer));
            writer.u32(item.dimensions?.length ?? absent); (item.dimensions || []).forEach((d) => writer.u32(d));
            if (++count % 1024 === 0) {
                await pause();
            }
        }
        const writePorts = (items) => writer.list(items, (item) => {
            writer.u32(item.name); writer.u32(item.type); writer.u32(item.meta); writer.list(item.values, (v) => writer.u32(v));
        });
        writer.u32(nodes.length); count = 0;
        for (const item of nodes) {
            for (const key of ['name', 'group', 'scope', 'type', 'meta']) {
                writer.u32(item[key]);
            }
            writer.list(item.attrs, (attr) => attr.forEach((v) => writer.u32(v)));
            writePorts(item.inputs); writePorts(item.outputs); writer.list(item.controls, (v) => writer.u32(v));
            writer.list(item.bodies, (body) => body.forEach((v) => writer.u32(v)));
            if (++count % 1024 === 0) {
                await pause();
            }
        }
        writePorts(inputs); writePorts(graphOutputs); writer.u32(interfaceMeta);
        /* eslint-enable no-await-in-loop */
        Object.assign(record, { bytes: writer.finish(), descriptions, tensors, bodies: bodyRecords });
        return record;
    }
}

export const projectedGraph = (record, data) => {
    const { target, descriptions, tensors } = record;
    const groups = new Map(data.groups.map((group) => [group.id, { ...group, members: group.members,
        counts: group.counts, children: [], boundary: { inputs: group.inputs.map((index) => ({ name: tensors[index].name, value: [tensors[index]] })),
            outputs: group.outputs.map((index) => ({ name: tensors[index].name, value: [tensors[index]] })),
            controlDependencies: group.controls.map((index) => tensors[index]) } }]));
    const root = { id: '', children: [] };
    for (const group of groups.values()) {
        group.parent = groups.get(group.parent) || root; group.parent.children.push(group);
    }
    const containers = new Map();
    for (const id of data.containers) {
        const group = groups.get(id); containers.set(id, { group, parent: group.parent.id });
    }
    const catalog = nodeCatalog(target.nodes);
    const decorate = (node, entry) => overlay(node, { group: entry.parent, _originalNode: node, _originalIndex: entry.index });
    const summary = (entry) => {
        const group = groups.get(entry.group);
        return { name: group.id, type: { name: group.label, category: 'Layer' }, group: entry.parent,
            ...group.boundary, attributes: [], _hierarchyGroup: group };
    };
    const records = data.records.map((entry) => entry.index === absent ? { ...entry, summary: summary(entry) } : entry);
    const nodes = new NodeCatalog(records, (entry) => entry.summary || decorate(target.nodes[entry.index], entry),
        (entry) => entry.summary || decorate(descriptions[entry.index], entry), () => catalog?.release(),
        (index) => {
            if (records[index].index !== absent) {
                catalog?.evict(records[index].index);
            }
        }).nodes;
    const hierarchy = { groups, root, boundary: (group) => group.boundary };
    data.byKey = new Map(data.groups.map((group) => [group.key, group]));
    return overlay(target, { nodes, groups: groups.size > 0, _hierarchy: hierarchy, _groupContainers: containers,
        _analysisProjection: data });
};

// Kept separate from layout workers: analysis owns persistent graph and matching state.
export class GraphAnalysis {
    constructor(host = null) {
        this.encoder = new AnalysisEncoder(); this.pending = new Map(); this.next = 0; this.disposed = false;
        if (host) {
            this.worker = host.worker('./analysis-worker'); this.ready = Promise.resolve();
        } else {
            this.ready = import('node:worker_threads').then(({ Worker }) => {
                if (this.disposed) {
                    return;
                }
                this.worker = new Worker(new URL('./analysis-worker.js', import.meta.url), { type: 'module' });
            });
        }
        this.ready = this.ready.then(() => {
            if (!this.worker) {
                return;
            }
            const receive = (data) => {
                if (this.disposed) {
                    return;
                }
                if (data.event === 'progress') {
                    this.onprogress?.(data); return;
                }
                const pending = this.pending.get(data.id);
                if (pending) {
                    this.pending.delete(data.id); if (data.error) {
                        pending.reject(new Error(data.error));
                    } else {
                        pending.resolve(data.result);
                    }
                }
            };
            if (this.worker.addEventListener) {
                this.worker.addEventListener('message', (event) => receive(event.data));
                this.worker.addEventListener('error', (event) => this.dispose(new Error(event.message || 'Analysis worker failed.')));
            } else {
                this.worker.on('message', receive);
                this.worker.on('error', (error) => this.dispose(error));
                this.worker.on('exit', () => this.dispose(new Error('Analysis worker closed.')));
            }
        });
    }
    async request(command, args = {}, transfer = []) {
        await this.ready;
        if (this.disposed) {
            throw new Error('Analysis is closed.');
        }
        const id = ++this.next;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            try {
                this.worker.postMessage({ id, command, ...args }, transfer);
            } catch (error) {
                this.pending.delete(id); reject(error);
            }
        });
    }
    async compare(a, b) {
        if (this.comparing) {
            throw new Error('An analysis job is already running.');
        }
        this.comparing = true;
        try {
            const rootA = this.encoder.register(a); const rootB = this.encoder.register(b);
            if (rootA === absent || rootB === absent) {
                throw new Error('Comparison requires two graphs.');
            }
            const started = performance.now();
            let packing = 0;
            const transferTimes = [];
            const packingJobs = new Map();
            const uploads = [];
            const schedule = (id) => {
                if (id < this.encoder.targets.length && !packingJobs.has(id)) {
                    const job = this.encoder.encode(id, () => !this.disposed);
                    job.catch(() => {});
                    packingJobs.set(id, job);
                }
            };
            for (let id = 0; id < this.encoder.targets.length; id++) {
                const packStart = performance.now();
                // Two packing jobs keep the second model from waiting behind the first upload/layout.
                schedule(id); schedule(id + 1);
                // eslint-disable-next-line no-await-in-loop
                const record = await packingJobs.get(id);
                packing += performance.now() - packStart;
                if (!record.uploaded) {
                    const bytes = record.bytes; record.bytes = null;
                    const transferStart = performance.now();
                    const upload = this.request('upload', { bytes: bytes.buffer }, [bytes.buffer]).then(() => {
                        transferTimes.push(performance.now() - transferStart);
                        record.uploaded = true;
                    });
                    upload.catch(() => {});
                    uploads.push(upload);
                }
            }
            await Promise.all(uploads);
            const packed = performance.now();
            const result = await this.request('compare', { a: rootA, b: rootB });
            result.timing = { packingAndTransfer: packed - started, packing, transferAndDecode: transferTimes.reduce((a, b) => a + b, 0), analysis: performance.now() - packed };
            return result;
        } finally {
            this.comparing = false;
        }
    }
    result(pair) {
        return this.request('result', { pair });
    }
    async project(graph, expanded, pair, side, initialize = false) {
        const data = await this.request('project', { graph, expanded: [...expanded], pair, side, initialize });
        const record = this.encoder.targets[graph];
        return projectedGraph(record, data);
    }
    dispose(error = new Error('Analysis is closed.')) {
        if (this.disposed) {
            return;
        }
        this.disposed = true;
        for (const pending of this.pending.values()) {
            pending.reject(error);
        }
        this.pending.clear(); this.worker?.terminate(); this.worker = null;
    }
}

export const indexedGraph = (target) => overlay(target, { groups: false, _analysisIndices: true });

export const instantiateAnalysis = async () => {
    const module = await loadAnalysisModule();
    const { exports: wasm } = await WebAssembly.instantiate(module, { source: { read_at: () => -1 } });
    if (!wasm.analysis_new) {
        throw new Error('Graph analysis WASM is missing. Rebuild the Rust index.');
    }
    return wasm;
};
