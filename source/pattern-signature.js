const values = (args) => (args || []).flatMap((arg) => arg.value || []);
const shape = (value) => value?.type?.shape?.dimensions;
export const dimensions = (value, anonymous = false) => {
    const dims = shape(value);
    return Array.isArray(dims) && dims.length > 0 && dims.every((dim) =>
        (anonymous && dim === null) || (Number.isSafeInteger(dim) && dim > 0) ||
        (typeof dim === 'string' && dim.length > 0 && dim !== '?' && dim.length <= 256)) ? dims : null;
};

const metadata = (value) => JSON.stringify(value, (key, item) => {
    if (typeof item === 'bigint') {
        return { integer: String(item) };
    }
    if (typeof item === 'number' && !Number.isFinite(item)) {
        throw new Error('Non-finite structural metadata.');
    }
    if ((Array.isArray(item) && item.length > 4096) || (typeof item === 'string' && item.length > 65536)) {
        throw new Error('Structural metadata exceeds its comparison budget.');
    }
    if (item && typeof item === 'object' && !Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype) {
        throw new Error('Unsupported structural metadata.');
    }
    return item;
});

export const patternAttributes = (node, pattern = false) => {
    const attrs = node.attributes || [];
    const opaque = (attr) => pattern && ['tensor', 'tensor[]'].includes(attr.type);
    if (attrs.some((item) => !opaque(item) && ['graph', 'graph[]', 'tensor', 'tensor[]', 'function', 'function[]', 'object', 'object[]'].includes(item.type))) {
        throw new Error('Unsupported structural attribute.');
    }
    return new Map(attrs.map((item) => {
        if (!opaque(item)) {
            return [item.name, item.value];
        }
        // Attribute descriptors can provide tensor headers without constructing tensors or reading payloads.
        const tensor = Object.getOwnPropertyDescriptor(item, 'value')?.value;
        const types = item.tensorTypes || (tensor?.type ? [tensor.type] : []);
        return [item.name, { opaque: item.type, types: types.map((type) => [type.dataType, type.layout, type.shape?.dimensions]) }];
    }));
};

export const patternSignature = (nodes, start, end, attributes, anonymous = false) => {
    const local = new Map();
    const external = new Map();
    const parameters = new Map();
    const parameterSymbols = new Set();
    for (let i = start; i <= end; i++) {
        values(nodes[i].outputs).forEach((value, slot) => local.set(value.name, [i - start, slot]));
        for (const value of values(nodes[i].inputs).filter((item) => item.initializer)) {
            for (const dim of shape(value) || []) {
                if (typeof dim === 'string') {
                    parameterSymbols.add(dim);
                }
            }
        }
    }
    const symbols = new Map();
    const type = (value) => {
        const dims = dimensions(value, anonymous && !value.initializer);
        if (!value.type?.dataType || (!dims && shape(value)?.length !== 0)) {
            throw new Error('Unconstrained structural shape.');
        }
        return [value.type?.dataType, value.type?.layout, (dims || []).map((dim) => {
            if (!value.initializer && !parameterSymbols.has(dim) && typeof dim === 'string' && /^unk__[0-9]+$/.test(dim)) {
                if (!symbols.has(dim)) {
                    symbols.set(dim, symbols.size);
                }
                return ['symbol', symbols.get(dim)];
            }
            return dim;
        }), value.quantization || value.initializer?.quantization];
    };
    return metadata(nodes.slice(start, end + 1).map((node, offset) => [node.type.name, node.type.domain || node.type.module || '', node.type.version, node.type.identifier,
        [...attributes(start + offset)].sort(([a], [b]) => a.localeCompare(b)), values(node.inputs).map((value) => {
            if (!value.initializer && local.has(value.name)) {
                return ['local', local.get(value.name), type(value)];
            }
            const map = value.initializer ? parameters : external;
            const key = value.name || value.initializer;
            if (!map.has(key)) {
                map.set(key, map.size);
            }
            return [value.initializer ? 'parameter' : 'external', map.get(key), type(value)];
        }), values(node.outputs).map(type), (node.inputs || []).map((arg) => (arg.value || []).length),
        (node.outputs || []).map((arg) => (arg.value || []).length),
        (node.attributes || []).map((attr) => [attr.name, attr.type]).sort(([a], [b]) => a.localeCompare(b))]));
};
