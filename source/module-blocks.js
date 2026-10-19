import { NodeCatalog, nodeCatalog, nodeDescriptions, overlay } from './repeated-blocks.js';

const values = (args) => (args || []).flatMap((arg) => arg?.value || []);
const pathOf = (name) => name.match(/^(.*?(?:^|[./])(?:layers?|blocks?|blk|h)[./])(0|[1-9][0-9]*)(?:[./]|$)/);

export const repeatGroup = (group) => group._repeatParent || group;

export const repeatSelection = (group, selected) => {
    const index = (selected.get(group.id) || 0) - (group._repeatOffset || 0);
    return index >= 0 && index < group.blocks.length ? index : 0;
};

export class ModuleBlocks {
    canExpandInline(group) {
        let cursor = group.anchor;
        for (const block of group.blocks) {
            for (const index of block.indices) {
                if (index !== cursor++) {
                    return false;
                }
            }
        }
        return cursor === group.members.at(-1) + 1;
    }

    constructor(graph, groups, producers, consumers) {
        this.graph = graph;
        this.groups = groups;
        this.producers = producers;
        this.consumers = consumers;
    }

    describe(index) {
        const catalog = nodeCatalog(this.graph.nodes);
        return catalog ? catalog.describe(catalog.records[index]) : this.graph.nodes[index];
    }

    subgraph(indices, name, scope) {
        const members = new Set(indices);
        const inputs = new Map();
        const outputs = new Map();
        for (const index of indices) {
            const node = this.describe(index);
            for (const value of values(node.inputs)) {
                if (value?.name && !value.initializer && !members.has(this.producers.get(value.name))) {
                    inputs.set(value.name, value);
                }
            }
            for (const value of values(node.outputs)) {
                if (value?.name && this.consumers.get(value.name)?.some((consumer) => !members.has(consumer))) {
                    outputs.set(value.name, value);
                }
            }
        }
        const catalog = nodeCatalog(this.graph.nodes);
        const nodes = new NodeCatalog(indices, (index) => this.graph.nodes[index], (index) => this.describe(index),
            () => catalog?.release(), (index) => catalog?.evict(indices[index])).nodes;
        const args = (map) => Array.from(map, ([name, value]) => ({ name, value: [value] }));
        return { name, nodes, inputs: args(inputs), outputs: args(outputs), _moduleScope: scope };
    }

    locate(value) {
        const names = new Set([value?.name, ...values([value]).map((item) => item?.name)].filter(Boolean));
        for (const group of this.groups) {
            for (let index = 0; index < group.blocks.length; index++) {
                for (const i of group.blocks[index].indices) {
                    const node = this.describe(i);
                    if (names.has(node.name) || [...values(node.inputs), ...values(node.outputs)].some((item) => names.has(item?.name))) {
                        return { group, index };
                    }
                }
            }
        }
        return null;
    }

    project(selected = new Map(), expanded = new Set(), inlineExpanded = new Map()) {
        const records = [];
        const summary = (group) => {
            const block = group.blocks[repeatSelection(group, selected)];
            const detail = this.subgraph(block.indices, group.label, block.scope);
            const boundary = this.subgraph(group.members, group.label, group.scope);
            records.push({ summary: { name: `${group.scope || 'Graph operations'}#${group.anchor}`,
                type: { ...detail, name: group.title, type: 'function' }, inputs: boundary.inputs, outputs: boundary.outputs,
                attributes: [{ name: 'operators', type: 'int64', value: group.members.length }, ...(group.attributes || [])],
                _repeatHeader: group.blocks.length > 1 || Boolean(group._repeatParent), _repeatGroup: group } });
        };
        const run = (group, start, end) => {
            const blocks = group.blocks.slice(start, end);
            const members = Uint32Array.from(blocks.flatMap((block) => [...block.indices]));
            const presentation = group.presentation ? { ...group.presentation,
                ranges: group.presentation.ranges.slice(start, end),
                ...(group.presentation.indices ? { indices: group.presentation.ranges.slice(start, end).flat() } : {}),
                ...(group.presentation.blockIndices ? { blockIndices: group.presentation.blockIndices.slice(start, end) } : {}) } : undefined;
            summary({ ...group, blocks, members, anchor: members[0], presentation, _repeatParent: group, _repeatOffset: start });
        };
        let cursor = 0;
        for (const group of this.groups) {
            while (cursor < group.anchor) {
                records.push({ index: cursor++ });
            }
            if (expanded.has(group.id)) {
                for (const index of group.members) {
                    records.push({ index, group: index === group.anchor ? group : null });
                }
            } else {
                const inline = this.canExpandInline(group) ? inlineExpanded.get(group.id) : null;
                if (inline?.size) {
                    let start = 0;
                    for (let i = 0; i < group.blocks.length; i++) {
                        if (inline.has(i)) {
                            if (start < i) {
                                run(group, start, i);
                            }
                            for (const index of group.blocks[i].indices) {
                                records.push({ index, group: index === group.blocks[i].indices[0] ? group : null, inline: i });
                            }
                            start = i + 1;
                        }
                    }
                    if (start < group.blocks.length) {
                        run(group, start, group.blocks.length);
                    }
                } else {
                    summary(group);
                }
            }
            cursor = group.members.at(-1) + 1;
        }
        while (cursor < this.graph.nodes.length) {
            records.push({ index: cursor++ });
        }
        const decorate = (node, record) => record.group ? overlay(node, { _originalNode: node, _repeatGroup: record.group,
            ...(Number.isInteger(record.inline) ? { _repeatInlineIndex: record.inline } : { _repeatHeader: record.group.blocks.length > 1 }) }) : node;
        const catalog = nodeCatalog(this.graph.nodes);
        const nodes = new NodeCatalog(records, (record) => record.summary || decorate(this.graph.nodes[record.index], record),
            (record) => record.summary || decorate(this.describe(record.index), record), () => catalog?.release(),
            (index) => {
                if (records[index].index !== undefined) {
                    catalog?.evict(records[index].index);
                }
            }).nodes;
        const bundle = (args, name) => {
            const visible = (args || []).filter((arg) => arg.visible !== false);
            return visible.length > 1 ? [{ name: `${name} (${values(visible).length} tensors)`, value: values(visible) }] : visible;
        };
        return overlay(this.graph, { nodes, groups: false, inputs: bundle(this.graph.inputs, 'Inputs'),
            outputs: bundle(this.graph.outputs, 'Outputs'), _originalGraph: this.graph });
    }
}

