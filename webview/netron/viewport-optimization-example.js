/**
 * Viewport Optimization Integration Example
 * Demonstrates how to integrate viewport optimization into Netron
 */

import { ViewportOptimization, getRecommendedSettings, isViewportOptimizationSupported } from './viewport-optimization.js';

/**
 * Example 1: Basic Integration
 * Simple integration with automatic settings
 */
export async function basicIntegration(graph, container) {
    // Check if optimization is supported
    if (!isViewportOptimizationSupported()) {
        console.warn('Viewport optimization not supported in this browser');
        return null;
    }
    
    // Get recommended settings based on graph size
    const settings = getRecommendedSettings(
        graph.nodes.size,
        graph.edges.size
    );
    
    console.log('Using recommended settings:', settings);
    
    // Create optimization instance
    const optimization = new ViewportOptimization(graph, settings);
    
    // Initialize
    await optimization.initialize(container);
    
    console.log('Viewport optimization initialized');
    console.log('Initial stats:', optimization.getStats());
    
    return optimization;
}

/**
 * Example 2: Custom Configuration
 * Advanced integration with custom settings
 */
export async function advancedIntegration(graph, container, options = {}) {
    const optimization = new ViewportOptimization(graph, {
        // Spatial partitioning
        tileSize: options.tileSize || 1000,
        bufferZones: options.bufferZones || 1,
        
        // Performance tuning
        debounceDelay: options.debounceDelay || 100,
        targetFPS: options.targetFPS || 60,
        
        // Feature flags
        enableViewportCulling: options.enableViewportCulling !== false,
        enableLazyLoading: options.enableLazyLoading !== false,
        enableLOD: options.enableLOD !== false,
        enablePrefetch: options.enablePrefetch !== false,
        enableAdaptiveQuality: options.enableAdaptiveQuality !== false,
        
        // Memory management
        maxMemoryMB: options.maxMemoryMB || 500,
        
        // Debugging
        enablePerformanceMonitor: options.enablePerformanceMonitor !== false,
        showPerformanceOverlay: options.showPerformanceOverlay || false
    });
    
    await optimization.initialize(container);
    
    // Setup event handlers
    setupEventHandlers(optimization, options);
    
    return optimization;
}

/**
 * Example 3: Conditional Optimization
 * Only enable optimization for large graphs
 */
export async function conditionalIntegration(graph, container) {
    const nodeCount = graph.nodes.size;
    const edgeCount = graph.edges.size;
    
    // Thresholds for enabling optimization
    const SMALL_GRAPH_THRESHOLD = 100;
    const MEDIUM_GRAPH_THRESHOLD = 1000;
    
    if (nodeCount < SMALL_GRAPH_THRESHOLD) {
        console.log('Small graph detected, skipping optimization');
        return null;
    }
    
    // Determine optimization level
    let settings;
    if (nodeCount < MEDIUM_GRAPH_THRESHOLD) {
        console.log('Medium graph detected, using moderate optimization');
        settings = {
            enableViewportCulling: true,
            enableLazyLoading: true,
            enableLOD: false,
            enablePrefetch: true,
            tileSize: 1500,
            bufferZones: 2
        };
    } else {
        console.log('Large graph detected, using full optimization');
        settings = getRecommendedSettings(nodeCount, edgeCount);
    }
    
    const optimization = new ViewportOptimization(graph, settings);
    await optimization.initialize(container);
    
    return optimization;
}

/**
 * Example 4: Progressive Enhancement
 * Start with basic rendering, then enable optimization
 */
export async function progressiveIntegration(graph, container) {
    // First, render graph normally
    console.log('Initial render...');
    await graph.build(document, container);
    await graph.measure();
    await graph.layout();
    await graph.update();
    
    // Then enable optimization after initial render
    console.log('Enabling optimization...');
    const settings = getRecommendedSettings(
        graph.nodes.size,
        graph.edges.size
    );
    
    const optimization = new ViewportOptimization(graph, settings);
    await optimization.initialize(container);
    
    // Force initial viewport update
    await optimization.forceUpdate();
    
    return optimization;
}

/**
 * Example 5: Performance Monitoring
 * Integration with detailed performance tracking
 */
export async function monitoredIntegration(graph, container) {
    const optimization = new ViewportOptimization(graph, {
        ...getRecommendedSettings(graph.nodes.size, graph.edges.size),
        enablePerformanceMonitor: true,
        showPerformanceOverlay: true
    });
    
    await optimization.initialize(container);
    
    // Log performance metrics every 5 seconds
    setInterval(() => {
        const report = optimization.getPerformanceReport();
        console.group('Performance Report');
        console.log('FPS:', report.performance.fps);
        console.log('Visible Nodes:', report.graph.visibleNodes, '/', report.graph.totalNodes);
        console.log('Memory:', report.summary.memoryUsedMB, 'MB');
        console.log('Avg Frame Time:', report.performance.avgFrameTime);
        console.groupEnd();
    }, 5000);
    
    // Export detailed stats on demand
    window.exportOptimizationStats = () => {
        const json = optimization.exportStats();
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'optimization-stats.json';
        a.click();
        URL.revokeObjectURL(url);
    };
    
    return optimization;
}

