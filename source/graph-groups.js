import { NodeCatalog, nodeCatalog, nodeDescriptions, overlay } from './repeated-blocks.js';

const values = (args) => (args || []).flatMap((arg) => Array.isArray(arg.value) ? arg.value : []);
const inputs = (node) => [...values(node.inputs), ...(node.controlDependencies || [])];
const outputs = (node) => values(node.chain?.at(-1)?.outputs?.length ? node.chain.at(-1).outputs : node.outputs);

export class GraphGroups {
    constructor(graph, nodes, root, groups, producers, consumers) {
        Object.assign(this, { graph, nodes, root, groups, producers, consumers });
    }

    boundary(group) {
        if (!group.boundary) {
            const members = new Set(group.members);
            const incoming = new Map();
            const outgoing = new Map();
            const controls = new Map();
            for (const index of group.members) {
                const node = this.nodes[index];
                for (const value of values(node.inputs)) {
                    if (value?.name && !value.initializer && !members.has(this.producers.get(value.name))) {
                        incoming.set(value.name, value);
                    }
                }
                for (const value of node.controlDependencies || []) {
                    if (value?.name && !members.has(this.producers.get(value.name))) {
                        controls.set(value.name, value);
                    }
                }
                for (const value of outputs(node)) {
                    if (value?.name && this.consumers.get(value.name)?.some((index) => !members.has(index))) {
                        outgoing.set(value.name, value);
                    }
                }
            }
            const args = (map) => Array.from(map, ([name, value]) => ({ name, value: [value] }));
            group.boundary = { inputs: args(incoming), outputs: args(outgoing), controlDependencies: [...controls.values()] };
        }
        return group.boundary;
    }

    ancestors(value) {
        const names = new Set([value?.name, ...values([value]).map((item) => item?.name)].filter(Boolean));
        const index = this.nodes.findIndex((node) => names.has(node.name) ||
            [...inputs(node), ...outputs(node)].some((item) => names.has(item?.name)));
        const ancestors = [];
        let group = this.parents[index];
        while (group && group !== this.root) {
            ancestors.push(group);
            group = group.parent;
        }
        return ancestors;
    }

    project(expanded = new Set()) {
        const containers = new Map();
        const visible = new Map();
        const owners = new Map();
        const visit = (entry, parent) => {
            if (entry.children) {
                if (expanded.has(entry.id) || entry.unsafe) {
                    containers.set(entry.id, { group: entry, parent });
                    for (const child of entry.children) {
                        visit(child, entry.id);
                    }
                } else {
                    for (const index of entry.members) {
                        owners.set(index, entry);
                    }
                    visible.set(entry.members[0], { summary: { name: entry.id, type: { name: entry.label, category: 'Layer' },
                        group: parent, ...this.boundary(entry), attributes: [], _hierarchyGroup: entry } });
                }
            } else {
                owners.set(entry.index, entry.index);
                visible.set(entry.index, { index: entry.index, parent });
            }
        };
        for (const entry of this.root.children) {
            visit(entry, '');
        }

        // A scope can leave and re-enter itself; collapsing it must not invent a cycle.
        const edges = new Map();
        for (const owner of owners.values()) {
            if (!edges.has(owner)) {
                edges.set(owner, new Set());
            }
        }
        const degrees = new Map([...edges.keys()].map((owner) => [owner, 0]));
        this.nodes.forEach((node, index) => {
            const to = owners.get(index);
            for (const value of inputs(node)) {
                const from = owners.get(this.producers.get(value?.name));
                if (from !== undefined && from !== to && !edges.get(from).has(to)) {
                    edges.get(from).add(to);
                    degrees.set(to, degrees.get(to) + 1);
                }
            }
        });
        const queue = [...degrees.keys()].filter((owner) => degrees.get(owner) === 0);
        for (let cursor = 0; cursor < queue.length; cursor++) {
            for (const to of edges.get(queue[cursor])) {
                degrees.set(to, degrees.get(to) - 1);
                if (degrees.get(to) === 0) {
                    queue.push(to);
                }
            }
        }
        const unsafe = [...degrees.keys()].filter((owner) => typeof owner !== 'number' && degrees.get(owner) > 0);
        if (unsafe.length) {
            for (const group of unsafe) {
                group.unsafe = true;
                expanded.add(group.id);
            }
            return this.project(expanded);
        }

        const catalog = nodeCatalog(this.graph.nodes);
        const records = [];
        for (let index = 0; index < this.nodes.length; index++) {
            if (visible.has(index)) {
                records.push(visible.get(index));
            }
        }
        const decorate = (node, record) => overlay(node, { group: record.parent, _originalNode: node });
        const nodes = new NodeCatalog(records,
            (record) => record.summary || decorate(this.graph.nodes[record.index], record),
            (record) => record.summary || decorate(this.nodes[record.index], record),
            () => catalog?.release(), (index) => {
                if (records[index].index !== undefined) {
                    catalog?.evict(records[index].index);
                }
            }).nodes;
        return overlay(this.graph, { nodes, groups: true, _hierarchy: this, _groupContainers: containers });
    }
}

