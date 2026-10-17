// Full-graph consumers retain ordinary array semantics; the overview uses descriptors.
const catalogs = new WeakMap();
const analyses = new WeakMap();

export class NodeCatalog {
    constructor(records, create, describe, release = null, evict = null) {
        this.records = records;
        this.create = create;
        this.describe = describe;
        this.cache = new Map();
        this._release = release;
        this._evict = evict;
        const index = (array, key) => typeof key === 'string' && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < array.length;
        const materialize = (array) => {
            if (catalogs.has(this.nodes)) {
                for (let i = 0; i < array.length; i++) {
                    array[i] = this.nodes[i];
                }
                catalogs.delete(this.nodes);
            }
        };
        this.nodes = new Proxy(new Array(records.length), {
            get: (array, key, receiver) => {
                if (index(array, key) && !Object.hasOwn(array, key) && catalogs.has(this.nodes)) {
                    const i = Number(key);
                    if (!this.cache.has(i)) {
                        this.cache.set(i, create(records[i]));
                    }
                    return this.cache.get(i);
                }
                return Reflect.get(array, key, receiver);
            },
            has: (array, key) => (catalogs.has(this.nodes) && index(array, key)) || Reflect.has(array, key),
            ownKeys: (array) => catalogs.has(this.nodes) ? [...Array.from({ length: array.length }, (_, i) => String(i)), 'length'] : Reflect.ownKeys(array),
            getOwnPropertyDescriptor: (array, key) => {
                if (catalogs.has(this.nodes) && index(array, key) && !Object.hasOwn(array, key)) {
                    return { configurable: true, enumerable: true, get: () => this.nodes[key] };
                }
                return Reflect.getOwnPropertyDescriptor(array, key);
            },
            set: (array, key, value) => {
                materialize(array);
                return Reflect.set(array, key, value);
            },
            deleteProperty: (array, key) => {
                materialize(array);
                return Reflect.deleteProperty(array, key);
            },
            defineProperty: (array, key, descriptor) => {
                materialize(array);
                return Reflect.defineProperty(array, key, descriptor);
            },
            preventExtensions: (array) => {
                materialize(array);
                return Reflect.preventExtensions(array);
            }
        });
        catalogs.set(this.nodes, this);
    }

    release() {
        this.cache.clear();
        this._release?.();
    }

    evict(index) {
        this.cache.delete(index);
        this._evict?.(index);
    }
}

export const nodeCatalog = (nodes) => catalogs.get(nodes);

export const nodeDescriptions = function* (graph) {
    const catalog = nodeCatalog(graph.nodes);
    if (catalog) {
        for (const record of catalog.records) {
            yield catalog.describe(record);
        }
    } else {
        yield* graph.nodes;
    }
};

const pathOf = (name) => {
    const match = typeof name === 'string' && name.match(/^(.*?(?:^|[./])(?:layers?|blocks?|blk|h)[./])(0|[1-9][0-9]*)(?:[./]|$)/);
    if (!match || !Number.isSafeInteger(Number(match[2]))) {
        return null;
    }
    return { prefix: match[1], index: Number(match[2]), relative: name.slice(match[0].length) };
};

const scalar = (value, depth = 0) => {
    if (depth > 32) {
        throw new Error('Structural attribute exceeds nesting limit.');
    }
    if (value === null || value === undefined) {
        return [String(value)];
    }
    if (['string', 'number', 'boolean', 'bigint'].includes(typeof value)) {
        return [typeof value, Object.is(value, -0) ? '-0' : String(value)];
    }
    if (Array.isArray(value)) {
        if (value.length > 4096) {
            throw new Error('Structural attribute exceeds size limit.');
        }
        return ['array', value.map((item) => scalar(item, depth + 1))];
    }
    if (ArrayBuffer.isView(value)) {
        if (value instanceof DataView) {
            return ['DataView', scalar(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), depth + 1)];
        }
        if (value.length > 4096) {
            throw new Error('Structural attribute exceeds size limit.');
        }
        return [value.constructor.name, Array.from(value, (item) => scalar(item, depth + 1))];
    }
    if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
        return ['object', Object.keys(value).sort().map((key) => [key, scalar(value[key], depth + 1)])];
    }
    throw new Error('Unsupported structural attribute.');
};

