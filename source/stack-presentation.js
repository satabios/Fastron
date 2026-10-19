// Source paths annotate verified matches; they never participate in recognition.
const sourceIndices = (analysis, indices) => {
    const families = new Map();
    for (const index of indices) {
        const name = analysis.describe(index).name || '';
        for (const match of name.matchAll(/(^|[./])([^./]+)[./](0|[1-9][0-9]*)(?=[./]|$)/g)) {
            if (!Number.isSafeInteger(Number(match[3]))) {
                continue;
            }
            const key = name.slice(0, match.index) + match[1] + match[2];
            if (!families.has(key)) {
                families.set(key, new Set());
            }
            families.get(key).add(Number(match[3]));
        }
    }
    return families;
};

export const stackPresentation = async (analysis, current = () => true) => {
    const { patternBlocks } = await import('./pattern-blocks.js');
    const presentations = [];
    let budget = 8192;
    for (const group of analysis.groups) {
        if (!current()) {
            return;
        }
        if (group.kind !== 'pattern' || group.blocks.length < 2) {
            continue;
        }
        const first = group.blocks[0];
        let children = null;
        // shortcut: preview one nesting level within an 8,192-operator budget; deeper details open on demand.
        if (first.indices.length <= budget) {
            budget -= first.indices.length;
            // eslint-disable-next-line no-await-in-loop
            children = await patternBlocks(analysis.subgraph(first.indices, group.title, ''), current);
        }
        const repeats = children?.groups.filter((child) => child.blocks.length > 1) || [];
        const parts = [];
        let cursor = 0;
        for (const child of repeats) {
            if (cursor < child.anchor) {
                parts.push({ start: cursor, end: child.anchor, count: 1 });
            }
            parts.push({ start: child.anchor, end: child.members.at(-1) + 1, count: child.blocks.length });
            cursor = child.members.at(-1) + 1;
        }
        if (cursor < first.indices.length) {
            parts.push({ start: cursor, end: first.indices.length, count: 1 });
        }
        if (parts.length > 8) {
            continue;
        }
        const compound = repeats.length > 0;
        const presentation = { compound, parts: compound ? parts : [], ranges: [], group };
        const leaves = compound ? parts.filter((part) => part.count > 1) : [{ start: 0, end: first.indices.length, count: 1 }];
        const sources = group.blocks.flatMap((block) => leaves.flatMap((part) => {
            const width = (part.end - part.start) / part.count;
            return Array.from({ length: part.count }, (_, i) => sourceIndices(analysis,
                block.indices.slice(part.start + i * width, part.start + (i + 1) * width)));
        }));
        const candidates = [...(sources[0] || [])].filter(([key]) => {
            const ids = sources.map((source) => source.get(key));
            return ids.every((indices) => indices?.size === 1) && new Set(ids.map((indices) => [...indices][0])).size === ids.length;
        }).sort((a, b) => a[0].length - b[0].length);
        if (candidates.length) {
            const key = candidates[0][0];
            const perStage = sources.length / group.blocks.length;
            presentation.family = key;
            presentation.label = key.split(/[./]/).filter(Boolean).at(-1);
            presentation.indices = sources.map((source) => [...source.get(key)][0]);
            for (let i = 0; i < group.blocks.length; i++) {
                presentation.ranges.push(presentation.indices.slice(i * perStage, (i + 1) * perStage));
            }
        }
        for (const part of presentation.parts) {
            part.operators = (part.end - part.start) / part.count;
            const outputs = new Set();
            for (let i = part.start; i < part.end; i++) {
                for (const arg of analysis.describe(first.indices[i]).outputs || []) {
                    for (const value of arg.value || []) {
                        outputs.add(value.name);
                    }
                }
            }
            const next = parts[parts.indexOf(part) + 1];
            part.linked = Boolean(next && Array.from(first.indices.slice(next.start, next.end)).some((index) =>
                (analysis.describe(index).inputs || []).some((arg) => (arg.value || []).some((value) => !value.initializer && outputs.has(value.name)))));
        }
        presentations.push(presentation);
        // Large inventories must remain cancellable without constructing any rich nodes.
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }
    if (!current()) {
        return;
    }
    const families = new Map();
    for (const presentation of presentations.filter((item) => item.family)) {
        const family = families.get(presentation.family) || [];
        family.push(presentation);
        families.set(presentation.family, family);
    }
    for (const family of families.values()) {
        const ids = family.flatMap((item) => item.indices);
        // Overlapping provenance cannot establish a global block count.
        if (new Set(ids).size === ids.length) {
            const counts = family.map((item) => item.compound ? `${item.group.blocks.length} × ${item.ranges[0].length}` : String(item.indices.length));
            family[0].total = `${ids.length} ${family[0].label} (${counts.join(' + ')})`;
            for (const item of family) {
                item.familyTotal = ids.length;
            }
        }
    }
    for (const { group, ...presentation } of presentations) {
        group.presentation = presentation;
    }
};

export const indexRange = (indices) => indices.length > 1 && indices.every((id, i) => i === 0 || id === indices[i - 1] + 1)
    ? `${indices[0]}–${indices.at(-1)}` : `${indices.slice(0, 6).join(', ')}${indices.length > 6 ? ', …' : ''}`;
