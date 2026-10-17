import { ModuleBlocks } from './module-blocks.js';
import { nodeDescriptions } from './repeated-blocks.js';

const values = (args) => (args || []).flatMap((arg) => arg.value || []);
const shape = (value) => value?.type?.shape?.dimensions;
const dimensions = (value) => {
    const dims = shape(value);
    return Array.isArray(dims) && dims.length > 0 && dims.every((dim) =>
        (Number.isSafeInteger(dim) && dim > 0) || (typeof dim === 'string' && dim.length > 0 && dim !== '?' && dim.length <= 256)) ? dims : null;
};
const same = (a, b) => a?.length === b?.length && a?.every((dim, i) => dim === b[i]);
const sameType = (a, b) => a?.type?.dataType === b?.type?.dataType && same(dimensions(a), dimensions(b));
const domain = (node) => node.type?.domain || node.type?.module || '';
const standard = (node) => ['', 'ai.onnx'].includes(domain(node));
const fusedAttention = (node) => (standard(node) && node.type.name === 'Attention' && node.type.version >= 23) ||
    (domain(node) === 'com.microsoft' && node.type.version === 1 && ['Attention', 'MultiHeadAttention', 'GroupQueryAttention'].includes(node.type.name));
const pointwise = new Set(['LayerNormalization', 'Transpose', 'Reshape', 'Flatten', 'Squeeze', 'Unsqueeze', 'Cast', 'Identity', 'Conv', 'MatMul', 'Gemm']);
const attentionOps = new Set([...pointwise, 'Softmax', 'Split', 'Concat', 'Slice', 'Expand', 'Tile', 'Add', 'Sub', 'Mul', 'Div', 'Shape', 'Gather']);
const mlpOps = new Set([...pointwise, 'Gelu', 'Relu', 'Swish', 'Sigmoid', 'Mul', 'Add']);
const transforms = new Set(['Transpose', 'Reshape', 'Flatten', 'Squeeze', 'Unsqueeze', 'Cast', 'Identity']);

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
    const output = (index) => values(nodes[index]?.outputs)[0];
    const source = (value, type) => {
        const index = producers.get(value?.name);
        return index !== undefined && standard(nodes[index]) && (!type || nodes[index].type.name === type) ? index : undefined;
    };
    const uncast = (value) => {
        const index = source(value, 'Cast');
        return index === undefined ? value : values(nodes[index].inputs)[0];
    };
    const scalarParameter = (value) => value?.initializer && Array.isArray(shape(value)) && shape(value).every((dim) => dim === 1);
    const registerNorm = (norm) => {
        if (!norms.has(norm.input.name)) {
            norms.set(norm.input.name, []);
        }
        norms.get(norm.input.name).push(norm);
    };
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const inputs = values(node.inputs);
        try {
            const dims = dimensions(inputs[0]);
            if (standard(node) && ['LayerNormalization', 'RMSNormalization', 'SimplifiedLayerNormalization'].includes(node.type.name) &&
                (node.type.name !== 'RMSNormalization' || node.type.version >= 23) && dims && Number.isSafeInteger(dims.at(-1)) &&
                sameType(inputs[0], output(i)) && same(dimensions(inputs[1]), [dims.at(-1)]) && inputs[1]?.initializer &&
                [-1, dims.length - 1].includes(Number(attributes(i).get('axis') ?? -1))) {
                registerNorm({ start: i, end: i, input: inputs[0], output: output(i), title: node.type.name });
            }
            // Match the square/mean/epsilon/root/scale wiring without opening scalar or weight payloads.
            const scale = source(uncast(output(i)), 'Mul');
            if (scale !== undefined && standard(node)) {
                const pair = values(nodes[scale].inputs);
                const weight = pair.find((value) => value.initializer);
                const normalized = uncast(pair.find((value) => !value.initializer));
                const normalize = source(normalized);
                if (normalize !== undefined && weight && ['Div', 'Mul'].includes(nodes[normalize].type.name)) {
                    const operands = values(nodes[normalize].inputs);
                    for (let slot = 0; slot < (nodes[normalize].type.name === 'Mul' ? 2 : 1); slot++) {
                        const data = operands[slot];
                        let root = operands[1 - slot];
                        const inverse = source(root);
                        if (nodes[normalize].type.name === 'Mul') {
                            if (inverse === undefined || !['Reciprocal', 'Div'].includes(nodes[inverse].type.name)) {
                                continue;
                            }
                            const args = values(nodes[inverse].inputs);
                            if (nodes[inverse].type.name === 'Div' && !scalarParameter(args[0])) {
                                continue;
                            }
                            root = args.at(-1);
                        }
                        const sqrt = source(root, 'Sqrt');
                        const add = sqrt === undefined ? undefined : source(values(nodes[sqrt].inputs)[0], 'Add');
                        if (add === undefined) {
                            continue;
                        }
                        const terms = values(nodes[add].inputs);
                        const mean = source(terms.find((value) => !value.initializer), 'ReduceMean');
                        // Pow requires an exponent payload; Mul(X, X) proves squaring from wiring alone.
                        const square = mean === undefined ? undefined : source(values(nodes[mean].inputs)[0], 'Mul');
                        const x = uncast(data);
                        const dims = dimensions(x);
                        const axes = mean === undefined ? null : attributes(mean).get('axes');
                        if (square === undefined || !dims || !Number.isSafeInteger(dims.at(-1)) || dims.at(-1) <= 1 ||
                            !terms.some(scalarParameter) || !same(dimensions(weight), [dims.at(-1)]) ||
                            values(nodes[square].inputs).length !== 2 || !values(nodes[square].inputs).every((value) => value.name === data.name) ||
                            !same(dimensions(output(mean)), [...dims.slice(0, -1), 1]) || Number(attributes(mean).get('keepdims') ?? 1) !== 1 ||
                            (axes && (axes.length !== 1 || ![-1, dims.length - 1].includes(Number(axes[0])))) || !sameType(x, output(i))) {
                            continue;
                        }
                        // shortcut: cap normalizers at 16 contiguous operators; extend with fixtures for longer lowerings.
                        const members = new Set();
                        const pending = [output(i)];
                        let valid = true;
                        while (pending.length && members.size <= 16) {
                            const value = pending.pop();
                            if (value?.initializer || value?.name === x.name) {
                                continue;
                            }
                            const index = source(value);
                            if (index === undefined || !['Cast', 'Mul', 'ReduceMean', 'Add', 'Sqrt', 'Div', 'Reciprocal'].includes(nodes[index].type.name)) {
                                valid = false;
                                break;
                            }
                            if (!members.has(index)) {
                                members.add(index);
                                pending.push(...values(nodes[index].inputs));
                            }
                        }
                        const start = Math.min(...members);
                        if (valid && !pending.length && members.size === i - start + 1) {
                            registerNorm({ start, end: i, input: x, output: output(i), title: 'RMSNorm' });
                        }
                    }
                }
            }
        } catch {
            // Unavailable or unsupported normalization metadata is not a match.
        }
        // eslint-disable-next-line no-await-in-loop
        if (i % 256 === 0 && !await yieldWork()) {
            return null;
        }
    }
    const projection = (index) => {
        const node = nodes[index];
        const inputs = values(node.inputs);
        const weight = inputs[1];
        if (!weight?.initializer) {
            return null;
        }
        const dims = dimensions(weight);
        if (!dims || !dims.every(Number.isSafeInteger)) {
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
            return (left === right && dim === left) || (left === 1 && dim === right) || (right === 1 && dim === left);
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
    const fused = (index, norm, projections) => {
        const node = nodes[index];
        const inputs = values(node.inputs);
        const out = dimensions(output(index));
        const q = dimensions(inputs[0]);
        const attrs = attributes(index);
        if (!q || !out || inputs[0].type?.dataType !== output(index)?.type?.dataType) {
            return false;
        }
        if (domain(node) === 'com.microsoft' && node.type.name === 'Attention') {
            const weight = dimensions(inputs[1]);
            const heads = Number(attrs.get('num_heads'));
            const configured = attrs.get('qkv_hidden_sizes');
            const sizes = configured?.length ? configured.map(Number) : Array(3).fill(weight?.[1] / 3);
            return q.length === 3 && out.length === 3 && inputs[1]?.initializer && weight?.length === 2 &&
                weight[0] === q[2] && sizes.every((size) => Number.isSafeInteger(size) && size > 0 && size % heads === 0) &&
                Number.isSafeInteger(heads) && heads > 0 && sizes.length === 3 && sizes[0] === sizes[1] &&
                sizes.reduce((sum, size) => sum + size, 0) === weight[1] && same(out, [q[0], q[1], sizes[2]]) &&
                follows(inputs[0], norm.output, norm.end, pointwise);
        }
        const k = dimensions(inputs[1]);
        const v = dimensions(inputs[2]);
        if (!k || !v || k.length !== q.length || v.length !== q.length ||
            inputs.slice(0, 3).some((value) => value.initializer || value.type?.dataType !== inputs[0].type?.dataType) ||
            q[0] !== k[0] || k[0] !== v[0]) {
            return false;
        }
        let queryHeads = Number(attrs.get('q_num_heads') ?? attrs.get('num_heads'));
        let kvHeads = node.type.name === 'MultiHeadAttention' ? queryHeads : Number(attrs.get('kv_num_heads') ?? queryHeads);
        let compatible = false;
        if (standard(node) && q.length === 4) {
            queryHeads = q[1];
            kvHeads = k[1];
            compatible = v[1] === kvHeads && k[2] === v[2] && q[3] === k[3] && same(out, [q[0], q[1], q[2], v[3]]);
        } else if (q.length === 3) {
            const widths = [q[2], k[2], v[2]];
            compatible = widths.every(Number.isSafeInteger) && q[2] % queryHeads === 0 && k[2] % kvHeads === 0 && v[2] % kvHeads === 0 &&
                q[2] / queryHeads === k[2] / kvHeads && k[1] === v[1] && same(out, [q[0], q[1], queryHeads * v[2] / kvHeads]);
        }
        return compatible && Number.isSafeInteger(queryHeads) && Number.isSafeInteger(kvHeads) && kvHeads > 0 &&
            queryHeads >= kvHeads && queryHeads % kvHeads === 0 && inputs.slice(0, 3).every((value) =>
            projections.slice(0, -1).some((item) => follows(value, output(item.index), norm.end, attentionOps)));
    };
    const classify = (norm, end, input) => {
        const start = norm.end;
        const c = dimensions(input)?.at(-1);
        if (!Number.isSafeInteger(c) || !['float16', 'float32', 'float64', 'bfloat16'].includes(input.type?.dataType)) {
            return null;
        }
        const indices = Array.from({ length: end - start - 1 }, (_, i) => start + i + 1);
        const projections = indices.map((i) => ({ index: i, dims: projection(i) })).filter((item) => item.dims);
        if (indices.some((i) => ['Conv', 'Gemm'].includes(nodes[i].type.name) && !projection(i))) {
            return null;
        }
        const softmax = indices.filter((i) => nodes[i].type.name === 'Softmax');
        const products = indices.filter((i) => nodes[i].type.name === 'MatMul' && !projection(i));
        const cores = indices.filter((i) => fusedAttention(nodes[i]));
        if (cores.length === 1 && !softmax.length && !products.length && projections.length >= 1 && projections.length <= 4 &&
            indices.every((i) => attentionOps.has(nodes[i].type.name) || fusedAttention(nodes[i])) &&
            projections.slice(0, -1).every((item) => item.dims.input === c && follows(values(nodes[item.index].inputs)[0], norm.output, start, pointwise)) &&
            projections.at(-1).dims.output === c && fused(cores[0], norm, projections) &&
            follows(values(nodes[projections.at(-1).index].inputs)[0], output(cores[0]), start, attentionOps)) {
            return 'Attention';
        }
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
                    follows(values(nodes[item.index].inputs)[0], norm.output, start, pointwise)) &&
                follows(values(nodes[projections.at(-1).index].inputs)[0], values(nodes[products[1]].outputs)[0], start, attentionOps) &&
                projections.at(-1).dims.output === c) {
                return 'Attention';
            }
        }
        const activations = indices.filter((i) => ['Gelu', 'Relu', 'Swish', 'Sigmoid'].includes(nodes[i].type.name))
            .map((i) => ({ index: i, input: values(nodes[i].inputs)[0], output: output(i) }));
        for (const activation of [...activations]) {
            if (nodes[activation.index].type.name === 'Sigmoid') {
                for (const i of consumers.get(activation.output.name) || []) {
                    const args = values(nodes[i]?.inputs);
                    if (i > start && i < end && nodes[i].type.name === 'Mul' && args.length === 2 &&
                        args.some((value) => value.name === activation.input.name) && args.every((value) => sameType(value, output(i)))) {
                        activations.push({ index: i, input: activation.input, output: output(i) });
                    }
                }
            }
        }
        if (projections.length === 2 && indices.every((i) => mlpOps.has(nodes[i].type.name))) {
            const [first, last] = projections;
            if (first.dims.input === c && first.dims.output > c && last.dims.input === first.dims.output && last.dims.output === c &&
                follows(values(nodes[first.index].inputs)[0], norm.output, start, pointwise) &&
                activations.some((activation) => follows(activation.input, output(first.index), start, transforms) &&
                    follows(values(nodes[last.index].inputs)[0], activation.output, start, transforms))) {
                return 'MLP';
            }
        }
        if (projections.length === 3 && indices.every((i) => mlpOps.has(nodes[i].type.name))) {
            const [first, second, last] = projections;
            if (first.dims.input === c && second.dims.input === c && first.dims.output > c && second.dims.output === first.dims.output &&
                last.dims.input === first.dims.output && last.dims.output === c && [first, second].every((item) =>
                follows(values(nodes[item.index].inputs)[0], norm.output, start, transforms))) {
                for (const activation of activations) {
                    for (const [gate, up] of [[first, second], [second, first]]) {
                        if (!follows(activation.input, output(gate.index), start, transforms)) {
                            continue;
                        }
                        for (const i of indices.filter((index) => nodes[index].type.name === 'Mul')) {
                            const args = values(nodes[i].inputs);
                            if (args.length === 2 && args.every((value) => sameType(value, output(i))) &&
                                args.some((value) => follows(value, activation.output, start, transforms)) &&
                                args.some((value) => follows(value, output(up.index), start, transforms)) &&
                                follows(values(nodes[last.index].inputs)[0], output(i), start, transforms)) {
                                return 'MLP';
                            }
                        }
                    }
                }
            }
        }
        return null;
    };
    const fingerprint = (start, end) => {
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
            const dims = dimensions(value);
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
            for (const norm of norms.get(input.name) || []) {
                const start = norm.start;
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
                    const title = classify(norm, end, input);
                    if (title && nodes.slice(start, end + 1).every((item) => standard(item) || fusedAttention(item))) {
                        residuals.push({ start, end, title, norm, input: input.name, output: output.name });
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
                    parts: [attention, mlp].flatMap((part) => [
                        ...(part.norm.end > part.norm.start ? [{ title: part.norm.title, start: part.norm.start, end: part.norm.end }] : []),
                        { title: part.title, start: part.norm.end + 1, end: part.end - 1 }
                    ]) });
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
