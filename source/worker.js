
const require = async () => {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        const worker_threads = await import('worker_threads');
        return worker_threads.parentPort;
    }
    import('./dagre.js');
    return self;
};

require().then((self) => {
    self.addEventListener('message', async (e) => {
        const message = e.data;
        switch (message.type) {
            case 'dagre.layout': {
                try {
                    const dagre = await import('./dagre.js');
                    dagre.layout(message.nodes, message.edges, message.layout, message.state);
                    self.postMessage(message);
                } catch (error) {
                    self.postMessage({ type: 'error', message: error.message });
                }
                break;
            }
            case 'elk.layout': {
                try {
                    const { default: ELK } = await import('elkjs/lib/elk.bundled.js');
                    const elk = new ELK();
                    const rankdir = message.layout && message.layout.rankdir;
                    const elkGraph = {
                        id: 'root',
                        layoutOptions: {
                            'elk.algorithm': 'layered',
                            'elk.direction': rankdir === 'LR' ? 'RIGHT' : 'DOWN',
                            'elk.spacing.nodeNode': String(message.layout.nodesep || 20),
                            'elk.layered.spacing.nodeNodeBetweenLayers': String(message.layout.ranksep || 20),
                            'nodePlacement.strategy': 'BRANDES_KOEPF'
                        },
                        children: message.nodes.map((n) => ({ id: n.v, width: n.width || 150, height: n.height || 65 })),
                        edges: message.edges.map((e, i) => ({ id: `e${i}`, sources: [e.v], targets: [e.w] }))
                    };
                    const result = await elk.layout(elkGraph);
                    const nodeMap = new Map(result.children.map((n) => [n.id, n]));
                    const outNodes = message.nodes.map((n) => {
                        const e = nodeMap.get(n.v);
                        return e ? { ...n, x: e.x + e.width / 2, y: e.y + e.height / 2 } : n;
                    });
                    const outEdges = message.edges.map((e, i) => {
                        const re = result.edges && result.edges[i];
                        if (re && re.sections && re.sections.length > 0) {
                            const sec = re.sections[0];
                            const pts = [sec.startPoint, ...(sec.bendPoints || []), sec.endPoint]
                                .map((p) => ({ x: p.x, y: p.y }));
                            return { ...e, points: pts };
                        }
                        return { ...e, points: [] };
                    });
                    self.postMessage({ ...message, nodes: outNodes, edges: outEdges });
                } catch (error) {
                    self.postMessage({ type: 'error', message: error.message });
                }
                break;
            }
            default: {
                throw Error(`Unsupported message type '${message.type}'.`);
            }
        }
    });
});