/**
 * Example 6: Adaptive Quality Integration
 * Automatically adjust quality based on performance
 */
export async function adaptiveIntegration(graph, container) {
    const optimization = new ViewportOptimization(graph, {
        ...getRecommendedSettings(graph.nodes.size, graph.edges.size),
        enableAdaptiveQuality: true,
        targetFPS: 60
    });
    
    await optimization.initialize(container);
    
    // Monitor quality changes
    if (optimization.adaptiveQuality) {
        optimization.adaptiveQuality.onQualityChange((level, settings) => {
            console.log(`Quality changed to ${level}:`, settings);
            
            // Show notification to user
            showNotification(`Rendering quality adjusted to ${level} for better performance`);
        });
    }
    
    return optimization;
}

/**
 * Example 7: Memory-Constrained Integration
 * Optimize for low-memory environments
 */
export async function memoryConstrainedIntegration(graph, container) {
    const optimization = new ViewportOptimization(graph, {
        enableViewportCulling: true,
        enableLazyLoading: true,
        enableLOD: true,
        enablePrefetch: false, // Disable prefetch to save memory
        tileSize: 800,         // Smaller tiles for finer control
        bufferZones: 0,        // No buffer zones
        maxMemoryMB: 200,      // Strict memory limit
        debounceDelay: 200     // Longer debounce to reduce updates
    });
    
    await optimization.initialize(container);
    
    // Monitor memory usage
    setInterval(() => {
        const memory = optimization.memoryManager.getMemoryUsage();
        if (memory.percentage > 80) {
            console.warn('High memory usage:', memory.percentage + '%');
            optimization.memoryManager.forceCleanup(memory.current * 0.3);
        }
    }, 3000);
    
    return optimization;
}

/**
 * Example 8: Interactive Controls
 * Add UI controls for optimization settings
 */
export async function interactiveIntegration(graph, container) {
    const optimization = new ViewportOptimization(graph, 
        getRecommendedSettings(graph.nodes.size, graph.edges.size)
    );
    
    await optimization.initialize(container);
    
    // Create control panel
    const controls = createControlPanel(optimization);
    container.appendChild(controls);
    
    return optimization;
}

/**
 * Helper: Setup event handlers
 */
function setupEventHandlers(optimization, options) {
    // Viewport change handler
    if (options.onViewportChange) {
        optimization.viewportManager.onViewportChange((info) => {
            options.onViewportChange(info);
        });
    }
    
    // Quality change handler
    if (options.onQualityChange && optimization.adaptiveQuality) {
        optimization.adaptiveQuality.onQualityChange((level, settings) => {
            options.onQualityChange(level, settings);
        });
    }
    
    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        optimization.destroy();
    });
}

/**
 * Helper: Show notification
 */
