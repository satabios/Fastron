// Schematic summaries use descriptors and tensor metadata, never parameter data.
const values = (args) => (args || []).flatMap((arg) => arg.value || []).filter(Boolean);
const operator = (node) => node.type.name.split(/[.:]/).pop();
const shape = (value) => value?.type?.shape?.dimensions || [];

const anatomy = (nodes, parts = []) => {
    const producers = new Map();
    nodes.forEach((node, i) => values(node.outputs).forEach((value) => producers.set(value.name, i)));
    const zones = [];
    const consumers = new Map();
    let start = 0;
    const append = (end, residual = false) => {
        const members = nodes.slice(start, end + 1);
        const ops = [...new Set(members.map(operator))];
        const known = parts.find((part) => part.start >= start && part.end <= end && /^(Attention|MLP)/.test(part.title));
        const attention = known?.title.startsWith('Attention') || ops.some((op) => /^(Softmax|.*Attention)$/i.test(op));
        const mlp = known?.title === 'MLP' || (!attention && members.filter((node) => /^(MatMul|Gemm|FullyConnected)$/i.test(operator(node))).length >= 2 &&
            ops.some((op) => /^(Silu|Swish|Gelu|Relu|Sigmoid|ElementWiseNeuron)$/i.test(op)));
        let title = 'Operations';
        let kind = 'operations';
        if (attention) {
            title = 'Attention';
            kind = 'attention';
        } else if (mlp) {
            title = 'Feed-forward / MLP';
            kind = 'mlp';
        }
        zones.push({ title, kind, ops, residual, count: members.length });
        start = end + 1;
    };
    nodes.forEach((node, i) => {
        const inputs = values(node.inputs).filter((value) => !value.initializer);
        if (/^(Add|ElementWiseAdd)$/i.test(operator(node)) && inputs.length === 2) {
            const bypass = inputs.find((value) => (producers.get(value.name) ?? -1) < start && consumers.get(value.name) >= start);
            const branch = inputs.find((value) => producers.get(value.name) >= start && producers.get(value.name) < i);
            // Verify a directed path from the bypass tensor through the branch.
            const pending = bypass && branch ? [branch.name] : [];
            const visited = new Set();
            while (pending.length) {
                const name = pending.pop();
                if (name === bypass.name) {
                    append(i, true);
                    break;
                }
                const source = producers.get(name);
                if (source >= start && source < i && !visited.has(source)) {
                    visited.add(source);
                    pending.push(...values(nodes[source].inputs).filter((value) => !value.initializer).map((value) => value.name));
                }
            }
        }
        inputs.forEach((value) => consumers.set(value.name, i));
    });
    if (start < nodes.length) {
        append(nodes.length - 1);
    }
    return zones;
};

export const stackSchematic = (analysis, group, selected = 0) => {
    const block = group.blocks[selected];
    const parts = group.presentation?.compound ? group.presentation.parts : [{ start: 0, end: block.indices.length, count: 1 }];
    const regions = parts.map((part) => {
        const indices = block.indices.slice(part.start, part.start + (part.end - part.start) / part.count);
        const nodes = Array.from(indices, (index) => analysis.describe(index));
        const known = group.architecture ? analysis.blocks?.get(`${indices[0]}:${indices.at(-1)}`) || [] : [];
        const zones = known.map((zone) => ({ ...zone, start: zone.start - indices[0], end: zone.end - indices[0] }));
        const details = anatomy(nodes, zones);
        for (const zone of details) {
            if (block.profile && zone.kind === 'attention') {
                zone.title = `Attention (${block.profile.attention.kind})`;
            } else if (block.profile && zone.kind === 'mlp') {
                zone.title = block.profile.feedforward.kind;
            }
        }
        return { count: part.count, indices, zones: details, operators: nodes.length };
    });
    const nodes = Array.from(block.indices, (index) => analysis.describe(index));
    const outputs = values(nodes.at(-1)?.outputs).filter((value) => !value.initializer);
    const precisions = [...new Set(nodes.flatMap((node) => values(node.outputs).map((value) => value.type?.dataType)).filter(Boolean))];
    return { count: group.blocks.length, selected: block.index, operators: block.indices.length,
        layerMix: group.presentation?.total || `${group.blocks.length} repeated instances`,
        outputShapes: outputs.map(shape).filter((dims) => dims.length).map((dims) => `[${dims.join(', ')}]`),
        precision: precisions.join(', ') || 'Unknown', regions };
};

