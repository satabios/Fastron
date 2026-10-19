// A feature vocabulary informed by the gallery, not a model-name lookup table.
// Profiles describe verified blocks; they cannot identify checkpoint provenance.
const recipes = [
    { label: 'Classic dense Transformer recipe', examples: 'GPT-2',
        features: { normalization: 'LayerNorm', attention: 'MHA', feedforward: 'GELU MLP' } },
    { label: 'RMSNorm/GQA recipe', examples: 'Llama 3, Qwen3',
        features: { normalization: 'RMSNorm', attention: 'GQA' } }
];

export const architectureProfile = (attention, mlp) => {
    const normalization = [attention.norm, mlp.norm].map((norm) => {
        if (norm.pattern) {
            return 'Unresolved normalization';
        }
        return norm.title === 'LayerNormalization' ? 'LayerNorm' : 'RMSNorm';
    });
    const mechanism = attention.mechanism || { kind: 'SDPA', implementation: 'explicit' };
    const feedforward = mlp.feedforward;
    const names = [...new Set(normalization)];
    const label = `${mechanism.kind} + ${feedforward.kind}`;
    const observed = { normalization: names.join(' / '), attention: mechanism.kind, feedforward: feedforward.kind };
    const matches = recipes.flatMap((recipe) => {
        const shared = [];
        const unresolved = [];
        for (const [feature, expected] of Object.entries(recipe.features)) {
            const actual = observed[feature];
            if (actual === expected) {
                shared.push(`${feature}: ${expected}`);
            } else if (actual.includes('Unresolved') || (feature === 'attention' && actual === 'SDPA')) {
                unresolved.push(feature);
            } else {
                return [];
            }
        }
        return shared.length ? [{ label: recipe.label, examples: recipe.examples, shared, unresolved,
            status: unresolved.length ? 'partial feature match' : 'shared feature match' }] : [];
    });
    return {
        label,
        family: feedforward.gated ? 'Gated Transformer block' : 'Transformer block with dense MLP',
        normalization: names.join(' / '),
        attention: mechanism,
        feedforward,
        recipe: `${names.join(' / ')} → ${mechanism.kind} → (+) → ${names.join(' / ')} → ${feedforward.kind} → (+)`,
        evidence: [
            { feature: 'normalization', indices: [attention.norm.start, mlp.norm.start], detail: names.join(' / ') },
            { feature: 'attention', indices: [attention.start, attention.end], detail: `${mechanism.kind}, ${mechanism.implementation}` },
            { feature: 'feedforward', indices: [mlp.start, mlp.end], detail: feedforward.kind }
        ],
        unresolved: ['Positional encoding', 'Causal or bidirectional masking', 'Source model identity'],
        reference: { title: 'LLM Architecture Gallery', url: 'https://sebastianraschka.com/llm-architecture-gallery/', matches }
    };
};
