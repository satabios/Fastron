/**
 * Viewport Optimization Test Suite
 * Comprehensive tests for the viewport-based rendering system
 */

import { ViewportOptimization, getRecommendedSettings, isViewportOptimizationSupported } from './viewport-optimization.js';
import { SpatialIndex } from './spatial-index.js';
import { LazyGraphManager } from './lazy-graph.js';
import { LODManager } from './lod-manager.js';
import { MemoryManager } from './memory-manager.js';
import { ViewportManager } from './viewport-manager.js';

/**
 * Test Suite Runner
 */
export class OptimizationTestSuite {
    constructor() {
        this.tests = [];
        this.results = [];
    }
    
    addTest(name, testFn) {
        this.tests.push({ name, testFn });
    }
    
    async runAll() {
        console.log('Running Viewport Optimization Test Suite...\n');
        
        for (const test of this.tests) {
            try {
                console.log(`Running: ${test.name}`);
                const startTime = performance.now();
                await test.testFn();
                const endTime = performance.now();
                
                this.results.push({
                    name: test.name,
                    status: 'PASS',
                    time: (endTime - startTime).toFixed(2) + 'ms'
                });
                console.log(`✓ ${test.name} - PASS (${(endTime - startTime).toFixed(2)}ms)\n`);
            } catch (error) {
                this.results.push({
                    name: test.name,
                    status: 'FAIL',
                    error: error.message
                });
                console.error(`✗ ${test.name} - FAIL`);
                console.error(error);
                console.log('');
            }
        }
        
        this.printSummary();
    }
    
    printSummary() {
        console.log('\n=== Test Summary ===');
        console.table(this.results);
        
        const passed = this.results.filter(r => r.status === 'PASS').length;
        const failed = this.results.filter(r => r.status === 'FAIL').length;
        
        console.log(`\nTotal: ${this.results.length}`);
        console.log(`Passed: ${passed}`);
        console.log(`Failed: ${failed}`);
        console.log(`Success Rate: ${((passed / this.results.length) * 100).toFixed(1)}%`);
    }
}

/**
 * Create mock graph for testing
 */
function createMockGraph(nodeCount = 100, edgeCount = 150) {
    const graph = {
        nodes: new Map(),
        edges: new Map(),
        _spatialIndex: null,
        _memoryManager: null,
        _lodManager: null,
        _lazyManager: null,
        options: { direction: 'horizontal' }
    };
    
    // Create nodes
    for (let i = 0; i < nodeCount; i++) {
        const node = {
            v: `node_${i}`,
            label: {
                name: `Node ${i}`,
                type: 'layer',
                x: Math.random() * 5000,
                y: Math.random() * 5000,
                width: 100 + Math.random() * 50,
                height: 40 + Math.random() * 20,
                _blocks: []
            }
        };
        graph.nodes.set(node.v, node);
    }
    
    // Create edges
    const nodeIds = Array.from(graph.nodes.keys());
    for (let i = 0; i < edgeCount; i++) {
        const from = nodeIds[Math.floor(Math.random() * nodeIds.length)];
        const to = nodeIds[Math.floor(Math.random() * nodeIds.length)];
        if (from !== to) {
            const edge = {
                v: from,
                w: to,
                label: {
                    minlen: 1,
                    weight: 1,
                    points: [
                        { x: Math.random() * 5000, y: Math.random() * 5000 },
                        { x: Math.random() * 5000, y: Math.random() * 5000 }
                    ]
                }
            };
            graph.edges.set(`${from}:${to}`, edge);
        }
    }
    
    // Add required methods
    graph.node = (key) => graph.nodes.get(key);
    graph.edge = (v, w) => graph.edges.get(`${v}:${w}`);
    graph.parent = () => null;
    graph.children = () => [];
    
    return graph;
}

/**
 * Create mock container
 */
function createMockContainer() {
    const container = document.createElement('div');
    container.style.cssText = 'width: 1920px; height: 1080px; position: relative;';
    document.body.appendChild(container);
    return container;
}

/**
 * Test 1: Spatial Index
 */
async function testSpatialIndex() {
    const spatialIndex = new SpatialIndex(1000);
    
    // Index some nodes
    spatialIndex.indexNode('node1', 500, 500, 100, 50);
    spatialIndex.indexNode('node2', 1500, 1500, 100, 50);
    spatialIndex.indexNode('node3', 2500, 2500, 100, 50);
    
    // Query viewport
    const visible = spatialIndex.queryViewport(0, 0, 1000, 1000);
    
    // Assertions
    if (!visible.has('node1')) throw new Error('node1 should be visible');
    if (visible.has('node2')) throw new Error('node2 should not be visible');
    if (visible.has('node3')) throw new Error('node3 should not be visible');
    
    // Test stats
    const stats = spatialIndex.getStats();
    if (stats.nodeCount !== 3) throw new Error('Should have 3 nodes indexed');
}

/**
 * Test 2: Memory Manager
 */
