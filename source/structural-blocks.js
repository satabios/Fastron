import { ModuleBlocks } from './module-blocks.js';
import { nodeDescriptions } from './repeated-blocks.js';

const values = (args) => (args || []).flatMap((arg) => arg.value || []);
const shape = (value) => value?.type?.shape?.dimensions;
const dimensions = (value) => {
    const dims = shape(value);
    return Array.isArray(dims) && dims.length > 0 && dims.every((dim) => Number.isSafeInteger(dim) && dim > 0) ? dims : null;
};
const same = (a, b) => a?.length === b?.length && a?.every((dim, i) => dim === b[i]);
const sameType = (a, b) => a?.type?.dataType === b?.type?.dataType && same(dimensions(a), dimensions(b));
const pointwise = new Set(['LayerNormalization', 'Transpose', 'Reshape', 'Flatten', 'Squeeze', 'Unsqueeze', 'Cast', 'Identity', 'Conv', 'MatMul', 'Gemm']);
const attentionOps = new Set([...pointwise, 'Softmax', 'Split', 'Concat', 'Slice', 'Expand', 'Tile', 'Add', 'Sub', 'Mul', 'Div']);
const mlpOps = new Set([...pointwise, 'Gelu', 'Relu']);

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

class StructuralBlocks extends ModuleBlocks {
    constructor(graph, groups, producers, consumers, blocks) {
        super(graph, groups, producers, consumers);
        this.blocks = new Map(blocks.map(({ start, end, parts }) => [start, { start, end, parts }]));
    }

    subgraph(indices, name, scope) {
        const graph = super.subgraph(indices, name, scope);
        const block = this.blocks.get(indices[0]);
        if (block && indices.length === block.end - block.start + 1) {
            graph._structuralParts = block.parts.map((part) => ({ title: part.title,
                start: part.start - block.start, end: part.end - block.start }));
        }
        return graph;
    }
}

