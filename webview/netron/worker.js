
let _dagre = null;

const require = async () => {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        const worker_threads = await import('worker_threads');
        return worker_threads.parentPort;
    }
    if (!_dagre) {
        _dagre = import('./dagre.js');
    }
    return self;
};

require().then((self) => {
    self.addEventListener('message', async (e) => {
        const message = e.data;
        switch (message.type) {
            case 'dagre.layout': {
                try {
                    if (!_dagre) {
                        _dagre = import('./dagre.js');
                    }
                    const dagre = await _dagre;
                    dagre.layout(message.nodes, message.edges, message.layout, message.state);
                    self.postMessage(message);
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