async function testMemoryManager() {
    const memoryManager = new MemoryManager(10); // 10MB limit
    
    // Allocate resources
    memoryManager.allocate('res1', 5 * 1024 * 1024, { data: 'test1' }, 'node');
    memoryManager.allocate('res2', 3 * 1024 * 1024, { data: 'test2' }, 'node');
    
    // Check memory usage
    const usage = memoryManager.getMemoryUsage();
    if (usage.current < 8 * 1024 * 1024) throw new Error('Memory usage incorrect');
    
    // Allocate more (should trigger eviction)
    memoryManager.allocate('res3', 4 * 1024 * 1024, { data: 'test3' }, 'node');
    
    // Check that oldest was evicted
    if (memoryManager.has('res1')) throw new Error('res1 should have been evicted');
    if (!memoryManager.has('res3')) throw new Error('res3 should be allocated');
}

/**
 * Test 3: LOD Manager
 */
async function testLODManager() {
    const lodManager = new LODManager();
    
    // Test LOD determination
    const highLOD = lodManager.determineLOD(1.5, 50, 100);
    if (highLOD !== 'high') throw new Error('Should be high LOD');
    
    const mediumLOD = lodManager.determineLOD(0.75, 300, 500);
    if (mediumLOD !== 'medium') throw new Error('Should be medium LOD');
    
    const lowLOD = lodManager.determineLOD(0.3, 1000, 3000);
    if (lowLOD !== 'low') throw new Error('Should be low LOD');
    
    // Test edge simplification
    const edge = {
        points: [
            { x: 0, y: 0 },
            { x: 100, y: 100 },
            { x: 200, y: 200 },
            { x: 300, y: 300 },
            { x: 400, y: 400 }
        ]
    };
    
    const simplified = lodManager.simplifyEdge(edge, 'low');
    if (simplified.points.length !== 2) throw new Error('Low LOD should have 2 points');
}

/**
 * Test 4: Viewport Manager
 */
async function testViewportManager() {
    const graph = createMockGraph(50, 75);
    const container = createMockContainer();
    
    try {
        const viewportManager = new ViewportManager(graph, {
            tileSize: 1000,
            bufferZones: 1,
            debounceDelay: 50
        });
        
        await viewportManager.initialize(container);
        
        // Check initialization
        if (!viewportManager.initialized) throw new Error('Should be initialized');
        
        // Test viewport calculation
        const tiles = viewportManager.calculateVisibleTiles();
        if (tiles.size === 0) throw new Error('Should have visible tiles');
        
        // Test viewport update
        await viewportManager.updateViewport();
        
        const stats = viewportManager.getStats();
        if (stats.viewportUpdates === 0) throw new Error('Should have viewport updates');
        
        viewportManager.destroy();
    } finally {
        container.remove();
    }
}

/**
 * Test 5: Lazy Graph Manager
 */
async function testLazyGraphManager() {
    const graph = createMockGraph(100, 150);
    const spatialIndex = new SpatialIndex(1000);
    const memoryManager = new MemoryManager(500);
    
    graph._spatialIndex = spatialIndex;
    graph._memoryManager = memoryManager;
    
    const lazyManager = new LazyGraphManager(graph, spatialIndex, memoryManager);
    
    // Initialize (compute layout)
    await lazyManager.initialize();
    
    // Check initialization
    if (!lazyManager.isInitialized) throw new Error('Should be initialized');
    if (!lazyManager.layoutData) throw new Error('Should have layout data');
    
    // Test viewport update
    const result = await lazyManager.updateViewport(0, 0, 1000, 1000, 1);
    
    if (result.nodes.size === 0) throw new Error('Should have visible nodes');
    
    // Test stats
    const stats = lazyManager.getStats();
    if (stats.totalNodes !== 100) throw new Error('Should have 100 total nodes');
}

/**
 * Test 6: Full Integration
 */
async function testFullIntegration() {
    const graph = createMockGraph(200, 300);
    const container = createMockContainer();
    
    try {
        const optimization = new ViewportOptimization(graph, {
            tileSize: 1000,
            bufferZones: 1,
            enableViewportCulling: true,
            enableLazyLoading: true,
            enableLOD: true,
            enablePrefetch: false, // Disable for faster test
            maxMemoryMB: 100
        });
        
        await optimization.initialize(container);
        
        // Check initialization
        if (!optimization.initialized) throw new Error('Should be initialized');
        if (!optimization.enabled) throw new Error('Should be enabled');
        
        // Test enable/disable
        optimization.disable();
        if (optimization.enabled) throw new Error('Should be disabled');
        
        optimization.enable();
        if (!optimization.enabled) throw new Error('Should be enabled');
        
        // Test stats
        const stats = optimization.getStats();
        if (!stats.spatialIndex) throw new Error('Should have spatial index stats');
        if (!stats.memory) throw new Error('Should have memory stats');
        
        // Test force update
        await optimization.forceUpdate();
        
        optimization.destroy();
    } finally {
        container.remove();
    }
}

/**
 * Test 7: Recommended Settings
 */
