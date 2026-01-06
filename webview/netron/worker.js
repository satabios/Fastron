
const require = async () => {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        const worker_threads = await import('worker_threads');
        return worker_threads.parentPort;
    }
    import('./dagre.js');
    return self;
};

require().then((self) => {
    let dagre = null;
    
    self.addEventListener('message', async (e) => {
        const message = e.data;
        
        try {
            switch (message.type) {
                case 'dagre.layout': {
                    if (!dagre) {
                        dagre = await import('./dagre.js');
                    }
                    dagre.layout(message.nodes, message.edges, message.layout, message.state);
                    self.postMessage({ type: 'dagre.layout', ...message });
                    break;
                }
                
                case 'partial.layout': {
                    // NEW: Compute layout for subgraph only
                    if (!dagre) {
                        dagre = await import('./dagre.js');
                    }
                    dagre.layout(message.nodes, message.edges, message.layout, message.state);
                    self.postMessage({ type: 'partial.layout', nodes: message.nodes, edges: message.edges });
                    break;
                }
                
                case 'compute.bounds': {
                    // NEW: Compute node bounds for spatial indexing
                    const bounds = message.nodes.map(node => ({
                        id: node.v || node.id,
                        x: node.x,
                        y: node.y,
                        width: node.width,
                        height: node.height
                    }));
                    self.postMessage({ type: 'compute.bounds', bounds });
                    break;
                }
                
                case 'simplify.graph': {
                    // NEW: Simplify graph for overview rendering
                    const simplified = simplifyGraph(message.nodes, message.edges, message.threshold);
                    self.postMessage({ type: 'simplify.graph', simplified });
                    break;
                }
                
                default: {
                    throw new Error(`Unsupported message type '${message.type}'.`);
                }
            }
        } catch (error) {
            self.postMessage({ type: 'error', message: error.message, stack: error.stack });
        }
    });
    
    // Helper function to simplify graph
    function simplifyGraph(nodes, edges, threshold = 100) {
        if (nodes.length <= threshold) {
            return { nodes, edges };
        }
        
        // Group nodes by type
        const typeGroups = new Map();
        for (const node of nodes) {
            const type = node.type || 'unknown';
            if (!typeGroups.has(type)) {
                typeGroups.set(type, []);
            }
            typeGroups.get(type).push(node);
        }
        
        // Create cluster nodes
        const clusters = [];
        const nodeToCluster = new Map();
        
        for (const [type, groupNodes] of typeGroups) {
            if (groupNodes.length > 1) {
                // Create cluster
                const sumX = groupNodes.reduce((sum, n) => sum + (n.x || 0), 0);
                const sumY = groupNodes.reduce((sum, n) => sum + (n.y || 0), 0);
                
                const cluster = {
                    id: `cluster_${type}_${clusters.length}`,
                    type: 'cluster',
                    originalType: type,
                    nodeCount: groupNodes.length,
                    x: sumX / groupNodes.length,
                    y: sumY / groupNodes.length,
                    width: 100,
                    height: 50
                };
                
                clusters.push(cluster);
                
                for (const node of groupNodes) {
                    nodeToCluster.set(node.v || node.id, cluster.id);
                }
            } else {
                // Keep single node
                clusters.push(groupNodes[0]);
            }
        }
        
        // Simplify edges
        const clusterEdgeMap = new Map();
        for (const edge of edges) {
            const fromCluster = nodeToCluster.get(edge.v) || edge.v;
            const toCluster = nodeToCluster.get(edge.w) || edge.w;
            
            if (fromCluster === toCluster) {
                continue; // Skip internal edges
            }
            
            const key = `${fromCluster}_${toCluster}`;
            if (!clusterEdgeMap.has(key)) {
                clusterEdgeMap.set(key, {
                    v: fromCluster,
                    w: toCluster,
                    count: 0
                });
            }
            clusterEdgeMap.get(key).count++;
        }
        
        return {
            nodes: clusters,
            edges: Array.from(clusterEdgeMap.values())
        };
    }
});

