import { nodeDescriptions } from './repeated-blocks.js';
import { patternBlocks } from './pattern-blocks.js';
import { structuralBlocks } from './structural-blocks.js';

// Architectural boundaries take precedence over repetition in exporter ordering.
// Softmax inventory is an audit of coverage, never a source of block boundaries.
export const architectureBlocks = async (graph, current = () => true) => {
    if (!current()) {
        return null;
    }
    if (graph._structuralParts) {
        return structuralBlocks(graph, current);
    }
    let softmax = 0;
    let attention = false;
    let index = 0;
    for (const node of nodeDescriptions(graph)) {
        softmax += node.type.name === 'Softmax' ? 1 : 0;
        attention ||= /^(Softmax|Attention|MultiHeadAttention|GroupQueryAttention)$/.test(node.type.name);
        if (++index % 256 === 0) {
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => {
                setTimeout(resolve, 0);
            });
            if (!current()) {
                return null;
            }
        }
    }
    const semantic = attention ? await structuralBlocks(graph, current) : null;
    if (!current()) {
        return null;
    }
    if (!semantic) {
        return patternBlocks(graph, current);
    }
    const groups = semantic.groups;
    const count = groups.reduce((sum, group) => sum + group.blocks.length, 0);
    let matchedSoftmax = 0;
    for (const group of groups) {
        group.architecture = 'transformer';
        group.unit = 'block';
        group.title = 'Transformer blocks';
        group.label = 'Transformer blocks';
        for (const block of group.blocks) {
            block.softmaxCount = Array.from(block.indices, (i) => semantic.describe(i)).filter((node) => node.type.name === 'Softmax').length;
            matchedSoftmax += block.softmaxCount;
        }
        group.presentation = { compound: false, parts: [], ranges: [], label: 'blocks',
            total: `${count} detected Transformer blocks`, blockIndices: group.blocks.map((block) => block.index) };
    }
    // Search only unclaimed operators, preserving CNN/RNN patterns and transitions.
    const remaining = await patternBlocks(graph, current, groups);
    if (!current()) {
        return null;
    }
    return Object.assign(semantic, {
        groups: [...groups, ...(remaining?.groups || [])].sort((a, b) => a.anchor - b.anchor)
            .map((group, id) => ({ ...group, id })),
        architecture: { blocks: count, softmax, matchedSoftmax }
    });
};
