
import { Graph, ModelFactoryService, Worker } from './view.js';

const comparator = {};

comparator.ViewProxy = class {

    constructor(host, model, options) {
        this._host = host;
        this._model = model;
        this._options = options;
    }

    get host() {
        return this._host;
    }

    get model() {
        return this._model;
    }

    set model(value) {
        this._model = value;
    }

    get options() {
        return this._options;
    }
};

comparator.Controller = class {

    constructor(host) {
        this._host = host;
        this._modelFactory = new ModelFactoryService(host);
        this._modelFactory.import();
        this._worker = host.environment('serial') ? null : new Worker(host);
        this._syncing = false;
    }

    async compare(pathA, pathB) {
        const document = this._host.document;

        // Update pane headers
        document.getElementById('pane-left-header').textContent =
            pathA.label || pathA.path.split('/').pop();
        document.getElementById('pane-right-header').textContent =
            pathB.label || pathB.path.split('/').pop();

        try {
            // Load both models in parallel
            const [contextA, contextB] = await Promise.all([
                this._host._context(pathA.path),
                this._host._context(pathB.path)
            ]);

            const [modelA, modelB] = await Promise.all([
                this._modelFactory.open(contextA),
                this._modelFactory.open(contextB)
            ]);

            // Get primary graph target from each model
            const targetA = this._getPrimaryTarget(modelA);
            const targetB = this._getPrimaryTarget(modelB);

            if (!targetA || !targetB) {
                throw new Error('Could not find graph targets in one or both models.');
            }

            const containerLeft = document.getElementById('target-left');
            const containerRight = document.getElementById('target-right');

            const options = {
                weights: true,
                attributes: true,
                names: false,
                direction: 'vertical',
                mousewheel: 'scroll',
                lazyRender: false
            };

            // Render Model A
            const viewProxyA = new comparator.ViewProxy(this._host, modelA, options);
            const groupsA = targetA.groups || false;
            this._graphA = new Graph(viewProxyA, groupsA);
            this._graphA.add(targetA, null);
            this._graphA.build(document, containerLeft);
            await this._graphA.measure();
            await this._graphA.layout(this._worker);
            this._graphA.update();
            this._graphA.restore(null);

            // Render Model B (must be sequential — worker handles one request at a time)
            const viewProxyB = new comparator.ViewProxy(this._host, modelB, options);
            const groupsB = targetB.groups || false;
            this._graphB = new Graph(viewProxyB, groupsB);
            this._graphB.add(targetB, null);
            this._graphB.build(document, containerRight);
            await this._graphB.measure();
            await this._graphB.layout(this._worker);
            this._graphB.update();
            this._graphB.restore(null);

            // Perform node comparison and apply highlighting
            const diffResult = this._compareNodes(targetA, targetB);
            this._applyDiffHighlighting(this._graphA, this._graphB, targetA, targetB, diffResult);

            // Setup synchronized navigation
            this._setupSync(containerLeft, containerRight);

            // Register event handlers on both graphs
            this._graphA.register();
            this._graphB.register();

        } catch (error) {
            // eslint-disable-next-line no-console
            console.error('Comparison failed:', error);
            const spinner = document.getElementById('comparator-spinner');
            if (spinner) {
                const text = spinner.querySelector('.spinner-text');
                if (text) {
                    text.textContent = `Error: ${error.message}`;
                }
            }
            return;
        }

        // Hide spinner
        const spinner = document.getElementById('comparator-spinner');
        if (spinner) {
            spinner.classList.add('hidden');
        }
    }

    _getPrimaryTarget(model) {
        const modules = Array.isArray(model.functions)
            ? model.modules.concat(model.functions)
            : model.modules;
        for (const module of modules) {
            if (Array.isArray(module.nodes) && module.nodes.length > 0) {
                return module;
            }
        }
        return modules.length > 0 ? modules[0] : null;
    }

    _compareNodes(targetA, targetB) {
        const nodesA = targetA.nodes || [];
        const nodesB = targetB.nodes || [];
        const result = {
            pairs: [],
            onlyInA: [],
            onlyInB: []
        };
        const maxLen = Math.max(nodesA.length, nodesB.length);
        for (let i = 0; i < maxLen; i++) {
            if (i < nodesA.length && i < nodesB.length) {
                const nodeA = nodesA[i];
                const nodeB = nodesB[i];
                const typeNameA = nodeA.type && nodeA.type.name ? nodeA.type.name : '';
                const typeNameB = nodeB.type && nodeB.type.name ? nodeB.type.name : '';
                if (typeNameA === typeNameB) {
                    result.pairs.push({ indexA: i, indexB: i, status: 'identical' });
                } else {
                    result.pairs.push({ indexA: i, indexB: i, status: 'modified' });
                }
            } else if (i < nodesA.length) {
                result.onlyInA.push(i);
            } else {
                result.onlyInB.push(i);
            }
        }
        return result;
    }

    _applyDiffHighlighting(graphA, graphB, targetA, targetB, diffResult) {
        const nodesA = targetA.nodes || [];
        const nodesB = targetB.nodes || [];

        const getViewNode = (graph, modelNode) => {
            return graph._table.get(modelNode);
        };

        for (const pair of diffResult.pairs) {
            if (pair.status === 'modified') {
                const viewNodeA = getViewNode(graphA, nodesA[pair.indexA]);
                const viewNodeB = getViewNode(graphB, nodesB[pair.indexB]);
                if (viewNodeA && viewNodeA.element) {
                    viewNodeA.element.classList.add('node-diff-modified');
                }
                if (viewNodeB && viewNodeB.element) {
                    viewNodeB.element.classList.add('node-diff-modified');
                }
            }
        }
        for (const idx of diffResult.onlyInA) {
            const viewNode = getViewNode(graphA, nodesA[idx]);
            if (viewNode && viewNode.element) {
                viewNode.element.classList.add('node-diff-removed');
            }
        }
        for (const idx of diffResult.onlyInB) {
            const viewNode = getViewNode(graphB, nodesB[idx]);
            if (viewNode && viewNode.element) {
                viewNode.element.classList.add('node-diff-added');
            }
        }
    }

    _setupSync(containerLeft, containerRight) {
        // Synchronized scrolling
        const syncScroll = (source, target) => {
            if (this._syncing) {
                return;
            }
            this._syncing = true;
            target.scrollLeft = source.scrollLeft;
            target.scrollTop = source.scrollTop;
            this._syncing = false;
        };

        containerLeft.addEventListener('scroll', () => {
            syncScroll(containerLeft, containerRight);
        });
        containerRight.addEventListener('scroll', () => {
            syncScroll(containerRight, containerLeft);
        });

        // Synchronized zooming — wrap _updateZoom on both graphs
        const originalZoomA = this._graphA._updateZoom.bind(this._graphA);
        const originalZoomB = this._graphB._updateZoom.bind(this._graphB);

        this._graphA._updateZoom = (zoom, e) => {
            originalZoomA(zoom, e);
            if (!this._syncing) {
                this._syncing = true;
                originalZoomB(zoom, null);
                containerRight.scrollLeft = containerLeft.scrollLeft;
                containerRight.scrollTop = containerLeft.scrollTop;
                this._syncing = false;
            }
        };

        this._graphB._updateZoom = (zoom, e) => {
            originalZoomB(zoom, e);
            if (!this._syncing) {
                this._syncing = true;
                originalZoomA(zoom, null);
                containerLeft.scrollLeft = containerRight.scrollLeft;
                containerLeft.scrollTop = containerRight.scrollTop;
                this._syncing = false;
            }
        };
    }
};

export const Controller = comparator.Controller;
