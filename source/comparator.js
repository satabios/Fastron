
import { Formatter, Graph, ModelFactoryService, Worker } from './view.js';
import { GraphAnalysis, indexedGraph } from './graph-analysis.mjs';
import { nodeDescriptions } from './repeated-blocks.js';

const comparator = {};

comparator.ViewProxy = class {

    constructor(host, model, options, side) {
        this._host = host;
        this._model = model;
        this._options = options;
        this._controller = null;
        this._side = side;
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

    get activeTarget() {
        const id = this._side === 0 ? this._controller._entry.a : this._controller._entry.b;
        return this._controller._records[id]?.target;
    }

    showNodeProperties(node, index) {
        this._controller.inspectNode(this._side, node, index);
    }
    showGraphGroup(group) {
        this._controller.inspectGroup(this._side, group);
    }
    toggleGraphGroup(group) {
        return this._controller.toggleGraphGroup(this._side, group);
    }
    pushTarget(graph, context) {
        return this._controller.openBody(this._side, graph, context);
    }
    showTargetProperties() {
        this._controller.inspectMetadata('Graph properties', this.activeTarget);
    }
    showConnectionProperties(value) {
        this._controller.inspectMetadata('Connection', value);
    }
    showTensorProperties(value) {
        this._controller.inspectMetadata('Tensor metadata', value);
    }
    error(error) {
        this._controller._showError(error);
    }

};

comparator.Controller = class {

    constructor(host) {
        this._host = host;
        this._modelFactory = new ModelFactoryService(host);
        this._workerA = host.environment('serial') ? null : new Worker(host);
        this._workerB = host.environment('serial') ? null : new Worker(host);
        this._syncing = false;
        this._comparing = false;
        this._graphA = null;
        this._graphB = null;
        this._nodeDiffMap = null;
        this._diffPanelInitialized = false;
        this._phase2Timer = null;
    }

    _reset() {
        for (const source of this._sources || []) {
            source.dispose();
        }
        this._sources = [];
        this._hideDiffPanel();
        this._sessionGeneration = (this._sessionGeneration || 0) + 1;
        this._renderGeneration = (this._renderGeneration || 0) + 1;
        this._analysis?.dispose();
        this._analysis = null;
        this._history = [];
        this._entry = null;
        this._records = [];
        this._displays = null;
        this._clearRender();
        if (this._phase2Timer) {
            clearTimeout(this._phase2Timer);
            this._phase2Timer = null;
        }
        this._graphA = null;
        this._graphB = null;
        this._targetA = null;
        this._targetB = null;
        this._diffResult = null;
        this._nodeDiffMap = null;
        this._syncing = false;
    }

    async compare(pathA, pathB) {
        if (this._comparing) {
            return;
        }
        this._comparing = true;
        this._reset();
        const generation = this._sessionGeneration;

        const document = this._host.document;

        // Show spinner
        const spinner = document.getElementById('comparator-spinner');
        if (spinner) {
            spinner.classList.remove('hidden');
            const text = spinner.querySelector('.spinner-text');
            if (text) {
                text.textContent = 'Loading models...';
            }
        }

        // Update pane headers
        const leftHeader = document.getElementById('pane-left-header');
        const rightHeader = document.getElementById('pane-right-header');
        if (leftHeader) {
            leftHeader.textContent = pathA.label || pathA.path.split('/').pop();
        }
        if (rightHeader) {
            rightHeader.textContent = pathB.label || pathB.path.split('/').pop();
        }

        try {
            // Load both models in parallel
            const contexts = await Promise.allSettled([
                this._host._context(pathA.path),
                this._host._context(pathB.path)
            ]);
            const failed = contexts.find((result) => result.status === 'rejected');
            if (failed) {
                for (const result of contexts.filter((item) => item.status === 'fulfilled')) {
                    result.value.source?.dispose();
                    this._disposeContext(result.value);
                }
                throw failed.reason;
            }
            const [contextA, contextB] = contexts.map((result) => result.value);
            if (generation !== this._sessionGeneration) {
                for (const context of [contextA, contextB]) {
                    context.source?.dispose();
                    this._disposeContext(context);
                }
                return;
            }
            this._sources = [contextA.source, contextB.source].filter((source) => source);
            let modelA = null;
            let modelB = null;
            try {
                [modelA, modelB] = await Promise.all([
                    this._modelFactory.open(contextA),
                    this._modelFactory.open(contextB)
                ]);
            } finally {
                this._disposeContext(contextA);
                this._disposeContext(contextB);
            }

            if (generation !== this._sessionGeneration) {
                return;
            }

            // Get primary graph target from each model
            const targetA = this._getPrimaryTarget(modelA);
            const targetB = this._getPrimaryTarget(modelB);

            if (!targetA || !targetB) {
                throw new Error('Could not find graph targets in one or both models.');
            }

            this._models = [modelA, modelB];
            this._history = [];
            this._entries = new Map();
            this._grouped = false;
            this._initializeControls();
            this._records = [targetA, targetB].map((target) => ({ target }));
            const entry = { a: 0, b: 1, expanded: [new Set(), new Set()],
                result: { pending: true, pairs: [], onlyInA: [], onlyInB: [], children: [] } };
            this._entry = entry;
            await this._renderPair(entry);
            if (generation !== this._sessionGeneration) {
                return;
            }
            spinner?.classList.add('hidden');
            // The second animation frame follows a paint; analysis must not compete with initial layout or rendering.
            await new Promise((resolve) => {
                this._host.window.requestAnimationFrame(() => this._host.window.requestAnimationFrame(resolve));
            });
            if (generation !== this._sessionGeneration || entry.error) {
                return;
            }
            if (typeof this._host.worker !== 'function') {
                // shortcut: hosts without a worker keep primary-graph JavaScript diff, replace when their bridge supports analysis workers.
                this._records = [targetA, targetB].map((target) => ({ target, descriptions: [...nodeDescriptions(target)] }));
                const state = this._compareNodesPhase1(targetA, targetB);
                entry.result = state.result;
                this._refreshDiff();
                this._compareNodesPhase2(state, (result) => {
                    if (generation === this._sessionGeneration && !entry.error) {
                        entry.result = result;
                        this._refreshDiff();
                    }
                });
                return;
            }
            this._analysis = new GraphAnalysis(this._host);
            this._records = this._analysis.encoder.targets;
            this._analysis.encoder.register(targetA);
            this._analysis.encoder.register(targetB);
            this._analysis.onprogress = () => {
                if (generation === this._sessionGeneration) {
                    this._updateSummaryBar(this._entry.result);
                }
            };
            const result = await this._analysis.compare(targetA, targetB);
            for (const graph of [this._graphA, this._graphB]) {
                graph._sourceNodes = new Map();
                let deadline = performance.now() + 4;
                for (const { label: node } of graph.nodes.values()) {
                    if (Number.isInteger(node._originalIndex)) {
                        graph._sourceNodes.set(node._originalIndex, node);
                    }
                    if (performance.now() >= deadline) {
                        // eslint-disable-next-line no-await-in-loop
                        await new Promise((resolve) => {
                            setTimeout(resolve, 0);
                        });
                        deadline = performance.now() + 4;
                        if (generation !== this._sessionGeneration || entry.error) {
                            return;
                        }
                    }
                }
            }
            if (generation !== this._sessionGeneration) {
                return;
            }
            Object.assign(entry, { result, id: result.id });
            this._entries.set(result.id, entry);
            this._refreshDiff();

        } catch (error) {
            if (generation !== this._sessionGeneration) {
                return;
            }
            if (this._entry) {
                const cancelled = Boolean(this._entry.error);
                this._entry.error ||= error.message;
                this._analysis?.dispose();
                spinner?.classList.add('hidden');
                this._refreshDiff();
                if (!cancelled) {
                    this._showError(error);
                }
                return;
            }
            for (const source of this._sources || []) {
                source.dispose();
            }
            this._sources = [];
            // eslint-disable-next-line no-console
            console.error('Comparison failed:', error);
            const loadSpinner = document.getElementById('comparator-spinner');
            if (loadSpinner) {
                const text = loadSpinner.querySelector('.spinner-text');
                if (text) {
                    text.textContent = `Error: ${error.message}`;
                }
            }
            return;
        } finally {
            this._comparing = false;
        }
    }

    _getPrimaryTarget(model) {
        const modelModules = Array.isArray(model.modules) ? model.modules : [];
        const modelFunctions = Array.isArray(model.functions) ? model.functions : [];
        const modules = modelModules.concat(modelFunctions);
        for (const module of modules) {
            if (module && Array.isArray(module.nodes) && module.nodes.length > 0) {
                return module;
            }
        }
        return modules.length > 0 ? modules[0] : null;
    }

    _initializeControls() {
        if (this._controlsInitialized) {
            return;
        }
        this._controlsInitialized = true;
        const document = this._host.document;
        const run = (action) => action().catch((error) => this._showError(error));
        document.getElementById('compare-group')?.addEventListener('click', () => run(async () => {
            if (!this._entry || this._entry.result.pending || this._rendering) {
                return;
            }
            this._savePosition();
            this._grouped = !this._grouped;
            document.getElementById('compare-group').setAttribute('aria-pressed', String(this._grouped));
            await this._renderPair(this._entry);
        }));
        document.getElementById('compare-back')?.addEventListener('click', () => run(async () => {
            if (!this._history.length || this._rendering || this._navigating) {
                return;
            }
            this._savePosition();
            await this._renderPair(this._history.pop());
        }));
        document.getElementById('compare-filter')?.addEventListener('change', () => this._renderChanges());
        document.getElementById('compare-cancel')?.addEventListener('click', () => {
            this._analysis?.dispose();
            if (this._entry?.result.pending) {
                this._entry.error = 'Analysis cancelled. Nested bodies have not been compared.';
                this._refreshDiff();
            }
        });
        document.getElementById('diff-panel-close')?.addEventListener('click', () => this._hideDiffPanel());
        document.getElementById('diff-panel-backdrop')?.addEventListener('click', () => this._hideDiffPanel());
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this._hideDiffPanel();
            }
            const panel = document.getElementById('diff-panel');
            if (event.key === 'Tab' && !panel.classList.contains('hidden')) {
                const buttons = panel.querySelectorAll('button');
                const first = buttons[0]; const last = buttons[buttons.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault(); last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault(); first.focus();
                }
            }
        });
        this._diffPanelInitialized = true;
        this._host.window?.addEventListener('beforeunload', () => this._reset(), { once: true });
    }

    _clearRender() {
        this._connectorPairs = null;
        this._syncDispose?.();
        this._syncDispose = null;
        for (const graph of [this._graphA, this._graphB]) {
            graph?.unregister();
        }
        this._graphA = null;
        this._graphB = null;
        for (const id of ['target-left', 'target-right', 'connector-overlay']) {
            this._host.document.getElementById(id)?.replaceChildren();
        }
    }

    _savePosition() {
        if (!this._entry) {
            return;
        }
        this._entry.position = [this._graphA, this._graphB].map((graph, side) => {
            const container = this._host.document.getElementById(side === 0 ? 'target-left' : 'target-right');
            return { zoom: graph?.zoom || 1, left: container.scrollLeft, top: container.scrollTop };
        });
    }

    async _renderPair(entry) {
        this._renderGeneration = (this._renderGeneration || 0) + 1;
        const generation = this._renderGeneration;
        this._rendering = true;
        try {
            const session = this._sessionGeneration;
            this._entry = entry;
            this._hideDiffPanel();
            const document = this._host.document;
            const ids = [entry.a, entry.b];
            const empty = { name: 'No corresponding body', nodes: [], inputs: [], outputs: [] };
            const raw = ids.map((id) => this._records[id]?.target || empty);
            const displays = await Promise.all(ids.map((id, side) => this._grouped && id !== 0xffffffff && !entry.result.pending
                ? this._analysis.project(id, entry.expanded[side], entry.id, side, !entry.groupInitialized?.[side]) : indexedGraph(raw[side])));
            if (generation !== this._renderGeneration || session !== this._sessionGeneration) {
                return;
            }
            this._clearRender();
            const containers = ['target-left', 'target-right'].map((id) => document.getElementById(id));
            const graphs = displays.map((display, side) => {
                const proxy = new comparator.ViewProxy(this._host, this._models[side], {
                    weights: true, attributes: true, names: false, direction: 'vertical', mousewheel: 'scroll', lazyRender: true
                }, side);
                proxy._controller = this;
                const graph = new Graph(proxy, display.groups || false);
                graph._deferSourceMap = Boolean(entry.result.pending);
                graph.enableViewportCulling(true);
                graph.configureDeferredRendering({ deferredNodeBuild: true, deferredEdgeBuild: true, skipHiddenUpdate: true,
                    detachInvisible: true, estimatedNodeSizeThreshold: 500 });
                graph.add(display, null);
                graph.build(document, containers[side]);
                return graph;
            });
            [this._graphA, this._graphB] = graphs;
            [this._targetA, this._targetB] = raw;
            this._displays = displays;
            for (const [side, display] of displays.entries()) {
                if (display._analysisProjection) {
                    entry.expanded[side] = new Set(display._analysisProjection.expanded);
                    entry.groupInitialized ||= [false, false]; entry.groupInitialized[side] = true;
                }
            }
            await Promise.all(graphs.map((graph) => graph.measure()));
            if (generation !== this._renderGeneration || session !== this._sessionGeneration) {
                return;
            }
            await Promise.all(graphs.map((graph, side) => graph.layout(side === 0 ? this._workerA : this._workerB)));
            if (generation !== this._renderGeneration || session !== this._sessionGeneration) {
                return;
            }
            for (const [side, graph] of graphs.entries()) {
                graph.populateTiles(); graph.update(); graph.restore(null);
                const saved = entry.position?.[side];
                if (saved) {
                    graph.zoom = saved.zoom; containers[side].scrollLeft = saved.left; containers[side].scrollTop = saved.top;
                }
                graph.resetViewportVisibility();
                graph._onViewportChange(graph._getViewportBounds());
                graph.register();
                const viewport = graph._onViewportChange.bind(graph);
                graph._onViewportChange = (bounds) => {
                    viewport(bounds); this._updateConnectors();
                };
                const header = document.getElementById(side === 0 ? 'pane-left-header' : 'pane-right-header');
                header.textContent = `${side === 0 ? 'A' : 'B'} · ${raw[side].name || 'Primary graph'}${ids[side] === 0xffffffff ? ' — missing' : ''}`;
            }
            this._setupSync(...containers);
            const back = document.getElementById('compare-back');
            if (back) {
                back.disabled = this._history.length === 0;
            }
            const path = document.getElementById('compare-path');
            if (path) {
                path.textContent = this._history.length ? `Function / subgraph · depth ${this._history.length}` : 'Primary graph';
            }
            this._refreshDiff();
            for (const [side, index] of (entry.selection || []).entries()) {
                if (index !== undefined) {
                    this._pulseNode(this._viewNode(graphs[side], index, side));
                }
            }
        } finally {
            if (generation === this._renderGeneration) {
                this._rendering = false;
            }
        }
    }

    _refreshDiff() {
        if (!this._entry) {
            return;
        }
        this._connectorPairs = null;
        this._diffResult = this._entry.result;
        if (!this._diffResult.pending && this._graphA && this._graphB) {
            this._applyDiffHighlighting(this._graphA, this._graphB, this._targetA, this._targetB, this._diffResult);
        }
        this._updateSummaryBar(this._diffResult);
        this._renderChanges();
        this._updateConnectors();
        const document = this._host.document;
        const disabled = this._diffResult.pending || Boolean(this._entry.error);
        const group = document.getElementById('compare-group');
        if (group) {
            group.disabled = disabled || !this._analysis;
        }
        const cancel = document.getElementById('compare-cancel');
        if (cancel) {
            cancel.hidden = !this._diffResult.pending || Boolean(this._entry.error);
        }
    }

    _viewNode(graph, index, side) {
        const direct = graph?._sourceNodes?.get(index);
        if (direct) {
            return direct;
        }
        const display = this._displays?.[side];
        const data = display?._analysisProjection;
        if (data) {
            const owner = data.owners[index];
            const group = data.byKey.get(owner);
            if (group) {
                return graph._groupNodes.get(group.id);
            }
        }
        return graph?._table?.get((side === 0 ? this._targetA : this._targetB)?.nodes[index]);
    }

    async toggleGraphGroup(side, group) {
        if (group.unsafe || this._entry.result.pending || this._rendering) {
            return;
        }
        this._savePosition();
        const expanded = this._entry.expanded[side];
        if (expanded.has(group.key)) {
            expanded.delete(group.key);
        } else {
            expanded.add(group.key);
        }
        await this._renderPair(this._entry);
        const graph = side === 0 ? this._graphA : this._graphB;
        const node = graph?._groupNodes.get(group.id);
        if (node) {
            this._focusViewNode(graph, node);
        }
    }

    inspectGroup(side, group) {
        const content = this._openPanel(`Group: ${group.label}`);
        content.textContent = `${group.members.length} operators · ${group.counts[1]} modified · ${group.counts[2] + group.counts[3]} unmatched`;
        for (const pair of this._entry.result.pairs.filter((pair) => pair.status !== 'identical' && group.members.includes(side === 0 ? pair.indexA : pair.indexB))) {
            this._panelButton(content, `Reveal ${this._nodeLabel(side, side === 0 ? pair.indexA : pair.indexB)}`, () => this._reveal(pair.indexA, pair.indexB));
        }
    }

    _nodeLabel(side, index) {
        const id = side === 0 ? this._entry.a : this._entry.b;
        const node = this._records[id]?.descriptions[index];
        return node?.name || `${node?.type?.name || 'Operator'} ${index}`;
    }

    _renderChanges() {
        const document = this._host.document;
        const list = document.getElementById('compare-changes');
        if (!list || !this._entry) {
            return;
        }
        list.replaceChildren();
        const filter = document.getElementById('compare-filter').value;
        const result = this._entry.result;
        const changes = [
            ...result.pairs.filter((pair) => pair.status === 'modified').map((pair) => ({ ...pair, label: this._nodeLabel(0, pair.indexA), status: 'modified' })),
            ...result.onlyInA.map((index) => ({ indexA: index, label: this._nodeLabel(0, index), status: 'removed' })),
            ...result.onlyInB.map((index) => ({ indexB: index, label: this._nodeLabel(1, index), status: 'added' }))
        ].filter((entry) => filter === 'all' || filter === entry.status);
        // The list is paged so a large diff does not create a second full graph's worth of DOM.
        let cursor = 0;
        const more = document.createElement('button');
        const append = () => {
            more.remove();
            for (const change of changes.slice(cursor, cursor + 100)) {
                const button = document.createElement('button');
                const status = { modified: 'Modified', removed: 'Unmatched in A', added: 'Unmatched in B' }[change.status];
                button.textContent = `${status}: ${change.label}`;
                button.addEventListener('click', () => this._reveal(change.indexA, change.indexB).catch((error) => this._showError(error)));
                list.appendChild(button);
            }
            cursor += 100;
            if (cursor < changes.length) {
                more.textContent = `Show next ${Math.min(100, changes.length - cursor)} changes`; list.appendChild(more);
            }
        };
        more.addEventListener('click', append);
        append();
    }

    async _reveal(indexA, indexB) {
        if (this._rendering) {
            return;
        }
        this._hideDiffPanel();
        if (this._grouped) {
            this._savePosition();
            for (const [side, index] of [indexA, indexB].entries()) {
                if (index !== undefined) {
                    for (const group of this._displays[side]._analysisProjection.groups) {
                        if (group.members.includes(index)) {
                            this._entry.expanded[side].add(group.key);
                        }
                    }
                }
            }
            await this._renderPair(this._entry);
        }
        for (const [side, index] of [indexA, indexB].entries()) {
            if (index !== undefined) {
                const graph = side === 0 ? this._graphA : this._graphB;
                const node = this._viewNode(graph, index, side);
                if (node) {
                    this._focusViewNode(graph, node); this._pulseNode(node);
                }
            }
        }
        this._entry.selection = [indexA, indexB];
    }

    async openBody(side, graph, context) {
        try {
            if (!this._analysis) {
                throw new Error('Nested body comparison requires the desktop analysis worker.');
            }
            if (this._entry.result.pending) {
                throw new Error('Nested bodies are still being compared.');
            }
            const owner = context?.owner ?? context?._originalIndex;
            const graphId = this._analysis.encoder.ids.get(graph);
            const candidates = this._entry.result.children.filter((child) =>
                (owner === undefined || (side === 0 ? child.nodeA : child.nodeB) === owner) &&
                (!context?.slot || child.slot === context.slot) && (side === 0 ? child.a : child.b) === graphId);
            if (candidates.length !== 1) {
                throw new Error('Select a specific function body from the operator inspector.');
            }
            await this._openChild(candidates[0]);
        } catch (error) {
            this._showError(error);
        }
    }

    _focusViewNode(graph, node) {
        graph._scrollToGraphBounds({ x: node.x - node.width / 2, y: node.y - node.height / 2,
            width: Math.min(node.width, graph._containerElement.clientWidth / graph.zoom * 0.8),
            height: Math.min(node.height, graph._containerElement.clientHeight / graph.zoom * 0.8) }, 'instant');
        graph._onViewportChange(graph._getViewportBounds());
    }

    async _openChild(child) {
        if (this._navigating || this._rendering) {
            return;
        }
        this._navigating = true;
        try {
            this._savePosition();
            this._history.push(this._entry);
            let entry = this._entries.get(child.pair);
            if (!entry) {
                const result = await this._analysis.result(child.pair);
                entry = { a: child.a, b: child.b, id: child.pair, result, expanded: [new Set(), new Set()] };
                this._entries.set(child.pair, entry);
            }
            await this._renderPair(entry);
        } finally {
            this._navigating = false;
        }
    }

    _openPanel(title) {
        const document = this._host.document;
        if (document.getElementById('diff-panel').classList.contains('hidden')) {
            this._panelReturnFocus = document.activeElement;
        }
        document.getElementById('diff-panel-title').textContent = title;
        const content = document.getElementById('diff-panel-content');
        content.replaceChildren();
        document.getElementById('diff-panel').classList.remove('hidden');
        document.getElementById('diff-panel-backdrop').classList.remove('hidden');
        document.getElementById('diff-panel-close').focus();
        return content;
    }

    _panelButton(content, label, action) {
        const button = this._host.document.createElement('button');
        button.textContent = label;
        button.className = 'body-link';
        button.addEventListener('click', () => action().catch((error) => this._showError(error)));
        content.appendChild(button);
    }

    inspectNode(side, node, index = node._originalIndex) {
        if (!Number.isInteger(index)) {
            this.inspectMetadata('Node metadata', node); return;
        }
        const pair = this._entry.result.pairs.find((pair) => (side === 0 ? pair.indexA : pair.indexB) === index);
        const content = this._openPanel(`Node: ${node.type?.name || node.name || 'Operator'}`);
        if (this._entry.error || this._entry.result.pending) {
            content.textContent = this._entry.error || 'Matching… Nested bodies have not finished comparison.';
        } else if (pair?.status === 'modified') {
            const a = this._targetA.nodes[pair.indexA]; const b = this._targetB.nodes[pair.indexB];
            // Body metadata is inspected through explicit paired links, never recursively formatted.
            const withoutBodies = (node) => ({ ...node, attributes: (node.attributes || []).filter((arg) => !['graph', 'graph[]', 'function', 'function[]'].includes(arg.type)) });
            this._renderModifiedDiff(this._host.document, content, withoutBodies(a), withoutBodies(b));
        } else if (pair) {
            this._renderIdenticalStatus(this._host.document, content, node.type.name);
        } else {
            this._renderSingleStatus(this._host.document, content, node.type.name, side === 0 ? 'removed' : 'added', `No confident match in Model ${side === 0 ? 'B' : 'A'}`);
        }
        for (const child of this._entry.result.children.filter((child) => (side === 0 ? child.nodeA : child.nodeB) === index)) {
            this._panelButton(content, `Compare body: ${child.slot}`, () => this._openChild(child));
        }
        const selection = [undefined, undefined];
        selection[side] = index;
        this._entry.selection = pair ? [pair.indexA, pair.indexB] : selection;
    }

    inspectMetadata(title, value) {
        const content = this._openPanel(title);
        const values = Array.isArray(value?.value) ? value.value : [value];
        for (const item of values) {
            const row = this._host.document.createElement('div');
            row.textContent = [item?.name, item?.type?.toString?.(), item?.quantization ? `Quantization: ${new Formatter(item.quantization).toString()}` : ''].filter(Boolean).join(' · ');
            content.appendChild(row);
        }
    }

    _showError(error) {
        const content = this._openPanel('Comparison');
        content.textContent = error.message;
    }

    _disposeContext(context) {
        const streams = new Set();
        if (context && context.stream) {
            streams.add(context.stream);
        }
        if (context && context.entries && typeof context.entries.values === 'function') {
            for (const stream of context.entries.values()) {
                streams.add(stream);
            }
        }
        for (const stream of streams) {
            if (stream && typeof stream.dispose === 'function') {
                stream.dispose();
            }
        }
    }

    _simpleHash(str) {
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0x7fffffff;
        }
        return hash.toString(36);
    }

    _nodeOutputs(node) {
        const last = (node.chain || []).at(-1);
        return last && last.outputs && last.outputs.length > 0 ? last.outputs : node.outputs || [];
    }

    _buildAdjacency(nodes) {
        const outputMap = new Map();
        const predecessors = new Map();
        const successors = new Map();
        for (let i = 0; i < nodes.length; i++) {
            predecessors.set(i, []);
            successors.set(i, []);
            const outputs = this._nodeOutputs(nodes[i]);
            for (const arg of outputs) {
                const values = Array.isArray(arg.value) ? arg.value : [];
                for (const val of values) {
                    if (val && val.name) {
                        outputMap.set(val.name, i);
                    }
                }
            }
        }
        for (let i = 0; i < nodes.length; i++) {
            const inputs = [...(nodes[i].inputs || []), { value: nodes[i].controlDependencies || [] }];
            for (const arg of inputs) {
                const values = Array.isArray(arg.value) ? arg.value : [];
                for (const val of values) {
                    if (val && val.name && outputMap.has(val.name)) {
                        const j = outputMap.get(val.name);
                        if (j !== i) {
                            predecessors.get(i).push(j);
                            successors.get(j).push(i);
                        }
                    }
                }
            }
        }
        return { predecessors, successors };
    }

    _computeWLLabels(nodes, adjacency, rounds) {
        const { predecessors, successors } = adjacency;
        let labels = new Map();
        for (let i = 0; i < nodes.length; i++) {
            const typeName = nodes[i].type && nodes[i].type.name ? nodes[i].type.name : '';
            labels.set(i, this._simpleHash(typeName));
        }
        for (let r = 0; r < rounds; r++) {
            const currentLabels = labels;
            const nextLabels = new Map();
            for (let i = 0; i < nodes.length; i++) {
                const predLabels = (predecessors.get(i) || []).map((j) => currentLabels.get(j)).sort();
                const succLabels = (successors.get(i) || []).map((j) => currentLabels.get(j)).sort();
                const combined = `${currentLabels.get(i)}|${predLabels.join(',')}|${succLabels.join(',')}`;
                nextLabels.set(i, this._simpleHash(combined));
            }
            labels = nextLabels;
        }
        return labels;
    }

    _scoreOpType(nodeA, nodeB) {
        const typeA = nodeA.type && nodeA.type.name ? nodeA.type.name : '';
        const typeB = nodeB.type && nodeB.type.name ? nodeB.type.name : '';
        if (typeA === typeB) {
            return 50;
        }
        return 0;
    }

    _extractSignature(node) {
        const extract = (args) => {
            const shapes = [];
            const dtypes = [];
            const argList = Array.isArray(args) ? args : [];
            for (const arg of argList) {
                const values = Array.isArray(arg.value) ? arg.value : [];
                for (const val of values) {
                    if (val && val.type && val.type.shape && Array.isArray(val.type.shape.dimensions)) {
                        shapes.push(val.type.shape.dimensions);
                    } else {
                        shapes.push(null);
                    }
                    if (val && val.type && val.type.dataType) {
                        dtypes.push(val.type.dataType);
                    } else {
                        dtypes.push(null);
                    }
                }
            }
            return { shapes, dtypes };
        };
        const attrs = Array.isArray(node.attributes) ? node.attributes : [];
        return { inputs: extract(node.inputs), outputs: extract(this._nodeOutputs(node)), attrs: new Map(attrs.map((a) => [a.name, a])) };
    }

    _signatureOf(node, ctx) {
        return ctx && ctx.sig ? ctx.sig : this._extractSignature(node);
    }

    _scoreAttributes(nodeA, nodeB, ctxA, ctxB) {
        const mapA = this._signatureOf(nodeA, ctxA).attrs;
        const mapB = this._signatureOf(nodeB, ctxB).attrs;
        const allNames = new Set([...mapA.keys(), ...mapB.keys()]);
        const totalUnique = allNames.size;
        if (totalUnique === 0) {
            return 30;
        }
        let earned = 0;
        for (const name of allNames) {
            const a = mapA.get(name);
            const b = mapB.get(name);
            if (a && b) {
                if (a.type === b.type && this._valuesEqual(a.value, b.value)) {
                    earned += 1.0;
                } else if (a.type === b.type) {
                    earned += 0.5;
                }
            }
        }
        return Math.round(30 * earned / totalUnique);
    }

    _scoreShapes(nodeA, nodeB, ctxA, ctxB) {
        let score = 0;
        const scoreShapePair = (shapesA, shapesB, maxPts) => {
            if (shapesA.length === 0 && shapesB.length === 0) {
                return maxPts;
            }
            if (shapesA.length === 0 || shapesB.length === 0) {
                return 0;
            }
            const minLen = Math.min(shapesA.length, shapesB.length);
            const maxLen = Math.max(shapesA.length, shapesB.length);
            let matched = 0;
            for (let k = 0; k < minLen; k++) {
                const sA = shapesA[k];
                const sB = shapesB[k];
                if (sA === null || sB === null) {
                    matched += 0.25;
                } else if (sA.length === sB.length) {
                    const dimMatch = sA.reduce((acc, d, idx) => acc + (d === sB[idx] ? 1 : 0), 0);
                    matched += sA.length === 0 ? 1 : 0.5 + 0.5 * dimMatch / sA.length;
                } else {
                    matched += 0.25;
                }
            }
            return Math.round(maxPts * matched / maxLen);
        };
        const scoreDtypes = (dtA, dtB, maxPts) => {
            if (dtA.length === 0 && dtB.length === 0) {
                return maxPts;
            }
            const maxLen = Math.max(dtA.length, dtB.length);
            if (maxLen === 0) {
                return maxPts;
            }
            const minLen = Math.min(dtA.length, dtB.length);
            let dtMatch = 0;
            for (let k = 0; k < minLen; k++) {
                if (dtA[k] && dtB[k] && dtA[k] === dtB[k]) {
                    dtMatch += 1;
                }
            }
            return Math.round(maxPts * dtMatch / maxLen);
        };

        const sigA = this._signatureOf(nodeA, ctxA);
        const sigB = this._signatureOf(nodeB, ctxB);

        score += scoreShapePair(sigA.inputs.shapes, sigB.inputs.shapes, 5);
        score += scoreShapePair(sigA.outputs.shapes, sigB.outputs.shapes, 5);
        score += scoreDtypes(sigA.inputs.dtypes, sigB.inputs.dtypes, 2);
        score += scoreDtypes(sigA.outputs.dtypes, sigB.outputs.dtypes, 2);

        if (ctxA && ctxB) {
            const degreeA = (ctxA.predCount || 0) + (ctxA.succCount || 0);
            const degreeB = (ctxB.predCount || 0) + (ctxB.succCount || 0);
            const maxDeg = Math.max(degreeA, degreeB, 1);
            const degSim = 1 - Math.abs(degreeA - degreeB) / maxDeg;
            score += Math.round(2 * degSim);
            if (ctxA.wlLabel && ctxB.wlLabel && ctxA.wlLabel === ctxB.wlLabel) {
                score += 2;
            }
        }

        return Math.min(score, 20);
    }

    _calculateSimilarity(nodeA, nodeB, ctxA, ctxB) {
        const opScore = this._scoreOpType(nodeA, nodeB);
        const attrScore = this._scoreAttributes(nodeA, nodeB, ctxA, ctxB);
        const shapeScore = this._scoreShapes(nodeA, nodeB, ctxA, ctxB);
        return opScore + attrScore + shapeScore;
    }

    _compareNodesPhase1(targetA, targetB) {
        const nodesA = targetA.nodes || [];
        const nodesB = targetB.nodes || [];
        const result = { pairs: [], onlyInA: [], onlyInB: [], pending: true };

        // Phase 0: Precompute adjacency, WL labels, and node contexts
        const adjA = this._buildAdjacency(nodesA);
        const adjB = this._buildAdjacency(nodesB);
        const wlA = this._computeWLLabels(nodesA, adjA, 2);
        const wlB = this._computeWLLabels(nodesB, adjB, 2);

        const ctxA = nodesA.map((_, i) => ({
            sig: this._extractSignature(nodesA[i]),
            wlLabel: wlA.get(i),
            predCount: (adjA.predecessors.get(i) || []).length,
            succCount: (adjA.successors.get(i) || []).length
        }));
        const ctxB = nodesB.map((_, i) => ({
            sig: this._extractSignature(nodesB[i]),
            wlLabel: wlB.get(i),
            predCount: (adjB.predecessors.get(i) || []).length,
            succCount: (adjB.successors.get(i) || []).length
        }));

        const matchedA = new Set();
        const matchedB = new Set();

        // Phase 1: Exact name matching (fast O(n) passes)
        const nameKeyFn = (nodes, idx, withGroup) => {
            const node = nodes[idx];
            const typeName = this._typeKey(node);
            const name = node.name || node.identifier || '';
            if (!name) {
                return null;
            }
            if (withGroup === null) {
                return name;
            }
            if (withGroup) {
                const group = node.group || '';
                return `${typeName}\0${name}\0${group}`;
            }
            return `${typeName}\0${name}`;
        };

        const exactMatch = (withGroup) => {
            const countsA = new Map();
            for (let i = 0; i < nodesA.length; i++) {
                if (!matchedA.has(i)) {
                    const key = nameKeyFn(nodesA, i, withGroup);
                    countsA.set(key, (countsA.get(key) || 0) + 1);
                }
            }
            const mapB = new Map();
            for (let j = 0; j < nodesB.length; j++) {
                if (matchedB.has(j)) {
                    continue;
                }
                const key = nameKeyFn(nodesB, j, withGroup);
                if (key) {
                    if (!mapB.has(key)) {
                        mapB.set(key, []);
                    }
                    mapB.get(key).push(j);
                }
            }
            for (let i = 0; i < nodesA.length; i++) {
                if (matchedA.has(i)) {
                    continue;
                }
                const key = nameKeyFn(nodesA, i, withGroup);
                if (!key) {
                    continue;
                }
                const candidates = mapB.get(key);
                if (!candidates || candidates.length !== 1 || countsA.get(key) !== 1) {
                    continue;
                }
                for (const j of candidates) {
                    if (!matchedB.has(j)) {
                        matchedA.add(i);
                        matchedB.add(j);
                        const status = this._nodeMetadataMatch(nodesA[i], nodesB[j]) ? 'identical' : 'modified';
                        result.pairs.push({ indexA: i, indexB: j, status });
                        break;
                    }
                }
            }
        };

        exactMatch(true);
        exactMatch(false);
        exactMatch(null);
        this._updatePairStatuses({ nodesA, nodesB, result });

        return { result, matchedA, matchedB, ctxA, ctxB, nodesA, nodesB, adjA, adjB };
    }

    _buildTopoOrder(nodes, adjacency) {
        const { predecessors, successors } = adjacency;
        const depth = new Array(nodes.length).fill(-1);
        const queue = [];
        for (let i = 0; i < nodes.length; i++) {
            if ((predecessors.get(i) || []).length === 0) {
                depth[i] = 0;
                queue.push(i);
            }
        }
        // BFS with iteration cap to guard against cyclic graphs
        const maxIter = nodes.length * 4 + 1;
        let head = 0;
        let iter = 0;
        while (head < queue.length && iter < maxIter) {
            iter++;
            const i = queue[head++];
            const d = depth[i] + 1;
            for (const j of (successors.get(i) || [])) {
                if (depth[j] < d) {
                    depth[j] = d;
                    queue.push(j);
                }
            }
        }
        const maxDepth = depth.reduce((m, d) => (d > m ? d : m), 0);
        for (let i = 0; i < nodes.length; i++) {
            if (depth[i] < 0) {
                depth[i] = maxDepth + 1;
            }
        }
        return depth;
    }

    _buildAlignmentTable(nodesA, nodesB, depthA, depthB, matchedSetA, matchedSetB, phase1Pairs) {
        const rows = [];
        // Sort matched pairs by graph-A topological depth (preserves A's partial order)
        for (const pair of phase1Pairs) {
            rows.push({
                indexA: pair.indexA,
                indexB: pair.indexB,
                sortKey: depthA[pair.indexA]
            });
        }
        for (let i = 0; i < nodesA.length; i++) {
            if (!matchedSetA.has(i)) {
                rows.push({ indexA: i, indexB: null, sortKey: depthA[i] });
            }
        }
        for (let j = 0; j < nodesB.length; j++) {
            if (!matchedSetB.has(j)) {
                rows.push({ indexA: null, indexB: j, sortKey: depthB[j] });
            }
        }
        rows.sort((a, b) => a.sortKey - b.sortKey);
        return rows;
    }

    _applyYAlignment(graphA, graphB, nodesA, nodesB, alignTable, targetA, targetB) {
        const ROW_GAP = 20;
        const MIN_ROW_H = 60;
        let curY = 0;
        for (const row of alignTable) {
            const vnA = row.indexA === null ? null : graphA._table.get(nodesA[row.indexA]);
            const vnB = row.indexB === null ? null : graphB._table.get(nodesB[row.indexB]);
            const hA = vnA ? (vnA.height || MIN_ROW_H) : 0;
            const hB = vnB ? (vnB.height || MIN_ROW_H) : 0;
            const rowH = Math.max(hA, hB, MIN_ROW_H);
            if (vnA) {
                vnA.y = curY + rowH / 2;
            }
            if (vnB) {
                vnB.y = curY + rowH / 2;
            }
            curY += rowH + ROW_GAP;
        }
        // Keep graph endpoints outside the aligned operator rows so they cannot cover clickable nodes.
        for (const [graph, target] of [[graphA, targetA], [graphB, targetB]]) {
            for (const [args, direction, start] of [[target.inputs, -1, -ROW_GAP], [target.outputs, 1, curY]]) {
                let y = start;
                for (const arg of args || []) {
                    const node = graph._table.get(arg);
                    if (node) {
                        const height = node.height || MIN_ROW_H;
                        node.y = y + direction * height / 2;
                        y += direction * (height + ROW_GAP);
                    }
                }
            }
        }
        // Recompute edge points as straight lines between updated node centers
        const straightenEdges = (graph) => {
            for (const edge of graph.edges.values()) {
                const from = edge.label && edge.label.from;
                const to = edge.label && edge.label.to;
                if (from && to && typeof from.x === 'number' && typeof to.x === 'number') {
                    edge.label.points = [
                        { x: from.x, y: from.y },
                        { x: to.x, y: to.y }
                    ];
                }
            }
        };
        straightenEdges(graphA);
        straightenEdges(graphB);
        // Invalidate layout bounds so restore() recomputes from actual SVG bbox
        graphA._layoutBounds = null;
        graphB._layoutBounds = null;
    }

    _typeKey(node) {
        const type = node.type || {};
        return JSON.stringify([type.module || type.domain || '', type.name || '']);
    }

    *_matchGroupInPlace(groupA, groupB, threshold, nodesA, nodesB, ctxA, ctxB, matchedA, matchedB, result) {
        // Tied candidates have no reliable identity; leave them unmatched rather than inventing pairs.
        const bestA = groupA.map(() => ({ score: threshold - 1, index: -1, tied: false }));
        const bestB = groupB.map(() => ({ score: threshold - 1, index: -1, tied: false }));
        const update = (best, score, index) => {
            if (score > best.score) {
                best.score = score;
                best.index = index;
                best.tied = false;
            } else if (score === best.score) {
                best.tied = true;
            }
        };
        let deadline = performance.now() + 8;
        let comparisons = 0;
        for (let ai = 0; ai < groupA.length; ai++) {
            for (let bi = 0; bi < groupB.length; bi++) {
                const ia = groupA[ai];
                const ib = groupB[bi];
                const score = this._calculateSimilarity(nodesA[ia], nodesB[ib], ctxA[ia], ctxB[ib]);
                update(bestA[ai], score, bi);
                update(bestB[bi], score, ai);
                if (++comparisons % 64 === 0 && performance.now() >= deadline) {
                    yield;
                    deadline = performance.now() + 8;
                }
            }
        }
        for (let ai = 0; ai < groupA.length; ai++) {
            const best = bestA[ai];
            const bi = best.index;
            if (bi < 0 || best.tied || bestB[bi].tied || bestB[bi].index !== ai) {
                continue;
            }
            const indexA = groupA[ai];
            const indexB = groupB[bi];
            matchedA.add(indexA);
            matchedB.add(indexB);
            const status = this._nodeMetadataMatch(nodesA[indexA], nodesB[indexB]) ? 'identical' : 'modified';
            result.pairs.push({ indexA, indexB, status });
        }
    }

    _compareNodesPhase2(phase1State, onComplete) {
        const { matchedA, matchedB, ctxA, ctxB, nodesA, nodesB, result } = phase1State;

        // Build type groups from unmatched nodes
        const typeGroupsA = new Map();
        const typeGroupsB = new Map();
        for (let i = 0; i < nodesA.length; i++) {
            if (!matchedA.has(i)) {
                const t = this._typeKey(nodesA[i]);
                if (!typeGroupsA.has(t)) {
                    typeGroupsA.set(t, []);
                }
                typeGroupsA.get(t).push(i);
            }
        }
        for (let j = 0; j < nodesB.length; j++) {
            if (!matchedB.has(j)) {
                const t = this._typeKey(nodesB[j]);
                if (!typeGroupsB.has(t)) {
                    typeGroupsB.set(t, []);
                }
                typeGroupsB.get(t).push(j);
            }
        }

        // Collect type group pairs to process
        const typeGroupPairs = [];
        for (const [typeName, groupA] of typeGroupsA) {
            const groupB = typeGroupsB.get(typeName);
            if (groupB && groupB.length > 0) {
                typeGroupPairs.push({ groupA, groupB });
            }
        }

        // Large operator groups must also yield while scanning candidates.
        let groupIndex = 0;
        let matching = null;
        const processNext = () => {
            if (groupIndex < typeGroupPairs.length) {
                if (!matching) {
                    const { groupA, groupB } = typeGroupPairs[groupIndex];
                    matching = this._matchGroupInPlace(groupA, groupB, 80, nodesA, nodesB, ctxA, ctxB, matchedA, matchedB, result);
                }
                if (matching.next().done) {
                    matching = null;
                    groupIndex++;
                }
                this._phase2Timer = setTimeout(processNext, 0);
            } else {
                this._updatePairStatuses(phase1State);

                // Phase 4: Collect remaining unmatched
                result.onlyInA = [];
                result.onlyInB = [];
                for (let i = 0; i < nodesA.length; i++) {
                    if (!matchedA.has(i)) {
                        result.onlyInA.push(i);
                    }
                }
                for (let j = 0; j < nodesB.length; j++) {
                    if (!matchedB.has(j)) {
                        result.onlyInB.push(j);
                    }
                }

                result.pending = false;
                this._phase2Timer = null;
                onComplete(result);
            }
        };
        this._phase2Timer = setTimeout(processNext, 0);
    }

    _portMetadata(args) {
        return (args || []).map((arg) => ({ name: arg.name, type: arg.type,
            values: Array.isArray(arg.value) ? arg.value.map((value) => ({
                type: value.type, quantization: value.quantization,
                initializer: value.initializer ? { type: value.initializer.type,
                    category: value.initializer.category, encoding: value.initializer.encoding,
                    layout: value.initializer.layout, quantization: value.initializer.quantization } : null
            })) : arg.value }));
    }

    _nodeMetadataMatch(a, b) {
        const chainA = a.chain || [];
        const chainB = b.chain || [];
        return chainA.length === chainB.length && chainA.every((node, i) => this._nodeMetadataMatch(node, chainB[i])) &&
            this._typeKey(a) === this._typeKey(b) &&
            this._valuesEqual(a.type && a.type.version, b.type && b.type.version) &&
            this._attributesMatch(a, b) &&
            this._valuesEqual(this._portMetadata(a.inputs), this._portMetadata(b.inputs)) &&
            this._valuesEqual(this._portMetadata(a.outputs), this._portMetadata(b.outputs));
    }

    _updatePairStatuses({ nodesA, nodesB, result }) {
        const mapping = new Map(result.pairs.map((pair) => [pair.indexA, pair.indexB]));
        const producers = (nodes) => {
            const map = new Map();
            nodes.forEach((node, index) => this._nodeOutputs(node).forEach((arg, port) => {
                (Array.isArray(arg.value) ? arg.value : []).forEach((value, slot) => {
                    if (value.name) {
                        map.set(value.name, { index, port, slot });
                    }
                });
            }));
            return map;
        };
        const prodA = producers(nodesA);
        const prodB = producers(nodesB);
        const connections = (node, map, translate) => [...(node.inputs || []), { value: node.controlDependencies || [] }].map((arg) =>
            (Array.isArray(arg.value) ? arg.value : []).map((value) => {
                const source = map.get(value.name);
                return source ? { index: translate ? mapping.get(source.index) ?? `unmatched:${source.index}` : source.index,
                    port: source.port, slot: source.slot } : { external: value.initializer ? 'initializer' : value.name };
            }));
        for (const pair of result.pairs) {
            const a = nodesA[pair.indexA];
            const b = nodesB[pair.indexB];
            pair.status = this._nodeMetadataMatch(a, b) &&
                this._valuesEqual(connections(a, prodA, true), connections(b, prodB, false)) ? 'identical' : 'modified';
        }
    }

    _attributesMatch(nodeA, nodeB) {
        if (!nodeA || !nodeB) {
            return false;
        }
        const attrsA = Array.isArray(nodeA.attributes) ? nodeA.attributes : [];
        const attrsB = Array.isArray(nodeB.attributes) ? nodeB.attributes : [];
        if (attrsA.length !== attrsB.length) {
            return false;
        }
        const byName = (a, b) => String(a.name).localeCompare(String(b.name));
        const sortedA = attrsA.slice().sort(byName);
        const sortedB = attrsB.slice().sort(byName);
        return sortedA.every((a, i) => a.name === sortedB[i].name && a.type === sortedB[i].type &&
            this._valuesEqual(a.value, sortedB[i].value));
    }

    _valuesEqual(a, b, seen = new WeakMap()) {
        if (Object.is(a, b)) {
            return true;
        }
        if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || a.constructor !== b.constructor) {
            return false;
        }
        if (seen.get(a)?.has(b)) {
            return true;
        }
        if (!seen.has(a)) {
            seen.set(a, new WeakSet());
        }
        seen.get(a).add(b);
        if (a instanceof Date) {
            return a.getTime() === b.getTime();
        }
        if (a instanceof ArrayBuffer || ArrayBuffer.isView(a)) {
            const bytes = (v) => v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
            const aa = bytes(a);
            const bb = bytes(b);
            return aa.length === bb.length && aa.every((value, index) => value === bb[index]);
        }
        if (a instanceof Map) {
            return a.size === b.size && Array.from(a).every(([key, value]) =>
                b.has(key) && this._valuesEqual(value, b.get(key), seen));
        }
        if (a instanceof Set) {
            return a.size === b.size && Array.from(a).every((value) => b.has(value));
        }
        // Tensor payloads may be remote: compare their metadata without fetching weight bytes.
        if (a.type && a.type.shape && ('values' in a || 'encoding' in a)) {
            return this._valuesEqual([a.type, a.encoding, a.layout, a.quantization],
                [b.type, b.encoding, b.layout, b.quantization], seen);
        }
        const keysA = Object.keys(a);
        const keysB = Object.keys(b);
        return keysA.length === keysB.length && keysA.every((key) =>
            Object.prototype.hasOwnProperty.call(b, key) && this._valuesEqual(a[key], b[key], seen));
    }

    _applyDiffHighlighting(graphA, graphB, targetA, targetB, diffResult) {
        const nodesA = targetA.nodes || [];
        const nodesB = targetB.nodes || [];

        const getViewNode = (graph, nodes, index) => graph._sourceNodes ? graph._sourceNodes.get(index) : graph._table.get(nodes[index]);
        const apply = (node, className) => {
            if (!node || (node._diffClass || null) === className) {
                return;
            }
            node._diffClass = className;
            if (node.element) {
                node.element.classList.remove('node-diff-modified', 'node-diff-added', 'node-diff-removed');
                if (className) {
                    node.element.classList.add(className);
                }
            }
        };

        for (const pair of diffResult.pairs) {
            const className = pair.status === 'modified' ? 'node-diff-modified' : null;
            apply(getViewNode(graphA, nodesA, pair.indexA), className);
            apply(getViewNode(graphB, nodesB, pair.indexB), className);
        }
        for (const idx of diffResult.onlyInA) {
            const viewNode = getViewNode(graphA, nodesA, idx);
            apply(viewNode, 'node-diff-removed');
        }
        for (const idx of diffResult.onlyInB) {
            const viewNode = getViewNode(graphB, nodesB, idx);
            apply(viewNode, 'node-diff-added');
        }
        for (const [side, graph] of [graphA, graphB].entries()) {
            for (const group of this._displays?.[side]?._hierarchy?.groups.values() || []) {
                const [same, modified, added, removed] = group.counts;
                let className = null;
                if (modified || (same && (added || removed))) {
                    className = 'node-diff-modified';
                } else if (added) {
                    className = 'node-diff-added';
                } else if (removed) {
                    className = 'node-diff-removed';
                }
                apply(graph._groupNodes.get(group.id), className);
            }
        }
    }

    _setupSync(containerLeft, containerRight) {
        // Synchronized scrolling
        const syncScroll = (source, target) => {
            if (this._syncing) {
                return;
            }
            try {
                this._syncing = true;
                target.scrollLeft = source.scrollLeft;
                target.scrollTop = source.scrollTop;
            } finally {
                this._syncing = false;
            }
        };

        this._syncDispose?.();
        const leftScroll = () => {
            syncScroll(containerLeft, containerRight); this._updateConnectors();
        };
        const rightScroll = () => {
            syncScroll(containerRight, containerLeft); this._updateConnectors();
        };
        containerLeft.addEventListener('scroll', leftScroll);
        containerRight.addEventListener('scroll', rightScroll);
        this._syncDispose = () => {
            containerLeft.removeEventListener('scroll', leftScroll);
            containerRight.removeEventListener('scroll', rightScroll);
        };

        // Synchronized zooming — wrap _updateZoom on both graphs
        if (!this._graphA._updateZoom || !this._graphB._updateZoom) {
            return;
        }
        const originalZoomA = this._graphA._updateZoom.bind(this._graphA);
        const originalZoomB = this._graphB._updateZoom.bind(this._graphB);

        this._graphA._updateZoom = (zoom, e) => {
            originalZoomA(zoom, e);
            if (!this._syncing) {
                try {
                    this._syncing = true;
                    originalZoomB(zoom, null);
                    containerRight.scrollLeft = containerLeft.scrollLeft;
                    containerRight.scrollTop = containerLeft.scrollTop;
                } finally {
                    this._syncing = false;
                }
            }
            this._updateConnectors();
        };

        this._graphB._updateZoom = (zoom, e) => {
            originalZoomB(zoom, e);
            if (!this._syncing) {
                try {
                    this._syncing = true;
                    originalZoomA(zoom, null);
                    containerLeft.scrollLeft = containerRight.scrollLeft;
                    containerLeft.scrollTop = containerRight.scrollTop;
                } finally {
                    this._syncing = false;
                }
            }
            this._updateConnectors();
        };
    }

    _buildDiffLookup(targetA, targetB, diffResult) {
        const nodesA = targetA.nodes || [];
        const nodesB = targetB.nodes || [];
        this._nodeDiffMap = new Map();
        for (const pair of diffResult.pairs) {
            const nodeA = pair.indexA < nodesA.length ? nodesA[pair.indexA] : null;
            const nodeB = pair.indexB < nodesB.length ? nodesB[pair.indexB] : null;
            if (nodeA) {
                this._nodeDiffMap.set(nodeA, { status: pair.status, nodeA, nodeB });
            }
            if (nodeB) {
                this._nodeDiffMap.set(nodeB, { status: pair.status, nodeA, nodeB });
            }
        }
        for (const idx of diffResult.onlyInA) {
            const node = idx < nodesA.length ? nodesA[idx] : null;
            if (node) {
                this._nodeDiffMap.set(node, { status: 'removed', nodeA: node, nodeB: null });
            }
        }
        for (const idx of diffResult.onlyInB) {
            const node = idx < nodesB.length ? nodesB[idx] : null;
            if (node) {
                this._nodeDiffMap.set(node, { status: 'added', nodeA: null, nodeB: node });
            }
        }
    }

    showNodeDiff(node) {
        const diffInfo = this._nodeDiffMap ? this._nodeDiffMap.get(node) : null;
        if (!diffInfo) {
            return;
        }
        const document = this._host.document;
        const panel = document.getElementById('diff-panel');
        const backdrop = document.getElementById('diff-panel-backdrop');
        const title = document.getElementById('diff-panel-title');
        const content = document.getElementById('diff-panel-content');
        if (!panel || !backdrop || !title || !content) {
            return;
        }
        content.innerHTML = '';
        const typeName = node.type && node.type.name ? node.type.name : 'Unknown';
        title.textContent = `Node: ${typeName}`;
        if (diffInfo.status === 'identical') {
            this._renderIdenticalStatus(document, content, typeName);
        } else if (diffInfo.status === 'added') {
            this._renderSingleStatus(document, content, typeName, 'added', 'No confident match in Model A');
        } else if (diffInfo.status === 'removed') {
            this._renderSingleStatus(document, content, typeName, 'removed', 'No confident match in Model B');
        } else if (diffInfo.status === 'modified') {
            this._renderModifiedDiff(document, content, diffInfo.nodeA, diffInfo.nodeB);
        }
        panel.classList.remove('hidden');
        backdrop.classList.remove('hidden');
        if (!this._diffPanelInitialized) {
            this._diffPanelInitialized = true;
            document.getElementById('diff-panel-close').addEventListener('click', () => {
                this._hideDiffPanel();
            });
            backdrop.addEventListener('click', () => {
                this._hideDiffPanel();
            });
            document.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    this._hideDiffPanel();
                }
            });
        }

        // Jump to match and pulse both nodes
        if ((diffInfo.status === 'modified' || diffInfo.status === 'identical') && diffInfo.nodeA && diffInfo.nodeB) {
            const isInA = diffInfo.nodeA === node;
            const matchedModel = isInA ? diffInfo.nodeB : diffInfo.nodeA;
            const matchedGraph = isInA ? this._graphB : this._graphA;
            const clickedGraph = isInA ? this._graphA : this._graphB;
            const matchedContainer = isInA
                ? document.getElementById('target-right')
                : document.getElementById('target-left');
            const matchedVN = matchedGraph._table ? matchedGraph._table.get(matchedModel) : null;
            const clickedVN = clickedGraph._table ? clickedGraph._table.get(node) : null;
            if (matchedVN && matchedVN.element && matchedContainer) {
                this._jumpToMatchNode(matchedVN, matchedContainer);
            }
            this._pulseNode(matchedVN);
            this._pulseNode(clickedVN);
        }
    }

    _hideDiffPanel() {
        const document = this._host.document;
        const panel = document.getElementById('diff-panel');
        const backdrop = document.getElementById('diff-panel-backdrop');
        if (panel) {
            const visible = !panel.classList.contains('hidden');
            panel.classList.add('hidden');
            if (visible) {
                this._panelReturnFocus?.focus?.();
            }
        }
        if (backdrop) {
            backdrop.classList.add('hidden');
        }
    }

    _renderIdenticalStatus(document, container, typeName) {
        const div = document.createElement('div');
        div.className = 'diff-status';
        const badge = document.createElement('div');
        badge.className = 'diff-status-badge diff-status-identical';
        badge.textContent = 'Same structure';
        div.appendChild(badge);
        const text = document.createElement('div');
        text.textContent = `This node (${typeName}) has the same compared structure and metadata. Weight values are not compared.`;
        div.appendChild(text);
        container.appendChild(div);
    }

    _renderSingleStatus(document, container, typeName, status, message) {
        const div = document.createElement('div');
        div.className = 'diff-status';
        const badge = document.createElement('div');
        badge.className = `diff-status-badge diff-status-${status}`;
        badge.textContent = status === 'added' ? 'Unmatched in B' : 'Unmatched in A';
        div.appendChild(badge);
        const text = document.createElement('div');
        text.textContent = `${typeName}: ${message}`;
        div.appendChild(text);
        container.appendChild(div);
    }

    _renderModifiedDiff(document, container, nodeA, nodeB) {
        if (!nodeA || !nodeB) {
            const typeName = (nodeA || nodeB).type && (nodeA || nodeB).type.name ? (nodeA || nodeB).type.name : 'Node';
            this._renderSingleStatus(document, container, typeName,
                nodeA ? 'removed' : 'added', nodeA ? 'No confident match in Model B' : 'No confident match in Model A');
            return;
        }
        // Type section
        const typeSection = this._createSection(document, 'Type');
        let hasTypeDiffs = false;
        const typeNameA = nodeA.type && nodeA.type.name ? nodeA.type.name : '';
        const typeNameB = nodeB.type && nodeB.type.name ? nodeB.type.name : '';
        if (typeNameA !== typeNameB) {
            typeSection.appendChild(this._createDiffRow(document, 'name', typeNameA, typeNameB, 'changed'));
            hasTypeDiffs = true;
        }
        const moduleA = (nodeA.type && nodeA.type.module) || '';
        const moduleB = (nodeB.type && nodeB.type.module) || '';
        if (moduleA !== moduleB) {
            typeSection.appendChild(this._createDiffRow(document, 'module', moduleA, moduleB, 'changed'));
            hasTypeDiffs = true;
        }
        const versionA = (nodeA.type && nodeA.type.version) || '';
        const versionB = (nodeB.type && nodeB.type.version) || '';
        if (versionA !== versionB) {
            typeSection.appendChild(this._createDiffRow(document, 'version', versionA, versionB, 'changed'));
            hasTypeDiffs = true;
        }
        if (hasTypeDiffs) {
            container.appendChild(typeSection);
        }

        // Properties section
        const propsSection = this._createSection(document, 'Properties');
        let hasPropDiffs = false;
        for (const prop of ['name', 'identifier', 'description', 'device']) {
            const valA = nodeA[prop] || '';
            const valB = nodeB[prop] || '';
            if (valA !== valB) {
                propsSection.appendChild(this._createDiffRow(document, prop, valA, valB, 'changed'));
                hasPropDiffs = true;
            }
        }
        if (hasPropDiffs) {
            container.appendChild(propsSection);
        }

        // Attributes section
        const attrsA = Array.isArray(nodeA.attributes) ? nodeA.attributes : [];
        const attrsB = Array.isArray(nodeB.attributes) ? nodeB.attributes : [];
        const attrDiffs = this._diffNamedItems(attrsA, attrsB, (attr) => {
            try {
                return `${new Formatter(attr.value, attr.type).toString()} (${attr.type || 'unknown type'})`;
            } catch {
                return String(attr.value);
            }
        });
        if (attrDiffs.length > 0) {
            const section = this._createSection(document, 'Attributes');
            for (const diff of attrDiffs) {
                section.appendChild(this._createDiffRow(document, diff.name, diff.valueA, diff.valueB, diff.type));
            }
            container.appendChild(section);
        }

        // Inputs section
        const inputsA = Array.isArray(nodeA.inputs) ? nodeA.inputs : [];
        const inputsB = Array.isArray(nodeB.inputs) ? nodeB.inputs : [];
        const inputDiffs = this._diffConnections(inputsA, inputsB);
        if (inputDiffs.length > 0) {
            const section = this._createSection(document, 'Inputs');
            for (const diff of inputDiffs) {
                section.appendChild(this._createDiffRow(document, diff.name, diff.valueA, diff.valueB, diff.type));
            }
            container.appendChild(section);
        }

        // Outputs section
        const outputsA = Array.isArray(nodeA.outputs) ? nodeA.outputs : [];
        const outputsB = Array.isArray(nodeB.outputs) ? nodeB.outputs : [];
        const outputDiffs = this._diffConnections(outputsA, outputsB);
        if (outputDiffs.length > 0) {
            const section = this._createSection(document, 'Outputs');
            for (const diff of outputDiffs) {
                section.appendChild(this._createDiffRow(document, diff.name, diff.valueA, diff.valueB, diff.type));
            }
            container.appendChild(section);
        }

        // Fallback if no specific diffs found
        if (!container.hasChildNodes()) {
            container.textContent = 'Graph connections or tensor metadata differ.';
        }
    }

    _createSection(document, title) {
        const section = document.createElement('div');
        section.className = 'diff-section';
        const heading = document.createElement('div');
        heading.className = 'diff-section-title';
        heading.textContent = title;
        section.appendChild(heading);
        return section;
    }

    _createDiffRow(document, label, valueA, valueB, type) {
        const row = document.createElement('div');
        row.className = `diff-row diff-${type}`;
        const labelEl = document.createElement('span');
        labelEl.className = 'diff-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);
        const valA = document.createElement('span');
        valA.className = 'diff-value-a';
        valA.textContent = type === 'added' ? '' : (valueA || '(empty)');
        row.appendChild(valA);
        const arrow = document.createElement('span');
        arrow.className = 'diff-arrow';
        arrow.textContent = '\u2192';
        row.appendChild(arrow);
        const valB = document.createElement('span');
        valB.className = 'diff-value-b';
        valB.textContent = type === 'removed' ? '' : (valueB || '(empty)');
        row.appendChild(valB);
        return row;
    }

    _diffNamedItems(itemsA, itemsB, formatter) {
        const diffs = [];
        const mapA = new Map(itemsA.map((a) => [a.name, a]));
        const mapB = new Map(itemsB.map((a) => [a.name, a]));
        const allNames = new Set([...mapA.keys(), ...mapB.keys()]);
        for (const name of allNames) {
            const a = mapA.get(name);
            const b = mapB.get(name);
            if (a && !b) {
                diffs.push({ name, valueA: formatter(a), valueB: '', type: 'removed' });
            } else if (!a && b) {
                diffs.push({ name, valueA: '', valueB: formatter(b), type: 'added' });
            } else if (a && b && (a.type !== b.type || !this._valuesEqual(a.value, b.value))) {
                diffs.push({ name, valueA: formatter(a), valueB: formatter(b), type: 'changed' });
            }
        }
        return diffs;
    }

    _diffConnections(connectionsA, connectionsB) {
        const diffs = [];
        for (let i = 0; i < Math.max(connectionsA.length, connectionsB.length); i++) {
            const a = connectionsA[i];
            const b = connectionsB[i];
            const descA = a ? this._describeConnection(a) : '';
            const descB = b ? this._describeConnection(b) : '';
            let type = 'changed';
            if (a === undefined) {
                type = 'added';
            } else if (b === undefined) {
                type = 'removed';
            }
            if (!a || !b || descA !== descB || !this._valuesEqual(this._portMetadata([a]), this._portMetadata([b]))) {
                diffs.push({ name: `${a?.name || b?.name || 'port'} [${i}]`, valueA: descA,
                    valueB: descB === descA ? `${descB} (metadata changed)` : descB,
                    type });
            }
        }
        return diffs;
    }

    _describeConnection(connection) {
        if (Array.isArray(connection.value)) {
            return connection.value.map((arg) => {
                const parts = [];
                if (arg.name) {
                    parts.push(arg.name);
                }
                if (arg.type) {
                    parts.push(`[${arg.type}]`);
                }
                return parts.join(' ') || '?';
            }).join(', ');
        }
        return connection.type || '';
    }

    _updateConnectors() {
        const document = this._host.document;
        const overlay = document.getElementById('connector-overlay');
        if (!overlay || !this._diffResult || !this._graphA || !this._graphB) {
            return;
        }
        while (overlay.firstChild) {
            overlay.removeChild(overlay.firstChild);
        }
        if (!this._connectorPairs) {
            const bundles = new Map();
            for (const pair of this._diffResult.pairs) {
                const a = this._viewNode(this._graphA, pair.indexA, 0);
                const b = this._viewNode(this._graphB, pair.indexB, 1);
                if (!a || !b) {
                    continue;
                }
                const key = `${a.name}\0${b.name}`;
                const bundle = bundles.get(key);
                if (!bundle) {
                    bundles.set(key, { a, b, status: pair.status });
                } else if (pair.status === 'modified') {
                    bundle.status = 'modified';
                }
            }
            this._connectorPairs = [...bundles.values()];
        }
        const pairs = this._connectorPairs;
        const MAX_CONNECTORS = 300;
        let drawn = 0;
        for (const pair of pairs) {
            if (drawn >= MAX_CONNECTORS) {
                break;
            }
            const vnA = pair.a;
            const vnB = pair.b;
            if (!vnA || !vnA.element || !vnB || !vnB.element) {
                continue;
            }
            const rA = vnA.element.getBoundingClientRect();
            const rB = vnB.element.getBoundingClientRect();
            if (rA.width === 0 || rB.width === 0) {
                continue;
            }
            const vh = window.innerHeight;
            const vw = window.innerWidth;
            if (rA.bottom < 0 || rA.top > vh || rA.right < 0 || rA.left > vw) {
                continue;
            }
            if (rB.bottom < 0 || rB.top > vh || rB.right < 0 || rB.left > vw) {
                continue;
            }
            const x1 = rA.right;
            const y1 = rA.top + rA.height / 2;
            const x2 = rB.left;
            const y2 = rB.top + rB.height / 2;
            const dx = Math.abs(x2 - x1) * 0.4;
            const color = pair.status === 'modified'
                ? 'rgba(230,126,34,0.55)'
                : 'rgba(150,150,150,0.22)';
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', `M ${x1} ${y1} C ${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', color);
            path.setAttribute('stroke-width', '1.5');
            overlay.appendChild(path);
            drawn++;
        }
    }

    _updateSummaryBar(diffResult) {
        const document = this._host.document;
        const bar = document.getElementById('diff-summary');
        if (!bar) {
            return;
        }
        const identical = diffResult.pairs.filter((p) => p.status === 'identical').length;
        const modified = diffResult.pairs.filter((p) => p.status === 'modified').length;
        const added = (diffResult.onlyInB || []).length;
        const removed = (diffResult.onlyInA || []).length;
        let progress = diffResult.pending ? 'Matching… Nested bodies pending. ' : '';
        if (this._entry?.error) {
            progress = 'Analysis incomplete. Nested bodies not compared. ';
        }
        bar.innerHTML = [
            `<span title="Active graph structure and metadata only; weight values are not compared." class="summary-count summary-identical">${identical} same structure</span>`,
            `<span class="summary-sep">|</span>`,
            `<span class="summary-count summary-modified">${modified} modified</span>`,
            `<span class="summary-sep">|</span>`,
            `<span class="summary-count summary-added">${added} unmatched in B</span>`,
            `<span class="summary-sep">|</span>`,
            `<span class="summary-count summary-removed">${removed} unmatched in A</span>`,
            `<span class="summary-sep"> | </span>`,
            `<span>${progress}${diffResult.interfaceChanged ? 'Graph interface or output connections changed. ' : ''}${this._history?.length ? 'Active subgraph' : 'Primary graph'}; weight values are not compared.</span>`
        ].join('');
    }

    _jumpToMatchNode(matchedViewNode, container) {
        if (!matchedViewNode || !matchedViewNode.element || !container) {
            return;
        }
        const rect = matchedViewNode.element.getBoundingClientRect();
        const cRect = container.getBoundingClientRect();
        const desired = container.scrollTop + (rect.top - cRect.top) - (cRect.height - rect.height) / 2;
        this._syncing = true;
        container.scrollTo({ top: Math.max(0, desired), behavior: 'smooth' });
        setTimeout(() => {
            this._syncing = false;
        }, 700);
    }

    _pulseNode(viewNode) {
        if (!viewNode || !viewNode.element) {
            return;
        }
        viewNode.element.classList.add('node-diff-selected');
        setTimeout(() => {
            if (viewNode.element) {
                viewNode.element.classList.remove('node-diff-selected');
            }
        }, 1500);
    }
};

export const Controller = comparator.Controller;