// Scope grouping counts exported modules; it does not assert that their operations or weights are identical.
export const moduleBlocks = async (graph, current = () => true) => {
    if (!current()) {
        return null;
    }
    const nodes = Array.from(nodeDescriptions(graph));
    const scope = graph._moduleScope || '';
    if (!scope && nodes.every((node) => !node.outputs?.length)) {
        return null;
    }
    const paths = nodes.map((node) => {
        const name = node.name || '';
        const relative = scope && (name.startsWith(`${scope}/`) || name.startsWith(`${scope}.`)) ? name.slice(scope.length + 1) : name;
        const match = pathOf(relative);
        if (match && Number.isSafeInteger(Number(match[2]))) {
            const prefix = `${scope ? `${scope}/` : ''}${match[1]}`;
            return { key: prefix, index: Number(match[2]), scope: `${prefix}${match[2]}` };
        }
        const separator = scope ? relative.search(/[./]/) : -1;
        if (separator > 0) {
            const child = name.slice(0, name.length - relative.length + separator);
            return { key: child, scope: child };
        }
        return { key: '' };
    });
    const families = new Map();
    for (const path of paths) {
        if (path.index !== undefined) {
            if (!families.has(path.key)) {
                families.set(path.key, new Set());
            }
            families.get(path.key).add(path.index);
        }
    }
    if (!scope && !Array.from(families.values()).some((indices) => indices.size > 1)) {
        return null;
    }
    const producers = new Map();
    const consumers = new Map();
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i]._hasSubgraphs || nodes[i].type?.nodes || nodes[i].chain?.length || nodes[i].blocks?.length ||
            nodes[i].nodes?.length || nodes[i].inner || nodes[i].controlDependencies?.length) {
            return null;
        }
        for (const value of values(nodes[i].outputs)) {
            if (value?.name) {
                if (producers.has(value.name)) {
                    return null;
                }
                producers.set(value.name, i);
            }
        }
    }
    let deadline = Date.now() + 8;
    for (let i = 0; i < nodes.length; i++) {
        for (const value of values(nodes[i].inputs)) {
            if (value?.name && !value.initializer) {
                // Contiguous groups preserve the DAG only when the source order is topological.
                if (producers.has(value.name) && producers.get(value.name) >= i) {
                    return null;
                }
                if (!consumers.has(value.name)) {
                    consumers.set(value.name, []);
                }
                consumers.get(value.name).push(i);
            }
        }
        if (i % 256 === 0 && Date.now() >= deadline) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });
            deadline = Date.now() + 8;
        }
        if (!current()) {
            return null;
        }
    }
    for (const value of values(graph.outputs)) {
        if (!consumers.has(value.name)) {
            consumers.set(value.name, []);
        }
        consumers.get(value.name).push(-1);
    }
    const groups = [];
    for (let start = 0; start < nodes.length;) {
        let end = start + 1;
        while (end < nodes.length && paths[end].key === paths[start].key) {
            end++;
        }
        if (paths[start].index !== undefined || (scope && paths[start].key && end - start > 1)) {
            const blocks = new Map();
            for (let i = start; i < end; i++) {
                const path = paths[i];
                const index = path.index ?? 0;
                if (!blocks.has(index)) {
                    blocks.set(index, { index, scope: path.scope, indices: [] });
                }
                blocks.get(index).indices.push(i);
            }
            if (paths[start].index !== undefined && blocks.size < 2) {
                start = end;
                continue;
            }
            const path = paths[start];
            const label = scope ? path.key.slice(scope.length + 1) : path.key.replace(/^\/model\//, '');
            const parts = label.replace(/[./]+$/, '').split(/[./]/).filter(Boolean);
            const title = scope ? parts.at(-1) : parts.slice(-2).join(' ');
            const description = path.index === undefined ? path.key : `${path.key} (${blocks.size} modules)`;
            groups.push({ id: groups.length, kind: 'module', title, label: description,
                scope: path.key.replace(/[./]+$/, ''), anchor: start, members: Uint32Array.from({ length: end - start }, (_, i) => start + i),
                blocks: Array.from(blocks.values(), (block) => ({ ...block, indices: Uint32Array.from(block.indices) })) });
        }
        start = end;
    }
    return groups.length && current() ? new ModuleBlocks(graph, groups, producers, consumers) : null;
};