const generatedDimension = (dimension) => typeof dimension === 'string' && /^unk__[0-9]+$/.test(dimension);

const tensorType = (value, symbols) => {
    const type = value && value.type;
    if (!type) {
        return null;
    }
    const dimensions = Array.from(type.shape?.dimensions || [], (dimension) => {
        // ONNX inference numbers fresh unknowns per block; preserve their equality relationships.
        if (!value.initializer && generatedDimension(dimension)) {
            if (!symbols.has(dimension)) {
                symbols.set(dimension, ['symbol', symbols.size]);
            }
            return symbols.get(dimension);
        }
        return ['dimension', scalar(dimension)];
    });
    return [type.dataType, type.layout, dimensions, scalar(value.quantization || value.initializer?.quantization)];
};

const values = (args) => (args || []).flatMap((arg) => Array.isArray(arg.value) ? arg.value : []);
const boundaries = (nodes) => {
    const outputs = new Map();
    const names = new Set();
    nodes.forEach((node, i) => (node.outputs || []).forEach((arg, j) => (arg.value || []).forEach((value, k) => {
        if (value?.name) {
            if (names.has(value.name)) {
                throw new Error('Duplicate block output.');
            }
            names.add(value.name);
            outputs.set(`${i}:${j}:${k}`, value);
        }
    })));
    const external = new Map();
    for (const node of nodes) {
        for (const value of values(node.inputs)) {
            if (value?.name && !value.initializer && !names.has(value.name) && !external.has(value.name)) {
                external.set(value.name, value);
            }
        }
    }
    return { outputs, external: Array.from(external.values()) };
};
const overlay = (source, properties) => Object.create(source, Object.fromEntries(Object.entries(properties).map(([key, value]) =>
    [key, { value, enumerable: true, configurable: true, writable: true }])));

class RepeatedBlocks {
    constructor(graph, groups) {
        this.graph = graph;
        this.groups = groups;
    }

    _describe(index) {
        const catalog = nodeCatalog(this.graph.nodes);
        return catalog ? catalog.describe(catalog.records[index]) : this.graph.nodes[index];
    }

    locate(value) {
        const names = [value?.name, ...(Array.isArray(value?.value) ? value.value.map((item) => item?.name) : [])];
        for (const name of names) {
            const path = pathOf(name);
            if (path) {
                for (const group of this.groups) {
                    const index = group.blocks.findIndex((block) => block.index === path.index);
                    if (group.prefix === path.prefix && index !== -1) {
                        return { group, index };
                    }
                }
            }
            if (name) {
                for (const group of this.groups) {
                    const index = group.blocks.findIndex((block) => block.indices.some((i) => values(this._describe(i).outputs).some((value) => value.name === name)));
                    if (index !== -1) {
                        return { group, index };
                    }
                }
            }
        }
        return null;
    }

    project(selected = new Map(), expanded = new Set()) {
        const graph = this.graph;
        const catalog = nodeCatalog(graph.nodes);
        const records = [];
        const owners = new Int32Array(graph.nodes.length).fill(-1);
        const aliases = new Map();
        for (const group of this.groups) {
            for (const i of group.members) {
                owners[i] = group.id;
            }
        }
        for (let i = 0; i < graph.nodes.length; i++) {
            const group = this.groups[owners[i]];
            if (!group || expanded.has(group.id)) {
                records.push({ index: i, group: group && i === group.anchor ? group : null });
                continue;
            }
            if (i !== group.anchor) {
                continue;
            }
            const block = group.blocks[selected.get(group.id) || 0];
            const detail = boundaries(Array.from(block.indices, (index) => this._describe(index)));
            const replacements = new Map();
            detail.external.forEach((value, slot) => replacements.set(value.name, group.external[slot]));
            for (const [role, value] of group.exposed) {
                replacements.set(detail.outputs.get(role).name, value);
            }
            const args = (list) => (list || []).map((arg) => {
                const clone = { ...arg, value: arg.value.map((value) => {
                    const replacement = replacements.get(value?.name);
                    // Alias summary connections without changing the representative's shape bindings.
                    if (replacement && Array.from(value?.type?.shape?.dimensions || []).some((dimension, i) =>
                        generatedDimension(dimension) && dimension !== replacement.type?.shape?.dimensions[i])) {
                        return overlay(value, { name: replacement.name });
                    }
                    return replacement || value;
                }) };
                arg.value.forEach((value, index) => {
                    if (value?.name && value.name !== clone.value[index]?.name) {
                        aliases.set(value.name, clone.value[index].name);
                    }
                });
                return clone;
            });
            block.indices.forEach((index, n) => {
                records.push({ index, group, args, header: n === 0 });
            });
        }
        const project = (node, record) => record.group ? overlay(node, {
            ...(record.args ? { inputs: record.args(node.inputs), outputs: record.args(node.outputs),
                group: `Repeated block ${record.group.id + 1} ×${record.group.blocks.length}` } : {}),
            _originalNode: node, _repeatGroup: record.group, _repeatHeader: record.args ? record.header : true
        }) : node;
        const projected = new NodeCatalog(records,
            (record) => project(graph.nodes[record.index], record),
            (record) => project(this._describe(record.index), record),
            () => catalog?.release(), (index) => catalog?.evict(records[index].index));
        const nodes = catalog ? projected.nodes : Array.from(projected.nodes);
        return overlay(graph, { nodes, groups: true, _repeatAliases: aliases, _originalGraph: graph });
    }
}