function showNotification(message) {
    const notification = document.createElement('div');
    notification.textContent = message;
    notification.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 12px 20px;
        border-radius: 4px;
        font-size: 14px;
        z-index: 10000;
        animation: slideIn 0.3s ease-out;
    `;
    
    document.body.appendChild(notification);
    
    setTimeout(() => {
        notification.style.animation = 'slideOut 0.3s ease-out';
        setTimeout(() => notification.remove(), 300);
    }, 3000);
}

/**
 * Helper: Create control panel
 */
function createControlPanel(optimization) {
    const panel = document.createElement('div');
    panel.style.cssText = `
        position: fixed;
        top: 10px;
        left: 10px;
        background: white;
        border: 1px solid #ccc;
        border-radius: 4px;
        padding: 10px;
        font-family: sans-serif;
        font-size: 12px;
        z-index: 10000;
        box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    `;
    
    panel.innerHTML = `
        <div style="font-weight: bold; margin-bottom: 8px;">Optimization Controls</div>
        <label style="display: block; margin-bottom: 4px;">
            <input type="checkbox" id="opt-enabled" checked> Enabled
        </label>
        <label style="display: block; margin-bottom: 4px;">
            <input type="checkbox" id="opt-lod" checked> Level of Detail
        </label>
        <label style="display: block; margin-bottom: 4px;">
            <input type="checkbox" id="opt-prefetch" checked> Prefetching
        </label>
        <label style="display: block; margin-bottom: 8px;">
            <input type="checkbox" id="opt-overlay"> Performance Overlay
        </label>
        <button id="opt-stats" style="width: 100%; padding: 4px;">Show Stats</button>
        <button id="opt-clear" style="width: 100%; padding: 4px; margin-top: 4px;">Clear Cache</button>
    `;
    
    // Event handlers
    panel.querySelector('#opt-enabled').addEventListener('change', (e) => {
        if (e.target.checked) {
            optimization.enable();
        } else {
            optimization.disable();
        }
    });
    
    panel.querySelector('#opt-lod').addEventListener('change', (e) => {
        optimization.options.enableLOD = e.target.checked;
    });
    
    panel.querySelector('#opt-prefetch').addEventListener('change', (e) => {
        optimization.options.enablePrefetch = e.target.checked;
        if (optimization.viewportManager) {
            optimization.viewportManager.options.enablePrefetch = e.target.checked;
        }
    });
    
    panel.querySelector('#opt-overlay').addEventListener('change', (e) => {
        if (e.target.checked && optimization.performanceMonitor) {
            optimization.performanceMonitor.createOverlay(document.body);
        } else {
            const overlay = document.getElementById('performance-overlay');
            if (overlay) overlay.remove();
        }
    });
    
    panel.querySelector('#opt-stats').addEventListener('click', () => {
        optimization.logStats();
    });
    
    panel.querySelector('#opt-clear').addEventListener('click', () => {
        optimization.clearCaches();
        showNotification('Cache cleared');
    });
    
    return panel;
}

/**
 * Example 9: Integration with Existing View Class
 * Shows how to integrate with Netron's view.js
 */
export class OptimizedGraphView {
    constructor() {
        this.optimization = null;
        this.graph = null;
        this.container = null;
    }
    
    async render(graph, container, options = {}) {
        this.graph = graph;
        this.container = container;
        
        // Build graph
        await graph.build(document, container);
        await graph.measure();
        await graph.layout(options.worker);
        await graph.update();
        
        // Enable optimization for large graphs
        if (graph.nodes.size > 100) {
            const settings = getRecommendedSettings(
                graph.nodes.size,
                graph.edges.size
            );
            
            this.optimization = new ViewportOptimization(graph, {
                ...settings,
                showPerformanceOverlay: options.showPerformanceOverlay || false
            });
            
            await this.optimization.initialize(container);
            
            console.log('Viewport optimization enabled for', graph.nodes.size, 'nodes');
        }
    }
    
    async zoom(level) {
        // Handle zoom
        if (this.optimization && this.optimization.viewportManager) {
            const viewport = this.optimization.viewportManager.viewport;
            await this.optimization.setViewport(
                viewport.x,
                viewport.y,
                level
            );
        }
    }
    
    async pan(dx, dy) {
        // Handle pan
        if (this.optimization && this.optimization.viewportManager) {
            const viewport = this.optimization.viewportManager.viewport;
            await this.optimization.setViewport(
                viewport.x + dx,
                viewport.y + dy,
                viewport.zoom
            );
        }
    }
    
    getStats() {
        if (this.optimization) {
            return this.optimization.getStats();
        }
        return null;
    }
    
    destroy() {
        if (this.optimization) {
            this.optimization.destroy();
            this.optimization = null;
        }
    }
}

/**
 * Example 10: Testing and Benchmarking
 * Utilities for testing optimization performance
 */
export class OptimizationBenchmark {
    constructor(graph, container) {
        this.graph = graph;
        this.container = container;
        this.results = [];
    }
    
    async runBenchmark() {
        console.log('Starting optimization benchmark...');
        
        // Test 1: Without optimization
        const withoutOpt = await this.testWithoutOptimization();
        
        // Test 2: With optimization
        const withOpt = await this.testWithOptimization();
        
        // Compare results
        const comparison = this.compareResults(withoutOpt, withOpt);
        
        console.table(comparison);
        
        return comparison;
    }
    
    async testWithoutOptimization() {
        console.log('Testing without optimization...');
        
        const startTime = performance.now();
        
        await this.graph.build(document, this.container);
        await this.graph.measure();
        await this.graph.layout();
        await this.graph.update();
        
        const endTime = performance.now();
        
        const memory = performance.memory ? 
            performance.memory.usedJSHeapSize / 1024 / 1024 : 0;
        
        return {
            loadTime: endTime - startTime,
            memory: memory,
            fps: 0 // Would need to measure during interaction
        };
    }
    
    async testWithOptimization() {
        console.log('Testing with optimization...');
        
        const settings = getRecommendedSettings(
            this.graph.nodes.size,
            this.graph.edges.size
        );
        
        const optimization = new ViewportOptimization(this.graph, settings);
        
        const startTime = performance.now();
        
        await optimization.initialize(this.container);
        
        const endTime = performance.now();
        
        const stats = optimization.getStats();
        const memory = stats.memory ? stats.memory.usedMB : 0;
        const fps = stats.performance ? stats.performance.fps : 0;
        
        optimization.destroy();
        
        return {
            loadTime: endTime - startTime,
            memory: memory,
            fps: fps
        };
    }
    
    compareResults(without, with_) {
        return {
            'Load Time': {
                'Without Opt': without.loadTime.toFixed(2) + 'ms',
                'With Opt': with_.loadTime.toFixed(2) + 'ms',
                'Improvement': ((without.loadTime / with_.loadTime).toFixed(2) + 'x')
            },
            'Memory Usage': {
                'Without Opt': without.memory.toFixed(2) + 'MB',
                'With Opt': with_.memory.toFixed(2) + 'MB',
                'Reduction': ((without.memory / with_.memory).toFixed(2) + 'x')
            },
            'FPS': {
                'Without Opt': without.fps || 'N/A',
                'With Opt': with_.fps || 'N/A',
                'Improvement': with_.fps ? (with_.fps / (without.fps || 30)).toFixed(2) + 'x' : 'N/A'
            }
        };
    }
}
