export const hierarchyFixture = () => {
    const type = { dataType: 'float32', shape: { dimensions: ['batch', 'sequence_length', 64] } };
    const value = (name) => ({ name, type });
    const arg = (value) => ({ name: value.name, value: [value] });
    const input = value('input');
    const cache = value('cache');
    const graph = { nodes: [], inputs: [arg(input), arg(cache)], outputs: [] };
    let previous = input;
    const add = (name, type, ...inputs) => {
        const output = value(`tensor_${graph.nodes.length}`);
        graph.nodes.push({ name, type: { name: type }, inputs: inputs.map(arg), outputs: [arg(output)], attributes: [] });
        return output;
    };
    for (let block = 0; block < 2; block++) {
        const scope = `/network/blocks.${block}`;
        const residual = previous;
        previous = add(`${scope}/norm/Abs`, 'Abs', previous);
        previous = add(`${scope}/norm/Relu`, 'Relu', previous);
        previous = add(`${scope}/attn/Add`, 'Add', previous, cache);
        previous = add(`${scope}/attn/Relu`, 'Relu', previous);
        graph.outputs.push(arg(previous));
        previous = add(`${scope}/mlp/Abs`, 'Abs', previous);
        previous = add(`${scope}/mlp/Relu`, 'Relu', previous);
        previous = add(`${scope}/Add`, 'Add', previous, residual);
    }
    graph.outputs.push(arg(previous));
    return graph;
};

export const hierarchyModel = () => {
    const graph = hierarchyFixture();
    const args = (args) => args.map((arg) => ({ name: arg.name, type: { tensor_type: { elem_type: 1,
        shape: { dim: arg.value[0].type.shape.dimensions.map((dim) => typeof dim === 'number' ? { dim_value: dim } : { dim_param: dim }) } } } }));
    return { ir_version: 8, opset_import: [{ domain: '', version: 20 }], producer_name: 'group-test', graph: {
        name: 'Grouped graph', input: args(graph.inputs), output: args(graph.outputs),
        value_info: args(graph.nodes.flatMap((node) => node.outputs)),
        node: graph.nodes.map((node) => ({ name: node.name, op_type: node.type.name,
            input: node.inputs.flatMap((arg) => arg.value.map((value) => value.name)),
            output: node.outputs.flatMap((arg) => arg.value.map((value) => value.name)), attribute: [] }))
    } };
};