// Recognize conservative pre-norm attention + MLP residual blocks; names are only tensor connection identifiers.
export const structuralBlocks = async (graph, current = () => true) => {
    if (!current()) {
        return null;
    }
    const nodes = [];
    const producers = new Map();
    const consumers = new Map();
    const norms = new Map();
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
        const i = nodes.length;
        if (node._hasSubgraphs || node.type?.nodes || node.chain?.length || node.blocks?.length || node.nodes?.length ||
            node.inner || node.controlDependencies?.length) {
            return null;
        }
        for (const value of values(node.inputs)) {
            if (value?.name && !value.initializer) {
                if (!consumers.has(value.name)) {
                    consumers.set(value.name, []);
                }
                consumers.get(value.name).push(i);
            }
        }
        for (const value of values(node.outputs)) {
            if (value?.name) {
                if (producers.has(value.name)) {
                    return null;
                }
                producers.set(value.name, i);
            }
        }
        if (node.type?.name === 'LayerNormalization') {
            const input = values(node.inputs)[0];
            if (input?.name) {
                if (!norms.has(input.name)) {
                    norms.set(input.name, []);
                }
                norms.get(input.name).push(i);
            }
        }
        nodes.push(node);
        // eslint-disable-next-line no-await-in-loop
        if (i % 256 === 0 && !await yieldWork()) {
            return null;
        }
    }
    for (const [name, indices] of consumers) {
        if (producers.has(name) && indices.some((index) => producers.get(name) >= index)) {
            return null;
        }
    }
    for (const value of values(graph.outputs)) {
        if (!consumers.has(value.name)) {
            consumers.set(value.name, []);
        }
        consumers.get(value.name).push(-1);
    }
    const group = (id, title, blocks, kind = 'structural') => {
        const start = blocks[0].indices[0];
        const end = blocks.at(-1).indices.at(-1);
        return { id, kind, title, scope: `${title} ${id + 1}`, label: title, anchor: start,
            members: Uint32Array.from({ length: end - start + 1 }, (_, i) => start + i), blocks };
    };
    if (graph._structuralParts) {
        const groups = graph._structuralParts.map((part, id) => group(id, part.title, [{ index: 0, scope: '',
            indices: Uint32Array.from({ length: part.end - part.start + 1 }, (_, i) => part.start + i) }]));
        return groups.length && current() ? new ModuleBlocks(graph, groups, producers, consumers) : null;
    }
    const attributeCache = new Map();
    const attributes = (index) => {
        if (!attributeCache.has(index)) {
            const attrs = nodes[index].attributes || [];
            if (attrs.some((attr) => ['graph', 'graph[]', 'tensor', 'tensor[]', 'function', 'function[]', 'object', 'object[]'].includes(attr.type))) {
                throw new Error('Unsupported structural attribute.');
            }
            attributeCache.set(index, new Map(attrs.map((attr) => [attr.name, attr.value])));
        }
        return attributeCache.get(index);
    };
    const projection = (index) => {
        const node = nodes[index];
        const inputs = values(node.inputs);
        const weight = inputs[1];
        if (!weight?.initializer) {
            return null;
        }
        const dims = dimensions(weight);
        if (!dims) {
            return null;
        }
        if (node.type.name === 'Conv' && dims.length >= 3 && dims.slice(2).every((dim) => dim === 1)) {
            const attrs = attributes(index);
            const data = dimensions(inputs[0]);
            const output = dimensions(values(node.outputs)[0]);
            if (Number(attrs.get('group') ?? 1) !== 1 || (attrs.get('strides') || []).some((dim) => Number(dim) !== 1) ||
                (attrs.get('pads') || []).some((dim) => Number(dim) !== 0) || !data || !output || data.length !== dims.length ||
                output.length !== data.length || data[1] !== dims[1] || output[1] !== dims[0] || data[0] !== output[0] || !same(data.slice(2), output.slice(2))) {
                return null;
            }
            return { input: dims[1], output: dims[0] };
        }
        if (dims.length === 2 && ['MatMul', 'Gemm'].includes(node.type.name)) {
            const data = dimensions(inputs[0]);
            const output = dimensions(values(node.outputs)[0]);
            const gemm = node.type.name === 'Gemm';
            const transpose = gemm && Number(attributes(index).get('transB') || 0) !== 0;
            const inputWidth = dims[transpose ? 1 : 0];
            const outputWidth = dims[transpose ? 0 : 1];
            if (!data || !output || data.at(-1) !== inputWidth || output.at(-1) !== outputWidth || !same(data.slice(0, -1), output.slice(0, -1)) ||
                (gemm && (data.length !== 2 || Number(attributes(index).get('transA') || 0) !== 0))) {
                return null;
            }
            return { input: inputWidth, output: outputWidth };
        }
        return null;
    };
    const matmul = (index) => {
        const inputs = values(nodes[index].inputs);
        const output = values(nodes[index].outputs)[0];
        const a = dimensions(inputs[0]);
        const b = dimensions(inputs[1]);
        const out = dimensions(output);
        if (!a || !b || !out || a.length < 3 || b.length < 3 || out.length !== Math.max(a.length, b.length) ||
            inputs[0].initializer || inputs[1].initializer || a.at(-1) !== b.at(-2) ||
            out.at(-2) !== a.at(-2) || out.at(-1) !== b.at(-1) || inputs.some((value) => value.type?.dataType !== output.type?.dataType)) {
            return false;
        }
        // MQA broadcasts KV heads; GQA exports may introduce a separate group dimension.
        return out.slice(0, -2).every((dim, i) => {
            const left = a[i - (out.length - a.length)] ?? 1;
            const right = b[i - (out.length - b.length)] ?? 1;
            return (left === right || left === 1 || right === 1) && dim === Math.max(left, right);
        });
    };
    const follows = (value, target, start, allowed) => {
        const visited = new Set();
        const pending = [value];
        while (pending.length) {
            const item = pending.pop();
            if (item?.name === target?.name) {
                return true;
            }
            const index = producers.get(item?.name);
            if (index === undefined || index < start || visited.has(index) || !allowed.has(nodes[index].type.name)) {
                continue;
            }
            visited.add(index);
            pending.push(...values(nodes[index].inputs).filter((input) => !input.initializer));
        }
        return false;
    };
    const classify = (start, end, input) => {
        const c = dimensions(input)?.at(-1);
        const norm = nodes[start];
        const normAxis = Number(attributes(start).get('axis') ?? -1);
        if (!c || !['float16', 'float32', 'float64', 'bfloat16'].includes(input.type?.dataType) ||
            !sameType(input, values(norm.outputs)[0]) || (normAxis !== -1 && normAxis !== dimensions(input).length - 1)) {
            return null;
        }
        const indices = Array.from({ length: end - start - 1 }, (_, i) => start + i + 1);
        const projections = indices.map((i) => ({ index: i, dims: projection(i) })).filter((item) => item.dims);
        if (indices.some((i) => ['Conv', 'Gemm'].includes(nodes[i].type.name) && !projection(i))) {
            return null;
        }
        const softmax = indices.filter((i) => nodes[i].type.name === 'Softmax');
        const products = indices.filter((i) => nodes[i].type.name === 'MatMul' && !projection(i));
        if (softmax.length === 1 && products.length === 2 && projections.length >= 2 && projections.length <= 4 &&
            indices.every((i) => attentionOps.has(nodes[i].type.name)) && products.every(matmul)) {
            const sm = softmax[0];
            const smInput = values(nodes[sm].inputs)[0];
            const smOutput = values(nodes[sm].outputs)[0];
            const axis = attributes(sm).get('axis');
            const lastAxis = dimensions(smInput)?.length - 1;
            const projected = (value) => projections.slice(0, -1).some((item) => follows(value, values(nodes[item.index].outputs)[0], start, attentionOps));
            if ((Number(axis) === -1 || Number(axis) === lastAxis || (axis === undefined && nodes[sm].type.version >= 13)) &&
                sameType(smInput, smOutput) && follows(smInput, values(nodes[products[0]].outputs)[0], start, new Set(['Mul', 'Div', 'Add', 'Sub', 'Cast', 'Identity'])) &&
                follows(values(nodes[products[1]].inputs)[0], smOutput, start, new Set(['Cast', 'Identity'])) &&
                [...values(nodes[products[0]].inputs), values(nodes[products[1]].inputs)[1]].every(projected) &&
                projections.slice(0, -1).every((item) => item.dims.input === c &&
                    follows(values(nodes[item.index].inputs)[0], values(norm.outputs)[0], start, pointwise)) &&
                follows(values(nodes[projections.at(-1).index].inputs)[0], values(nodes[products[1]].outputs)[0], start, attentionOps) &&
                projections.at(-1).dims.output === c) {
                return 'Attention';
            }
        }
        const activations = indices.filter((i) => ['Gelu', 'Relu'].includes(nodes[i].type.name));
        if (projections.length === 2 && activations.length === 1 && indices.every((i) => mlpOps.has(nodes[i].type.name))) {
            const [first, last] = projections;
            const activation = activations[0];
            if (first.dims.input === c && first.dims.output > c && last.dims.input === first.dims.output && last.dims.output === c &&
                follows(values(nodes[first.index].inputs)[0], values(norm.outputs)[0], start, pointwise) &&
                follows(values(nodes[activation].inputs)[0], values(nodes[first.index].outputs)[0], start, pointwise) &&
                follows(values(nodes[last.index].inputs)[0], values(nodes[activation].outputs)[0], start, pointwise)) {
                return 'MLP';
            }
        }
        return null;
    };
    const fingerprint = (start, end) => {
        const local = new Map();
        const external = new Map();
        const parameters = new Map();
        for (let i = start; i <= end; i++) {
            values(nodes[i].outputs).forEach((value, slot) => local.set(value.name, [i - start, slot]));
        }
        const type = (value) => [value.type?.dataType, value.type?.layout, dimensions(value), value.quantization || value.initializer?.quantization];
        return metadata(nodes.slice(start, end + 1).map((node, offset) => [node.type.name, node.type.domain || node.type.module || '', node.type.version,
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
            }), values(node.outputs).map(type)]));
    };
    const residuals = [];
    for (let end = 0; end < nodes.length; end++) {
        // eslint-disable-next-line no-await-in-loop
        if (end % 256 === 0 && !await yieldWork()) {
            return null;
        }
        const node = nodes[end];
        const inputs = values(node.inputs);
        const output = values(node.outputs)[0];
        if (node.type?.name !== 'Add' || inputs.length !== 2 || inputs.some((value) => value.initializer || !sameType(value, output))) {
            continue;
        }
        for (let slot = 0; slot < 2; slot++) {
            const input = inputs[slot];
            for (const start of norms.get(input.name) || []) {
                // shortcut: bound individual residual searches; extend after fixtures for larger or fused variants.
                if (start >= end || end - start > 2048) {
                    continue;
                }
                const members = new Set();
                const pending = [inputs[1 - slot]];
                while (pending.length) {
                    const value = pending.pop();
                    const index = producers.get(value?.name);
                    if (value?.initializer || value?.name === input.name || index === undefined || index < start || index >= end || members.has(index)) {
                        continue;
                    }
                    members.add(index);
                    pending.push(...values(nodes[index].inputs));
                }
                if (!members.has(start) || members.size !== end - start) {
                    continue;
                }
                try {
                    const title = classify(start, end, input);
                    if (title && nodes.slice(start, end + 1).every((item) => ['', 'ai.onnx'].includes(item.type.domain || item.type.module || ''))) {
                        residuals.push({ start, end, title, input: input.name, output: output.name });
                    }
                } catch {
                    // Unsupported metadata leaves this region unfolded.
                }
            }
        }
        // eslint-disable-next-line no-await-in-loop
        if (!await yieldWork()) {
            return null;
        }
    }
    const blocks = [];
    const signatures = new Map();
    const mlps = new Map(residuals.filter((part) => part.title === 'MLP').map((part) => [part.start, part]));
    for (const attention of residuals.filter((part) => part.title === 'Attention')) {
        const mlp = mlps.get(attention.end + 1);
        if (mlp?.input === attention.output && (!blocks.length || blocks.at(-1).end < attention.start)) {
            try {
                const signature = fingerprint(attention.start, mlp.end);
                if (!signatures.has(signature)) {
                    signatures.set(signature, signature);
                }
                blocks.push({ start: attention.start, end: mlp.end, signature: signatures.get(signature),
                    parts: [attention, mlp].map((part) => ({ title: part.title, start: part.start + 1, end: part.end - 1 })) });
            } catch {
                // A pattern match alone cannot establish equivalent stack metadata.
            }
        }
        // eslint-disable-next-line no-await-in-loop
        if (!await yieldWork()) {
            return null;
        }
    }
    const groups = [];
    for (let start = 0; start < blocks.length;) {
        let end = start + 1;
        while (end < blocks.length && blocks[end].start === blocks[end - 1].end + 1 && blocks[end].signature === blocks[start].signature) {
            end++;
        }
        const instances = blocks.slice(start, end).map((block, i) => ({ index: start + i, scope: '', components: ['Attention', 'MLP'],
            indices: Uint32Array.from({ length: block.end - block.start + 1 }, (_, j) => block.start + j) }));
        groups.push(group(groups.length, 'Transformer blocks', instances));
        start = end;
    }
    return groups.length && current() ? new StructuralBlocks(graph, groups, producers, consumers, blocks) : null;
};