export const repeatedBlocks = async (graph, current = () => true) => {
    if (analyses.has(graph)) {
        return analyses.get(graph);
    }
    const catalog = nodeCatalog(graph.nodes);
    const records = catalog ? catalog.records : graph.nodes;
    const describe = (i) => catalog ? catalog.describe(records[i]) : records[i];
    const families = new Map();
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
    for (let i = 0; i < records.length; i++) {
        const path = pathOf(records[i].name);
        if (path) {
            if (!families.has(path.prefix)) {
                families.set(path.prefix, new Map());
            }
            const family = families.get(path.prefix);
            if (!family.has(path.index)) {
                family.set(path.index, { index: path.index, indices: [] });
            }
            family.get(path.index).indices.push(i);
        }
        // eslint-disable-next-line no-await-in-loop
        if (i % 256 === 0 && !await yieldWork()) {
            return null;
        }
    }
    const producers = new Map();
    const consumers = new Map();
    const blockOf = new Map();
    const signatures = new Map();
    const makeBlock = (block) => {
        const nodes = block.indices.map(describe);
        Object.assign(block, boundaries(nodes));
        const local = new Map(Array.from(block.outputs, ([role, value]) => [value.name, role]));
        const external = new Map(block.external.map((value, index) => [value.name, index]));
        const parameters = new Map();
        const symbols = new Map();
        // Keep dimensions shared with parameters literal, including their activation bindings.
        for (const node of nodes) {
            for (const value of values(node.inputs)) {
                if (value?.initializer) {
                    for (const dimension of value.type?.shape?.dimensions || []) {
                        if (typeof dimension === 'string') {
                            symbols.set(dimension, ['dimension', scalar(dimension)]);
                        }
                    }
                }
            }
        }
        const typeOf = (value) => tensorType(value, symbols);
        const signature = nodes.map((node) => {
            if (!node.type || node.type.nodes || node.chain?.length || node.blocks?.length || node.controlDependencies?.length) {
                throw new Error('Nested or stateful block.');
            }
            const inputs = (node.inputs || []).map((arg) => [arg.name, (arg.value || []).map((value) => {
                if (!value) {
                    return null;
                }
                const type = typeOf(value);
                if (value.initializer) {
                    const key = value.name || value.initializer;
                    if (!parameters.has(key)) {
                        parameters.set(key, parameters.size);
                    }
                    return ['parameter', parameters.get(key), type];
                }
                if (!value.name) {
                    throw new Error('Unnamed block input.');
                }
                if (local.has(value.name)) {
                    return ['local', local.get(value.name), type];
                }
                return ['input', external.get(value.name), type];
            })]);
            const attrs = (node.attributes || []).map((arg) => {
                if (['graph', 'graph[]', 'tensor', 'tensor[]', 'function', 'function[]', 'object', 'object[]'].includes(arg.type)) {
                    throw new Error('Nested block attribute.');
                }
                return [arg.name, arg.type, scalar(arg.value)];
            }).sort((a, b) => a[0].localeCompare(b[0]));
            return [node.type.name, node.type.domain, node.type.module, node.type.identifier, node.type.version, pathOf(node.name)?.relative, inputs,
                (node.outputs || []).map((arg) => [arg.name, (arg.value || []).map(typeOf)]), attrs];
        });
        const key = JSON.stringify(signature);
        if (!signatures.has(key)) {
            signatures.set(key, key);
        }
        block.signature = signatures.get(key);
    };
    for (const family of families.values()) {
        if (family.size < 2) {
            continue;
        }
        for (const block of family.values()) {
            try {
                makeBlock(block);
                for (const i of block.indices) {
                    blockOf.set(i, block);
                }
            } catch {
                block.signature = null;
            }
            // eslint-disable-next-line no-await-in-loop
            if (!await yieldWork()) {
                return null;
            }
        }
    }
    if (!blockOf.size) {
        analyses.set(graph, null);
        return null;
    }
    // Boundary checks include consumers outside the candidate stack and graph outputs.
    for (let i = 0; i < records.length; i++) {
        const node = describe(i);
        for (const value of values(node.outputs)) {
            if (value?.name) {
                if (producers.has(value.name)) {
                    analyses.set(graph, null);
                    return null;
                }
                producers.set(value.name, i);
            }
        }
        for (const value of [...values(node.inputs), ...(node.controlDependencies || [])]) {
            if (value?.name && !value.initializer) {
                if (!consumers.has(value.name)) {
                    consumers.set(value.name, []);
                }
                consumers.get(value.name).push(i);
            }
        }
        // eslint-disable-next-line no-await-in-loop
        if (i % 256 === 0 && !await yieldWork()) {
            return null;
        }
    }
    for (const value of values(graph.outputs)) {
        if (value?.name) {
            if (!consumers.has(value.name)) {
                consumers.set(value.name, []);
            }
            consumers.get(value.name).push(-1);
        }
    }
    const groups = [];
    const accept = (prefix, blocks) => {
        if (blocks.length < 2) {
            return;
        }
        const members = new Set(blocks.flatMap((block) => block.indices));
        const first = blocks[0];
        const last = blocks[blocks.length - 1];
        const carry = new Map();
        if (first.external.some((value) => members.has(producers.get(value.name)))) {
            return;
        }
        for (let i = 1; i < blocks.length; i++) {
            const block = blocks[i];
            for (let slot = 0; slot < block.external.length; slot++) {
                const input = block.external[slot];
                let connection = 'shared';
                if (input.name !== first.external[slot].name) {
                    const producer = producers.get(input.name);
                    if (blockOf.get(producer) !== blocks[i - 1]) {
                        return;
                    }
                    const role = Array.from(blocks[i - 1].outputs).find(([, value]) => value.name === input.name)?.[0];
                    connection = role;
                }
                if (carry.has(slot) && carry.get(slot) !== connection) {
                    return;
                }
                carry.set(slot, connection);
            }
        }
        for (const block of blocks) {
            for (const value of block.outputs.values()) {
                if (block !== last && (consumers.get(value.name) || []).some((i) => !members.has(i))) {
                    return;
                }
            }
        }
        const exposed = new Map(Array.from(last.outputs).filter(([, value]) => (consumers.get(value.name) || []).some((i) => !members.has(i))));
        const indices = Uint32Array.from(members).sort();
        const group = { id: groups.length, prefix, blocks, members: indices, exposed, anchor: indices[0], label: `${prefix}${first.index}–${last.index} ×${blocks.length}` };
        groups.push(group);
    };
    for (const [prefix, family] of families) {
        let run = [];
        for (const block of Array.from(family.values()).sort((a, b) => a.index - b.index)) {
            const previous = run[run.length - 1];
            if (previous && (block.index !== previous.index + 1 || !block.signature || block.signature !== previous.signature)) {
                accept(prefix, run);
                run = [];
            }
            if (block.signature) {
                run.push(block);
            }
        }
        accept(prefix, run);
    }
    if (!current()) {
        return null;
    }
    for (const group of groups) {
        group.external = group.blocks[0].external;
        group.blocks = group.blocks.map((block) => ({ index: block.index, indices: Uint32Array.from(block.indices) }));
    }
    const result = groups.length ? new RepeatedBlocks(graph, groups) : null;
    analyses.set(graph, result);
    return result;
};
