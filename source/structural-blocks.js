import { dimensions, patternAttributes, patternSignature } from './pattern-signature.js';
import { ModuleBlocks } from './module-blocks.js';
import { architectureProfile } from './architecture-profile.js';
import { nodeDescriptions } from './repeated-blocks.js';

const values = (args) => (args || []).flatMap((arg) => arg.value || []);
const shape = (value) => value?.type?.shape?.dimensions;
const same = (a, b) => a?.length === b?.length && a?.every((dim, i) => dim === b[i]);
const generated = (dim) => typeof dim === 'string' && /^unk__[0-9]+$/.test(dim);
// Pattern recognition preserves unresolved generated dimensions; it does not assert their equality.
const compatible = (a, b) => a === b || (generated(a) && (generated(b) || Number.isSafeInteger(b) || typeof b === 'string')) ||
    (generated(b) && (Number.isSafeInteger(a) || typeof a === 'string'));
const compatibleShape = (a, b) => a?.length === b?.length && a?.every((dim, i) => compatible(dim, b[i]));
const sameType = (a, b) => a?.type?.dataType === b?.type?.dataType && same(dimensions(a), dimensions(b));
const domain = (node) => node.type?.domain || node.type?.module || '';
const standard = (node) => ['', 'ai.onnx'].includes(domain(node));
const fusedAttention = (node) => (standard(node) && node.type.name === 'Attention' && node.type.version >= 23) ||
    (domain(node) === 'com.microsoft' && node.type.version === 1 && ['Attention', 'MultiHeadAttention', 'GroupQueryAttention'].includes(node.type.name));
const pointwise = new Set(['LayerNormalization', 'Transpose', 'Reshape', 'Flatten', 'Squeeze', 'Unsqueeze', 'Cast', 'Identity', 'Conv', 'MatMul', 'Gemm']);
const attentionOps = new Set([...pointwise, 'Softmax', 'Split', 'Concat', 'Slice', 'Expand', 'Tile', 'Add', 'Sub', 'Mul', 'Div', 'Shape', 'Gather']);
const mlpOps = new Set([...pointwise, 'Gelu', 'Relu', 'Swish', 'Sigmoid', 'Mul', 'Add']);
const transforms = new Set(['Transpose', 'Reshape', 'Flatten', 'Squeeze', 'Unsqueeze', 'Cast', 'Identity']);

class StructuralBlocks extends ModuleBlocks {
    constructor(graph, groups, producers, consumers, blocks) {
        super(graph, groups, producers, consumers);
        this.blocks = new Map();
        const add = (block) => {
            if (block.parts) {
                this.blocks.set(`${block.start}:${block.end}`, block.parts);
                block.parts.forEach(add);
            }
        };
        blocks.forEach(add);
    }

