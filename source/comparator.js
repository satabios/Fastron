
import { Formatter, Graph, ModelFactoryService, Worker } from './view.js';

const comparator = {};

comparator.ViewProxy = class {

    constructor(host, model, options) {
        this._host = host;
        this._model = model;
        this._options = options;
        this._controller = null;
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

    showNodeProperties(node) {
        if (this._controller) {
            this._controller.showNodeDiff(node);
        }
    }
};

comparator.Controller = class {

    constructor(host) {
        this._host = host;
        this._modelFactory = new ModelFactoryService(host);
        this._modelFactory.import();
        this._worker = host.environment('serial') ? null : new Worker(host);
        this._syncing = false;
        this._comparing = false;
        this._graphA = null;
        this._graphB = null;
        this._nodeDiffMap = null;
        this._diffPanelInitialized = false;
    }

    _reset() {
        const document = this._host.document;
        this._hideDiffPanel();
        // Clear previous graph contents
        const containerLeft = document.getElementById('target-left');
        const containerRight = document.getElementById('target-right');
        if (containerLeft) {
            containerLeft.replaceChildren();
        }
        if (containerRight) {
            containerRight.replaceChildren();
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
            viewProxyA._controller = this;
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
            viewProxyB._controller = this;
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

            // Store references for diff panel lookup
            this._targetA = targetA;
            this._targetB = targetB;
            this._diffResult = diffResult;
            this._buildDiffLookup(targetA, targetB, diffResult);

            // Setup synchronized navigation
            this._setupSync(containerLeft, containerRight);

            // Register event handlers on both graphs
            this._graphA.register();
            this._graphB.register();

            // Hide spinner on success
            const loadSpinner = document.getElementById('comparator-spinner');
            if (loadSpinner) {
                loadSpinner.classList.add('hidden');
            }

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

    _compareNodes(targetA, targetB) {
        const nodesA = targetA.nodes || [];
        const nodesB = targetB.nodes || [];
        const result = {
            pairs: [],
            onlyInA: [],
            onlyInB: []
        };

        const matchedB = new Set();

        // Helper to build a match key from node type name and node name
        const nodeKey = (node) => {
            const typeName = node && node.type && node.type.name ? node.type.name : '';
            const name = node && node.name ? node.name : '';
            return `${typeName}\0${name}`;
        };

        const typeName = (node) => {
            return node && node.type && node.type.name ? node.type.name : '';
        };

        // Build lookup maps for B nodes
        // Key: "typeName\0nodeName" -> array of indices (multiple nodes can share a key)
        const keyMapB = new Map();
        for (let j = 0; j < nodesB.length; j++) {
            const key = nodeKey(nodesB[j]);
            if (!keyMapB.has(key)) {
                keyMapB.set(key, []);
            }
            keyMapB.get(key).push(j);
        }
        // Type-only lookup for fallback matching
        const typeMapB = new Map();
        for (let j = 0; j < nodesB.length; j++) {
            const tn = typeName(nodesB[j]);
            if (!typeMapB.has(tn)) {
                typeMapB.set(tn, []);
            }
            typeMapB.get(tn).push(j);
        }

        const unmatchedA = [];

        // Pass 1: Match by exact key (type name + node name)
        for (let i = 0; i < nodesA.length; i++) {
            const key = nodeKey(nodesA[i]);
            const candidates = keyMapB.get(key);
            let matched = false;
            if (candidates) {
                for (const j of candidates) {
                    if (!matchedB.has(j)) {
                        matchedB.add(j);
                        const status = this._attributesMatch(nodesA[i], nodesB[j]) ? 'identical' : 'modified';
                        result.pairs.push({ indexA: i, indexB: j, status });
                        matched = true;
                        break;
                    }
                }
            }
            if (!matched) {
                unmatchedA.push(i);
            }
        }

        // Pass 2: Match remaining A nodes by type name only
        const stillUnmatchedA = [];
        for (const i of unmatchedA) {
            const tn = typeName(nodesA[i]);
            const candidates = typeMapB.get(tn);
            let matched = false;
            if (candidates) {
                for (const j of candidates) {
                    if (!matchedB.has(j)) {
                        matchedB.add(j);
                        const status = this._attributesMatch(nodesA[i], nodesB[j]) ? 'identical' : 'modified';
                        result.pairs.push({ indexA: i, indexB: j, status });
                        matched = true;
                        break;
                    }
                }
            }
            if (!matched) {
                stillUnmatchedA.push(i);
            }
        }

        // Remaining unmatched nodes
        for (const i of stillUnmatchedA) {
            result.onlyInA.push(i);
        }
        for (let j = 0; j < nodesB.length; j++) {
            if (!matchedB.has(j)) {
                result.onlyInB.push(j);
            }
        }

        return result;
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
        const mapA = new Map(attrsA.map((a) => [a.name, a]));
        const mapB = new Map(attrsB.map((a) => [a.name, a]));
        for (const [name, attrA] of mapA) {
            const attrB = mapB.get(name);
            if (!attrB) {
                return false;
            }
            if (!this._valuesEqual(attrA.value, attrB.value)) {
                return false;
            }
        }
        return true;
    }

    _valuesEqual(a, b) {
        if (a === b) {
            return true;
        }
        if (a === null || a === undefined) {
            return b === null || b === undefined;
        }
        if (b === null || b === undefined) {
            return false;
        }
        if (Array.isArray(a) && Array.isArray(b)) {
            if (a.length !== b.length) {
                return false;
            }
            for (let i = 0; i < a.length; i++) {
                if (!this._valuesEqual(a[i], b[i])) {
                    return false;
                }
            }
            return true;
        }
        if (typeof a === 'object' && typeof b === 'object') {
            if (Array.isArray(a) !== Array.isArray(b)) {
                return false;
            }
            const keysA = Object.keys(a);
            const keysB = Object.keys(b);
            if (keysA.length !== keysB.length) {
                return false;
            }
            for (const key of keysA) {
                if (!Object.prototype.hasOwnProperty.call(b, key)) {
                    return false;
                }
                if (!this._valuesEqual(a[key], b[key])) {
                    return false;
                }
            }
            return true;
        }
        return false;
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
            try {
                this._syncing = true;
                target.scrollLeft = source.scrollLeft;
                target.scrollTop = source.scrollTop;
            } finally {
                this._syncing = false;
            }
        };

        containerLeft.addEventListener('scroll', () => {
            syncScroll(containerLeft, containerRight);
        });
        containerRight.addEventListener('scroll', () => {
            syncScroll(containerRight, containerLeft);
        });

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
            this._renderSingleStatus(document, content, typeName, 'added', 'Only in Model B');
        } else if (diffInfo.status === 'removed') {
            this._renderSingleStatus(document, content, typeName, 'removed', 'Only in Model A');
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
    }

    _hideDiffPanel() {
        const document = this._host.document;
        const panel = document.getElementById('diff-panel');
        const backdrop = document.getElementById('diff-panel-backdrop');
        if (panel) {
            panel.classList.add('hidden');
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
        badge.textContent = 'Identical';
        div.appendChild(badge);
        const text = document.createElement('div');
        text.textContent = `This node (${typeName}) is identical in both models.`;
        div.appendChild(text);
        container.appendChild(div);
    }

    _renderSingleStatus(document, container, typeName, status, message) {
        const div = document.createElement('div');
        div.className = 'diff-status';
        const badge = document.createElement('div');
        badge.className = `diff-status-badge diff-status-${status}`;
        badge.textContent = status === 'added' ? 'Added' : 'Removed';
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
                nodeA ? 'removed' : 'added', nodeA ? 'Only in Model A' : 'Only in Model B');
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
                return new Formatter(attr.value, attr.type).toString();
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
            const typeName = nodeA.type && nodeA.type.name ? nodeA.type.name : 'Node';
            this._renderIdenticalStatus(document, container, typeName);
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
            } else if (a && b && !this._valuesEqual(a.value, b.value)) {
                diffs.push({ name, valueA: formatter(a), valueB: formatter(b), type: 'changed' });
            }
        }
        return diffs;
    }

    _diffConnections(connectionsA, connectionsB) {
        const diffs = [];
        const mapA = new Map();
        const mapB = new Map();
        for (let i = 0; i < connectionsA.length; i++) {
            const a = connectionsA[i];
            const name = a && a.name ? a.name : `[${i}]`;
            mapA.set(name, a);
        }
        for (let i = 0; i < connectionsB.length; i++) {
            const b = connectionsB[i];
            const name = b && b.name ? b.name : `[${i}]`;
            mapB.set(name, b);
        }
        const allNames = new Set([...mapA.keys(), ...mapB.keys()]);
        for (const name of allNames) {
            const a = mapA.get(name);
            const b = mapB.get(name);
            const descA = a ? this._describeConnection(a) : '';
            const descB = b ? this._describeConnection(b) : '';
            if (a && !b) {
                diffs.push({ name, valueA: descA, valueB: '', type: 'removed' });
            } else if (!a && b) {
                diffs.push({ name, valueA: '', valueB: descB, type: 'added' });
            } else if (descA !== descB) {
                diffs.push({ name, valueA: descA, valueB: descB, type: 'changed' });
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
};

export const Controller = comparator.Controller;