async function testRecommendedSettings() {
    // Small graph
    const smallSettings = getRecommendedSettings(50, 75);
    if (smallSettings.enableViewportCulling) throw new Error('Small graph should not use viewport culling');
    
    // Medium graph
    const mediumSettings = getRecommendedSettings(500, 750);
    if (!mediumSettings.enableViewportCulling) throw new Error('Medium graph should use viewport culling');
    if (mediumSettings.tileSize !== 1500) throw new Error('Medium graph should use 1500px tiles');
    
    // Large graph
    const largeSettings = getRecommendedSettings(3000, 4500);
    if (!largeSettings.enableLOD) throw new Error('Large graph should use LOD');
    if (largeSettings.tileSize !== 1000) throw new Error('Large graph should use 1000px tiles');
    
    // Very large graph
    const veryLargeSettings = getRecommendedSettings(10000, 15000);
    if (!veryLargeSettings.enableAdaptiveQuality) throw new Error('Very large graph should use adaptive quality');
    if (veryLargeSettings.tileSize !== 800) throw new Error('Very large graph should use 800px tiles');
}

/**
 * Test 8: Browser Support Detection
 */
async function testBrowserSupport() {
    const supported = isViewportOptimizationSupported();
    
    // Should be supported in modern browsers
    if (typeof SVGElement === 'undefined') {
        if (supported) throw new Error('Should not be supported without SVGElement');
    } else {
        if (!supported) throw new Error('Should be supported in modern browsers');
    }
}

/**
 * Test 9: Performance Metrics
 */
async function testPerformanceMetrics() {
    const graph = createMockGraph(100, 150);
    const container = createMockContainer();
    
    try {
        const optimization = new ViewportOptimization(graph, {
            enablePerformanceMonitor: true,
            enablePrefetch: false
        });
        
        await optimization.initialize(container);
        
        // Check performance monitor
        if (!optimization.performanceMonitor) throw new Error('Should have performance monitor');
        
        const metrics = optimization.performanceMonitor.getMetrics();
        if (metrics.totalNodes !== 100) throw new Error('Should track total nodes');
        
        // Test performance report
        const report = optimization.getPerformanceReport();
        if (!report.summary) throw new Error('Should have summary');
        if (!report.graph) throw new Error('Should have graph stats');
        if (!report.performance) throw new Error('Should have performance stats');
        
        optimization.destroy();
    } finally {
        container.remove();
    }
}

/**
 * Test 10: Memory Cleanup
 */
async function testMemoryCleanup() {
    const graph = createMockGraph(100, 150);
    const container = createMockContainer();
    
    try {
        const optimization = new ViewportOptimization(graph, {
            maxMemoryMB: 50,
            enablePrefetch: false
        });
        
        await optimization.initialize(container);
        
        // Force viewport update to load some tiles
        await optimization.forceUpdate();
        
        // Check memory usage
        const memoryBefore = optimization.memoryManager.getMemoryUsage();
        if (memoryBefore.resourceCount === 0) throw new Error('Should have loaded resources');
        
        // Clear caches
        optimization.clearCaches();
        
        const memoryAfter = optimization.memoryManager.getMemoryUsage();
        if (memoryAfter.resourceCount !== 0) throw new Error('Should have cleared resources');
        
        optimization.destroy();
    } finally {
        container.remove();
    }
}

/**
 * Run all tests
 */
export async function runAllTests() {
    const suite = new OptimizationTestSuite();
    
    suite.addTest('Spatial Index', testSpatialIndex);
    suite.addTest('Memory Manager', testMemoryManager);
    suite.addTest('LOD Manager', testLODManager);
    suite.addTest('Viewport Manager', testViewportManager);
    suite.addTest('Lazy Graph Manager', testLazyGraphManager);
    suite.addTest('Full Integration', testFullIntegration);
    suite.addTest('Recommended Settings', testRecommendedSettings);
    suite.addTest('Browser Support', testBrowserSupport);
    suite.addTest('Performance Metrics', testPerformanceMetrics);
    suite.addTest('Memory Cleanup', testMemoryCleanup);
    
    await suite.runAll();
    
    return suite.results;
}

/**
 * Run specific test
 */
export async function runTest(testName) {
    const tests = {
        'spatial-index': testSpatialIndex,
        'memory-manager': testMemoryManager,
        'lod-manager': testLODManager,
        'viewport-manager': testViewportManager,
        'lazy-graph-manager': testLazyGraphManager,
        'full-integration': testFullIntegration,
        'recommended-settings': testRecommendedSettings,
        'browser-support': testBrowserSupport,
        'performance-metrics': testPerformanceMetrics,
        'memory-cleanup': testMemoryCleanup
    };
    
    const testFn = tests[testName];
    if (!testFn) {
        throw new Error(`Test '${testName}' not found`);
    }
    
    console.log(`Running test: ${testName}`);
    try {
        await testFn();
        console.log(`✓ ${testName} - PASS`);
        return { status: 'PASS' };
    } catch (error) {
        console.error(`✗ ${testName} - FAIL`);
        console.error(error);
        return { status: 'FAIL', error: error.message };
    }
}

// Export for use in browser console
if (typeof window !== 'undefined') {
    window.runOptimizationTests = runAllTests;
    window.runOptimizationTest = runTest;
}