export const renderStackSchematic = (document, schematic, inspect) => {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    const element = (tag, attrs, text, parent = svg) => {
        const child = document.createElementNS(ns, tag);
        for (const [key, value] of Object.entries(attrs)) {
            child.setAttribute(key, String(value));
        }
        if (text !== undefined) {
            child.textContent = text;
        }
        parent.appendChild(child);
        return child;
    };
    const height = 60 + schematic.regions.reduce((sum, region) => sum + 62 + Math.min(region.zones.length, 6) * 74, 0);
    svg.setAttribute('viewBox', `0 0 360 ${height}`);
    svg.setAttribute('class', 'stack-schematic');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', `Representative block anatomy, repeated ${schematic.count} times`);
    element('title', {}, `Instance ${schematic.selected}: ${schematic.operators} operators. Semantic summaries inferred from operators; open a region to inspect exact connections.`);
    element('rect', { x: 8, y: 8, width: 294, height: height - 16, rx: 12, class: 'stack-schematic-frame' });
    element('text', { x: 20, y: 31, class: 'stack-schematic-heading' }, 'REPRESENTATIVE ANATOMY');
    element('path', { d: `M310 16 h8 v${height - 32} h-8`, class: 'stack-schematic-wire' });
    element('text', { x: 324, y: 38, class: 'stack-schematic-heading' }, `×${schematic.count}`);
    let y = 48;
    schematic.regions.forEach((region, index) => {
        const count = Math.min(region.zones.length, 6);
        element('rect', { x: 18, y, width: 274, height: 48 + count * 74, rx: 8, class: 'stack-schematic-region' });
        element('text', { x: 30, y: y + 22 }, `${region.operators} ops${region.count > 1 ? ` · ×${region.count} per stage` : ''}`);
        const button = element('g', { role: 'button', tabindex: 0, 'aria-label': `Inspect region ${index + 1}`, class: 'stack-schematic-inspect' });
        element('rect', { x: 225, y: y + 7, width: 57, height: 24, rx: 4 }, undefined, button);
        element('text', { x: 231, y: y + 23 }, 'Inspect', button);
        button.addEventListener('click', () => inspect(region.indices));
        button.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                inspect(region.indices);
            }
        });
        for (let i = 0; i < count; i++) {
            const zone = region.zones[i];
            const more = i === 5 && region.zones.length > 6;
            const top = y + 36 + i * 74;
            element('rect', { x: 72, y: top, width: 208, height: 56, rx: 7, class: `stack-schematic-zone stack-schematic-${zone.kind}` });
            element('text', { x: 82, y: top + 20, class: 'stack-schematic-heading' }, more ? `${region.zones.length - 5} more zones` : zone.title);
            const summary = zone.ops.join(' · ');
            const preview = summary.length > 27 ? `${summary.slice(0, 26)}…` : summary;
            const label = element('text', { x: 82, y: top + 39 }, more ? 'Inspect for full anatomy' : preview);
            element('title', {}, summary, label);
            if (zone.residual && !more) {
                element('path', { d: `M44 ${top} V${top + 64} M44 ${top + 8} H72 M176 ${top + 56} V${top + 64} H44`, class: 'stack-schematic-wire' });
                element('circle', { cx: 44, cy: top + 64, r: 8, class: 'stack-schematic-merge' });
                element('text', { x: 40, y: top + 68 }, '+');
            }
        }
        y += 62 + count * 74;
    });
    return svg;
};