    subgraph(indices, name, scope) {
        const graph = super.subgraph(indices, name, scope);
        graph._patternRegion = true;
        const parts = this.blocks.get(`${indices[0]}:${indices.at(-1)}`);
        if (parts && indices.length === indices.at(-1) - indices[0] + 1) {
            const relative = (part) => ({ ...part, start: part.start - indices[0], end: part.end - indices[0],
                ...(part.instances ? { instances: part.instances.map(relative) } : {}), ...(part.parts ? { parts: part.parts.map(relative) } : {}) });
            graph._structuralParts = parts.map(relative);
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
        const groups = graph._structuralParts.map((part, id) => ({ ...group(id, part.title,
            (part.instances || [part]).map((instance, index) => ({ index: instance.index ?? index, scope: '', components: instance.components,
                indices: Uint32Array.from({ length: instance.end - instance.start + 1 }, (_, i) => instance.start + i) })), part.kind), attributes: part.attributes, unit: part.unit }));
        return groups.length && current() ? new StructuralBlocks(graph, groups, producers, consumers, graph._structuralParts) : null;
    }
    const attributeCache = new Map();
    const attributes = (index, pattern = false) => {
        const key = `${index}:${pattern}`;
        if (!attributeCache.has(key)) {
            attributeCache.set(key, patternAttributes(nodes[index], pattern));
        }
        return attributeCache.get(key);
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
                        const square = mean === undefined ? undefined : source(values(nodes[mean].inputs)[0]);
                        const power = square !== undefined && nodes[square].type.name === 'Pow';
                        const x = uncast(data);
                        const dims = dimensions(x);
                        const normWidth = power ? dimensions(output(i))?.at(-1) : dims?.at(-1);
                        const axes = mean === undefined ? null : attributes(mean).get('axes');
                        if (square === undefined || !dims || !Number.isSafeInteger(normWidth) || normWidth <= 1 ||
                            !terms.some(scalarParameter) || !same(dimensions(weight), [normWidth]) ||
                            !['Mul', 'Pow'].includes(nodes[square].type.name) || values(nodes[square].inputs).length !== 2 ||
                            (power ? values(nodes[square].inputs)[0].name !== data.name || !scalarParameter(values(nodes[square].inputs)[1])
                                : !values(nodes[square].inputs).every((value) => value.name === data.name)) ||
                            !same(dimensions(output(mean)), [...dims.slice(0, -1), 1]) || Number(attributes(mean).get('keepdims') ?? 1) !== 1 ||
                            (axes && (axes.length !== 1 || ![-1, dims.length - 1].includes(Number(axes[0])))) ||
                            !(power ? x.type?.dataType === output(i)?.type?.dataType && compatibleShape(dims, dimensions(output(i))) : sameType(x, output(i)))) {
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
                            if (index === undefined || !['Cast', 'Pow', 'Mul', 'ReduceMean', 'Add', 'Sqrt', 'Div', 'Reciprocal'].includes(nodes[index].type.name)) {
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
                            registerNorm({ start, end: i, input: x, output: output(i), title: power ? 'Normalization' : 'RMSNorm', pattern: power });
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
    const projection = (index, pattern = false) => {
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
                output.length !== data.length || data[1] !== dims[1] || output[1] !== dims[0] ||
                !(pattern ? compatibleShape([data[0], ...data.slice(2)], [output[0], ...output.slice(2)])
                    : same([data[0], ...data.slice(2)], [output[0], ...output.slice(2)]))) {
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
            if (!data || !output || data.at(-1) !== inputWidth || output.at(-1) !== outputWidth ||
                !(pattern ? compatibleShape(data.slice(0, -1), output.slice(0, -1)) : same(data.slice(0, -1), output.slice(0, -1))) ||
                (gemm && (data.length !== 2 || Number(attributes(index).get('transA') || 0) !== 0))) {
                return null;
            }
            return { input: inputWidth, output: outputWidth };
        }
        return null;
    };
    const matmul = (index, pattern = false) => {
        const inputs = values(nodes[index].inputs);
        const output = values(nodes[index].outputs)[0];
        const a = dimensions(inputs[0]);
        const b = dimensions(inputs[1]);
        const out = dimensions(output);
        if (!a || !b || !out || a.length < 3 || b.length < 3 || out.length !== Math.max(a.length, b.length) ||
            inputs[0].initializer || inputs[1].initializer || a.at(-1) !== b.at(-2) && !(pattern && compatible(a.at(-1), b.at(-2))) ||
            !(pattern ? compatibleShape(out.slice(-2), [a.at(-2), b.at(-1)]) : same(out.slice(-2), [a.at(-2), b.at(-1)])) ||
            inputs.some((value) => value.type?.dataType !== output.type?.dataType)) {
            return false;
        }
        // MQA broadcasts KV heads; GQA exports may introduce a separate group dimension.
        return out.slice(0, -2).every((dim, i) => {
            const left = a[i - (out.length - a.length)] ?? 1;
            const right = b[i - (out.length - b.length)] ?? 1;
            return (left === right && (pattern ? compatible(dim, left) : dim === left)) ||
                (left === 1 && (pattern ? compatible(dim, right) : dim === right)) ||
                (right === 1 && (pattern ? compatible(dim, left) : dim === left));
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
    const fingerprint = (start, end, pattern = false) => patternSignature(nodes, start, end, (i) => attributes(i, pattern));
    const unrolledOps = new Set([...attentionOps, 'Pow', 'ReduceMean', 'Sqrt', 'Reciprocal', 'Range', 'ConstantOfShape', 'ScatterElements', 'ReduceMin', 'Where', 'Equal']);
    const dataInputs = (node) => {
        const args = values(node.inputs);
        if (['Shape', 'Range', 'ConstantOfShape', 'Equal'].includes(node.type.name)) {
            return [];
        }
        if (node.type.name === 'ScatterElements') {
            return [args[0], args[2]];
        }
        if (node.type.name === 'Where') {
            return args.slice(1);
        }
        return transforms.has(node.type.name) || ['Split', 'Slice', 'Gather', 'ReduceMean', 'ReduceMin'].includes(node.type.name) ? args.slice(0, 1) : args;
    };
    const unrolled = (norm, end, indices, projections, softmax, products) => {
        if (softmax.length < 2 || softmax.length > 128 || products.length !== softmax.length * 2 || projections.length !== 4 ||
            !indices.every((i) => standard(nodes[i]) && unrolledOps.has(nodes[i].type.name)) || !products.every((i) => matmul(i, true))) {
            return null;
        }
        const start = norm.end + 1;
        const trace = (stops) => {
            const result = new Map();
            for (const i of indices) {
                const mask = stops.get(i) ?? dataInputs(nodes[i]).reduce((bits, value) => bits | (result.get(value?.name) || 0n), 0n);
                for (const value of values(nodes[i].outputs)) {
                    result.set(value.name, mask);
                }
            }
            return result;
        };
        const origins = trace(new Map(projections.slice(0, 3).map((item, i) => [item.index, 1n << BigInt(i)])));
        const used = new Set();
        const kv = new Map();
        let roles = null;
        let width = null;
        for (const sm of softmax) {
            const scores = new Set();
            const pending = [values(nodes[sm].inputs)[0]];
            const visited = new Set();
            while (pending.length) {
                const value = pending.pop();
                const i = producers.get(value?.name);
                if (i === undefined || i < start || i >= sm || visited.has(i)) {
                    continue;
                }
                visited.add(i);
                if (products.includes(i)) {
                    scores.add(i);
                } else if (['Mul', 'Div', 'Add', 'Sub', 'Cast', 'Identity', 'Where', 'ReduceMin'].includes(nodes[i].type.name)) {
                    pending.push(...dataInputs(nodes[i]));
                }
            }
            const av = products.filter((i) => follows(values(nodes[i].inputs)[0], output(sm), start, new Set(['Cast', 'Identity'])));
            const axis = Number(attributes(sm).get('axis') ?? (nodes[sm].type.version >= 13 ? -1 : 1));
            if (scores.size !== 1 || av.length !== 1 || ![-1, dimensions(values(nodes[sm].inputs)[0])?.length - 1].includes(axis) ||
                !sameType(values(nodes[sm].inputs)[0], output(sm))) {
                return null;
            }
            const score = [...scores][0];
            if (used.has(score) || used.has(av[0])) {
                return null;
            }
            used.add(score);
            used.add(av[0]);
            const [q, k] = values(nodes[score].inputs);
            const v = values(nodes[av[0]].inputs)[1];
            const currentRoles = [q, k, v].map((value) => origins.get(value.name));
            const d = dimensions(q)?.at(-1);
            if (!Number.isSafeInteger(d) || d <= 0 || dimensions(v)?.at(-1) !== d || !currentRoles.every((mask) => [1n, 2n, 4n].includes(mask)) ||
                new Set(currentRoles).size !== 3 || roles && !same(roles, currentRoles) || width !== null && width !== d) {
                return null;
            }
            roles = currentRoles;
            width = d;
            const key = `${k.name}\n${v.name}`;
            if (!kv.has(key)) {
                for (const [value, sequenceAxis] of [[k, -1], [v, -2]]) {
                    const i = producers.get(value.name);
                    const args = values(nodes[i]?.inputs);
                    const dims = dimensions(value);
                    const axis = Number(i === undefined ? NaN : attributes(i).get('axis') ?? 0);
                    if (i === undefined || nodes[i].type.name !== 'ScatterElements' || !dims || dims.length !== 4 ||
                        (axis < 0 ? axis + dims.length : axis) !== dims.length + sequenceAxis || args.length !== 3 ||
                        !['int32', 'int64'].includes(args[1].type?.dataType) || !compatibleShape(dimensions(args[0]), dims)) {
                        return null;
                    }
                }
                kv.set(key, { products: [] });
            }
            kv.get(key).products.push(av[0]);
        }
        const root = (role) => projections[[1n, 2n, 4n].indexOf(role)];
        if (used.size !== products.length || root(roles[0]).dims.output !== softmax.length * width ||
            root(roles[1]).dims.output !== kv.size * width || root(roles[2]).dims.output !== kv.size * width ||
            projections.at(-1).dims.input !== softmax.length * width ||
            [...kv.values()].some((item) => item.products.length !== softmax.length / kv.size)) {
            return null;
        }
        const merged = trace(new Map([...kv.values()].flatMap((item) => item.products).map((i, bit) => [i, 1n << BigInt(bit)])));
        if (merged.get(values(nodes[projections.at(-1).index].inputs)[0].name) !== (1n << BigInt(softmax.length)) - 1n) {
            return null;
        }
        const splits = indices.filter((i) => nodes[i].type.name === 'Split' && values(nodes[i].outputs).length >= 2 &&
            projections.slice(0, 3).some((item) => follows(values(nodes[i].inputs)[0], output(item.index), start, transforms)));
        const groups = [];
        let cursor = Math.max(start - 1, ...splits) + 1;
        for (const item of kv.values()) {
            const members = new Set();
            const pending = item.products.map(output);
            while (pending.length) {
                const value = pending.pop();
                const i = producers.get(value?.name);
                if (value?.initializer || i === undefined || i < cursor || members.has(i)) {
                    continue;
                }
                members.add(i);
                pending.push(...values(nodes[i].inputs));
            }
            const first = Math.min(...members);
            const last = Math.max(...members);
            if (first !== cursor || members.size !== last - first + 1 || last >= projections.at(-1).index) {
                return null;
            }
            groups.push({ index: groups.length, start: first, end: last, signature: fingerprint(first, last, true), components: [`${item.products.length} query heads`, 'KV cache updates'] });
            cursor = last + 1;
        }
        const parts = [];
        for (let first = 0; first < groups.length;) {
            let last = first + 1;
            while (last < groups.length && groups[last].signature === groups[first].signature) {
                last++;
            }
            parts.push({ title: 'KV groups', kind: 'pattern', unit: 'KV group', start: groups[first].start, end: groups[last - 1].end,
                instances: groups.slice(first, last).map(({ index, start, end, components }) => ({ index, start, end, components })) });
            first = last;
        }
        let variant = 'GQA';
        if (kv.size === 1) {
            variant = 'MQA';
        } else if (kv.size === softmax.length) {
            variant = 'MHA';
        }
        return { title: 'Attention', displayTitle: `Attention (${variant})`, parts,
            mechanism: { kind: variant, implementation: 'unrolled heads', queryHeads: softmax.length, kvHeads: kv.size },
            attributes: [{ name: 'query heads', type: 'int64', value: softmax.length }, { name: 'KV heads', type: 'int64', value: kv.size }] };
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
        const c = dimensions(norm.pattern ? norm.output : input)?.at(-1);
        if (!Number.isSafeInteger(c) || !['float16', 'float32', 'float64', 'bfloat16'].includes(input.type?.dataType)) {
            return null;
        }
        const indices = Array.from({ length: end - start - 1 }, (_, i) => start + i + 1);
        const projections = indices.map((i) => ({ index: i, dims: projection(i, norm.pattern) })).filter((item) => item.dims);
        if (indices.some((i) => ['Conv', 'Gemm'].includes(nodes[i].type.name) && !projection(i, norm.pattern))) {
            return null;
        }
        const softmax = indices.filter((i) => nodes[i].type.name === 'Softmax');
        const products = indices.filter((i) => nodes[i].type.name === 'MatMul' && !projection(i, norm.pattern));
        if (norm.pattern && softmax.length > 1 && projections.slice(0, -1).every((item) => item.dims.input === c &&
            follows(values(nodes[item.index].inputs)[0], norm.output, start, pointwise)) && projections.at(-1)?.dims.output === c) {
            return unrolled(norm, end, indices, projections, softmax, products);
        }
        const cores = indices.filter((i) => fusedAttention(nodes[i]));
        if (!norm.pattern && cores.length === 1 && !softmax.length && !products.length && projections.length >= 1 && projections.length <= 4 &&
            indices.every((i) => attentionOps.has(nodes[i].type.name) || fusedAttention(nodes[i])) &&
            projections.slice(0, -1).every((item) => item.dims.input === c && follows(values(nodes[item.index].inputs)[0], norm.output, start, pointwise)) &&
            projections.at(-1).dims.output === c && fused(cores[0], norm, projections) &&
            follows(values(nodes[projections.at(-1).index].inputs)[0], output(cores[0]), start, attentionOps)) {
            const core = nodes[cores[0]];
            const attrs = attributes(cores[0]);
            const args = values(core.inputs);
            const dims = dimensions(args[0]);
            const queryHeads = Number(attrs.get('q_num_heads') ?? attrs.get('num_heads') ?? dims[1]);
            const kvHeads = core.type.name === 'Attention' && domain(core) === 'com.microsoft' ? queryHeads
                : Number(attrs.get('kv_num_heads') ?? (dims.length === 4 ? dimensions(args[1])[1] : queryHeads));
            let kind = 'GQA';
            if (kvHeads === queryHeads) {
                kind = 'MHA';
            } else if (kvHeads === 1) {
                kind = 'MQA';
            }
            return { title: 'Attention', mechanism: { kind, implementation: 'fused', queryHeads, kvHeads } };
        }
        if (!norm.pattern && softmax.length === 1 && products.length === 2 && projections.length >= 2 && projections.length <= 4 &&
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
                const query = dimensions(values(nodes[products[0]].inputs)[0]);
                const key = dimensions(values(nodes[products[0]].inputs)[1]);
                // Only report head sharing for direct rank-4 layouts without KV repetition.
                // Expand/Tile lowerings need provenance before their KV count can be named.
                let kind = 'SDPA';
                const mechanism = { kind, implementation: 'explicit' };
                if (query.length === 4 && key.length >= 3 && key.length <= 4 &&
                    !indices.some((i) => ['Expand', 'Tile'].includes(nodes[i].type.name))) {
                    const queryHeads = query[1];
                    const kvHeads = key.length === 3 ? 1 : key[1];
                    if (Number.isSafeInteger(queryHeads) && Number.isSafeInteger(kvHeads) && kvHeads > 0 && queryHeads % kvHeads === 0) {
                        if (queryHeads === kvHeads) {
                            kind = 'MHA';
                        } else if (kvHeads === 1) {
                            kind = 'MQA';
                        } else {
                            kind = 'GQA';
                        }
                        Object.assign(mechanism, { kind, queryHeads, kvHeads });
                    }
                }
                return { title: 'Attention', mechanism };
            }
        }
        const activations = indices.filter((i) => ['Gelu', 'Relu', 'Swish', 'Sigmoid'].includes(nodes[i].type.name))
            .map((i) => ({ index: i, input: values(nodes[i].inputs)[0], output: output(i),
                kind: new Map([['Gelu', 'GELU'], ['Relu', 'ReLU'], ['Swish', 'SiLU'], ['Sigmoid', 'Sigmoid']]).get(nodes[i].type.name) }));
        for (const activation of [...activations]) {
            if (nodes[activation.index].type.name === 'Sigmoid') {
                for (const i of consumers.get(activation.output.name) || []) {
                    const args = values(nodes[i]?.inputs);
                    if (i > start && i < end && nodes[i].type.name === 'Mul' && args.length === 2 &&
                        args.some((value) => value.name === activation.input.name) && args.every((value) => value.type?.dataType === output(i)?.type?.dataType &&
                            (norm.pattern ? compatibleShape(dimensions(value), dimensions(output(i))) : sameType(value, output(i))))) {
                        activations.push({ index: i, input: activation.input, output: output(i), kind: 'SiLU' });
                    }
                }
            }
        }
        if (projections.length === 2 && indices.every((i) => mlpOps.has(nodes[i].type.name))) {
            const [first, last] = projections;
            const activation = activations.find((item) => follows(item.input, output(first.index), start, transforms) &&
                follows(values(nodes[last.index].inputs)[0], item.output, start, transforms));
            if (first.dims.input === c && first.dims.output > c && last.dims.input === first.dims.output && last.dims.output === c &&
                follows(values(nodes[first.index].inputs)[0], norm.output, start, pointwise) &&
                activation) {
                return { title: 'MLP', feedforward: { kind: `${activation.kind} MLP`, gated: false,
                    hiddenWidth: c, intermediateWidth: first.dims.output } };
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
                            if (args.length === 2 && args.every((value) => value.type?.dataType === output(i)?.type?.dataType &&
                                (norm.pattern ? compatibleShape(dimensions(value), dimensions(output(i))) : sameType(value, output(i)))) &&
                                args.some((value) => follows(value, activation.output, start, transforms)) &&
                                args.some((value) => follows(value, output(up.index), start, transforms)) &&
                                follows(values(nodes[last.index].inputs)[0], output(i), start, transforms)) {
                                const kind = new Map([['GELU', 'GEGLU'], ['SiLU', 'SwiGLU'], ['Sigmoid', 'GLU'], ['ReLU', 'ReGLU']]).get(activation.kind);
                                return { title: 'MLP', feedforward: { kind, gated: true, hiddenWidth: c, intermediateWidth: first.dims.output } };
                            }
                        }
                    }
                }
            }
        }
        return null;
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
        if (node.type?.name !== 'Add' || inputs.length !== 2 || inputs.some((value) => value.initializer)) {
            continue;
        }
        for (let slot = 0; slot < 2; slot++) {
            const input = inputs[slot];
            for (const norm of norms.get(input.name) || []) {
                if (!inputs.every((value) => value.type?.dataType === output?.type?.dataType &&
                    (norm.pattern ? compatibleShape(dimensions(value), dimensions(output)) : sameType(value, output)))) {
                    continue;
                }
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
                    const match = classify(norm, end, input);
                    if (match && nodes.slice(start, end + 1).every((item) => standard(item) || fusedAttention(item))) {
                        const detail = typeof match === 'string' ? { title: match } : match;
                        residuals.push({ start, end, ...detail, norm, input: input.name, output: output.name });
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
                const pattern = attention.norm.pattern || mlp.norm.pattern;
                const signature = fingerprint(attention.start, mlp.end, pattern);
                if (!signatures.has(signature)) {
                    signatures.set(signature, signature);
                }
                blocks.push({ start: attention.start, end: mlp.end, input: attention.input, output: mlp.output,
                    pattern, signature: signatures.get(signature), profile: architectureProfile(attention, mlp),
                    parts: [attention, mlp].flatMap((part) => [
                        ...(part.norm.end > part.norm.start ? [{ title: part.norm.title, start: part.norm.start, end: part.norm.end, kind: pattern ? 'pattern' : 'structural' }] : []),
                        { title: part.displayTitle || part.title, start: part.norm.end + 1, end: part.end - 1,
                            parts: part.parts, attributes: part.attributes, kind: pattern ? 'pattern' : 'structural' }
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
        while (end < blocks.length && blocks[end].start === blocks[end - 1].end + 1 &&
            blocks[end].input === blocks[end - 1].output && blocks[end].signature === blocks[start].signature) {
            end++;
        }
        const instances = blocks.slice(start, end).map((block, i) => ({ index: start + i, scope: '', components: ['Attention', 'MLP'], profile: block.profile,
            indices: Uint32Array.from({ length: block.end - block.start + 1 }, (_, j) => block.start + j) }));
        groups.push(group(groups.length, blocks[start].pattern ? 'Decoder blocks' : 'Transformer blocks', instances,
            blocks[start].pattern ? 'pattern' : 'structural'));
        start = end;
    }
    return groups.length && current() ? new StructuralBlocks(graph, groups, producers, consumers, blocks) : null;
};