export const graphGroups = async (graph, current = () => true) => {
    const nodes = [];
    const producers = new Map();
    const consumers = new Map();
    const groups = new Map();
    const root = { id: '', children: [] };
    const groupFor = (scope) => {
        let parent = root;
        for (const label of scope.split('/').filter(Boolean)) {
            const id = `${parent.id}/${label}`;
            if (!groups.has(id)) {
                const group = { id, label, parent, children: [], members: [] };
                groups.set(id, group);
                parent.children.push(group);
            }
            parent = groups.get(id);
        }
        return parent;
    };
    let deadline = Date.now() + 8;
    for (const node of nodeDescriptions(graph)) {
        if (!current()) {
            return null;
        }
        const index = nodes.length;
        nodes.push(node);
        let scope = '';
        const exportedScope = node._scope;
        if (typeof node.group === 'string') {
            scope = node.group;
        } else if (typeof exportedScope === 'string') {
            scope = exportedScope;
        } else if (typeof node.name === 'string' && node.name.includes('/')) {
            scope = node.name.slice(0, node.name.lastIndexOf('/'));
        }
        let parent = groupFor(scope);
        parent.children.push({ index });
        while (parent !== root) {
            parent.members.push(index);
            parent = parent.parent;
        }
        for (const value of outputs(node)) {
            if (value?.name) {
                if (producers.has(value.name)) {
                    return null;
                }
                producers.set(value.name, index);
            }
        }
        for (const value of inputs(node)) {
            if (value?.name && !value.initializer) {
                if (!consumers.has(value.name)) {
                    consumers.set(value.name, []);
                }
                consumers.get(value.name).push(index);
            }
        }
        if (Date.now() >= deadline) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });
            deadline = Date.now() + 8;
        }
    }
    for (const value of values(graph.outputs)) {
        if (!consumers.has(value.name)) {
            consumers.set(value.name, []);
        }
        consumers.get(value.name).push(-1);
    }
    // Single-child wrappers add no useful level to the hierarchy.
    for (const parent of [...groups.values()].reverse().concat(root)) {
        parent.children = parent.children.map((entry) => {
            if (entry.children?.length === 1) {
                const child = entry.children[0];
                if (child.children) {
                    child.parent = parent;
                }
                groups.delete(entry.id);
                return child;
            }
            return entry;
        });
    }
    if (!groups.size && current()) {
        const { architectureBlocks } = await import('./architecture-blocks.js');
        const analysis = await architectureBlocks(graph, current);
        if (analysis && current()) {
            const claimed = new Map();
            for (const detected of analysis.groups) {
                for (const block of detected.blocks) {
                    if (block.indices.length < 2) {
                        continue;
                    }
                    const group = { id: `/@${block.indices[0]}`, label: `${detected.title} ${block.index}`, parent: root,
                        children: Array.from(block.indices, (index) => ({ index })), members: [...block.indices] };
                    groups.set(group.id, group);
                    for (const index of block.indices) {
                        claimed.set(index, group);
                    }
                }
            }
            root.children.splice(0);
            for (let index = 0; index < nodes.length; index++) {
                const group = claimed.get(index);
                if (!group) {
                    root.children.push({ index });
                } else if (index === group.members[0]) {
                    root.children.push(group);
                }
            }
        }
    }
    if (!groups.size || !current()) {
        return null;
    }
    const result = new GraphGroups(graph, nodes, root, groups, producers, consumers);
    result.parents = new Array(nodes.length);
    const assign = (group) => {
        for (const child of group.children) {
            if (child.children) {
                assign(child);
            } else {
                result.parents[child.index] = group;
            }
        }
    };
    assign(root);
    return result;
};
