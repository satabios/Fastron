/**
 * Viewport Optimization Integration
 * Main entry point for viewport-based rendering optimization
 */

import { ViewportManager } from './viewport-manager.js';
import { SpatialIndex } from './spatial-index.js';
import { LazyGraphManager } from './lazy-graph.js';
import { LODManager } from './lod-manager.js';
import { MemoryManager } from './memory-manager.js';
import { PerformanceMonitor, AdaptiveQualityManager } from './performance-monitor.js';

/**
 * Viewport Optimization System
 * Coordinates all optimization components
 */
export class ViewportOptimization {
    constructor(graph, options = {}) {
        this.graph = graph;
        this.options = {
            // Viewport settings
            tileSize: options.tileSize || 1000,
            bufferZones: options.bufferZones || 1,
            debounceDelay: options.debounceDelay || 100,
            
            // Feature flags
            enableViewportCulling: options.enableViewportCulling !== false,
            enableLazyLoading: options.enableLazyLoading !== false,
            enableLOD: options.enableLOD !== false,
            enablePrefetch: options.enablePrefetch !== false,
            enableAdaptiveQuality: options.enableAdaptiveQuality !== false,
            
            // Memory settings
            maxMemoryMB: options.maxMemoryMB || 500,
            
            // Performance settings
            targetFPS: options.targetFPS || 60,
            enablePerformanceMonitor: options.enablePerformanceMonitor !== false,
            showPerformanceOverlay: options.showPerformanceOverlay || false,
            
            ...options
        };
        
        // Initialize components
        this.spatialIndex = null;
        this.lazyManager = null;
        this.lodManager = null;
        this.memoryManager = null;
        this.viewportManager = null;
        this.performanceMonitor = null;
        this.adaptiveQuality = null;
        
        this.initialized = false;
        this.enabled = false;
    }

    /**
     * Initialize optimization system
     */
    async initialize(container) {
        if (this.initialized) {
            console.warn('[ViewportOptimization] Already initialized');
            return;
        }
        
        console.log('[ViewportOptimization] Initializing with options:', this.options);
        
        try {
            // Initialize performance monitor
            if (this.options.enablePerformanceMonitor) {
                this.performanceMonitor = new PerformanceMonitor();
                this.performanceMonitor.startMetric('initTime');
            }
            
            // Initialize spatial index
            this.spatialIndex = new SpatialIndex(this.options.tileSize);
            this.graph._spatialIndex = this.spatialIndex;
            
            // Initialize memory manager
            this.memoryManager = new MemoryManager(this.options.maxMemoryMB);
            this.graph._memoryManager = this.memoryManager;
            
            // Initialize LOD manager
            if (this.options.enableLOD) {
                this.lodManager = new LODManager();
                this.graph._lodManager = this.lodManager;
            }
            
            // Initialize lazy loading manager
            if (this.options.enableLazyLoading) {
                this.lazyManager = new LazyGraphManager(
                    this.graph,
                    this.spatialIndex,
                    this.memoryManager
                );
                this.graph._lazyManager = this.lazyManager;
                
                // Initialize lazy manager (compute layout)
                await this.lazyManager.initialize();
            }
            
            // Initialize viewport manager
            if (this.options.enableViewportCulling) {
                this.viewportManager = new ViewportManager(this.graph, this.options);
                await this.viewportManager.initialize(container);
                
                // Register viewport change handler
                this.viewportManager.onViewportChange((viewportInfo) => {
                    this.handleViewportChange(viewportInfo);
                });
            }
            
            // Initialize adaptive quality
            if (this.options.enableAdaptiveQuality) {
                this.adaptiveQuality = new AdaptiveQualityManager();
                this.adaptiveQuality.targetFPS = this.options.targetFPS;
                
                // Register quality change handler
                this.adaptiveQuality.onQualityChange((level, settings) => {
                    this.handleQualityChange(level, settings);
                });
            }
            
            // Show performance overlay if requested
            if (this.options.showPerformanceOverlay && this.performanceMonitor) {
                this.performanceMonitor.createOverlay(container);
            }
            
            if (this.performanceMonitor) {
                this.performanceMonitor.endMetric('initTime');
            }
            
            this.initialized = true;
            this.enabled = true;
            
            console.log('[ViewportOptimization] Initialization complete');
            
            return {
                success: true,
                stats: this.getStats()
            };
            
        } catch (error) {
            console.error('[ViewportOptimization] Initialization failed:', error);
            this.initialized = false;
            this.enabled = false;
            throw error;
        }
    }

    /**
     * Handle viewport change
     */
    handleViewportChange(viewportInfo) {
        if (!this.enabled) return;
        
        // Update performance metrics
        if (this.performanceMonitor) {
            this.performanceMonitor.updateMetric('visibleNodes', viewportInfo.visibleNodes);
            this.performanceMonitor.updateMetric('visibleEdges', viewportInfo.visibleEdges);
            this.performanceMonitor.recordFrame();
        }
        
        // Update adaptive quality
        if (this.adaptiveQuality && this.performanceMonitor) {
            const metrics = this.performanceMonitor.getMetrics();
            if (metrics.fps > 0) {
                this.adaptiveQuality.measureFrame(1000 / metrics.fps);
            }
        }
    }

    /**
     * Handle quality change
     */
    handleQualityChange(level, settings) {
        console.log(`[ViewportOptimization] Quality changed to ${level}`, settings);
        
        // Update LOD manager settings
        if (this.lodManager) {
            // Adjust LOD thresholds based on quality
            // This could be expanded to modify LOD behavior
        }
        
        // Update viewport manager settings
        if (this.viewportManager) {
            // Adjust buffer zones based on quality
            if (level === 'low') {
                this.viewportManager.options.bufferZones = 0;
                this.viewportManager.options.enablePrefetch = false;
            } else if (level === 'medium') {
                this.viewportManager.options.bufferZones = 1;
                this.viewportManager.options.enablePrefetch = true;
            } else {
                this.viewportManager.options.bufferZones = 2;
                this.viewportManager.options.enablePrefetch = true;
            }
        }
    }

    /**
     * Enable optimization
     */
    enable() {
        if (!this.initialized) {
            console.warn('[ViewportOptimization] Cannot enable - not initialized');
            return false;
        }
        
        this.enabled = true;
        console.log('[ViewportOptimization] Enabled');
        return true;
    }

    /**
     * Disable optimization
     */
    disable() {
        this.enabled = false;
        console.log('[ViewportOptimization] Disabled');
    }

    /**
     * Toggle optimization
     */
    toggle() {
        if (this.enabled) {
            this.disable();
        } else {
            this.enable();
        }
        return this.enabled;
    }

    /**
     * Force viewport update
     */
    async forceUpdate() {
        if (!this.enabled || !this.viewportManager) {
            return;
        }
        
        await this.viewportManager.forceUpdate();
    }

    /**
     * Set viewport programmatically
     */
    async setViewport(x, y, zoom) {
        if (!this.enabled || !this.viewportManager) {
            return;
        }
        
        await this.viewportManager.setViewport(x, y, zoom);
    }

    /**
     * Get comprehensive statistics
     */
    getStats() {
        const stats = {
            enabled: this.enabled,
            initialized: this.initialized,
            options: { ...this.options }
        };
        
        if (this.spatialIndex) {
            stats.spatialIndex = this.spatialIndex.getStats();
        }
        
        if (this.lazyManager) {
            stats.lazyLoading = this.lazyManager.getStats();
        }
        
        if (this.memoryManager) {
            stats.memory = this.memoryManager.getMemoryUsage();
        }
        
        if (this.viewportManager) {
            stats.viewport = this.viewportManager.getStats();
        }
        
        if (this.performanceMonitor) {
            stats.performance = this.performanceMonitor.getMetrics();
        }
        
        if (this.adaptiveQuality) {
            stats.quality = {
                level: this.adaptiveQuality.getQualityLevel(),
                settings: this.adaptiveQuality.getQualitySettings()
            };
        }
        
        return stats;
    }

    /**
     * Get performance report
     */
    getPerformanceReport() {
        if (!this.performanceMonitor) {
            return null;
        }
        
        return this.performanceMonitor.createReport();
    }

    /**
     * Export statistics as JSON
     */
    exportStats() {
        return JSON.stringify(this.getStats(), null, 2);
    }

    /**
     * Log statistics to console
     */
    logStats() {
        console.group('Viewport Optimization Statistics');
        console.log('Status:', this.enabled ? 'Enabled' : 'Disabled');
        
        const stats = this.getStats();
        
        if (stats.spatialIndex) {
            console.group('Spatial Index');
            console.table(stats.spatialIndex);
            console.groupEnd();
        }
        
        if (stats.lazyLoading) {
            console.group('Lazy Loading');
            console.table(stats.lazyLoading);
            console.groupEnd();
        }
        
        if (stats.memory) {
            console.group('Memory Usage');
            console.table(stats.memory);
            console.groupEnd();
        }
        
        if (stats.viewport) {
            console.group('Viewport');
            console.table(stats.viewport);
            console.groupEnd();
        }
        
        if (stats.performance) {
            console.group('Performance');
            console.table(stats.performance);
            console.groupEnd();
        }
        
        if (stats.quality) {
            console.group('Adaptive Quality');
            console.log('Level:', stats.quality.level);
            console.table(stats.quality.settings);
            console.groupEnd();
        }
        
        console.groupEnd();
    }

    /**
     * Clear all caches
     */
    clearCaches() {
        if (this.spatialIndex) {
            this.spatialIndex.clear();
        }
        
        if (this.lazyManager) {
            this.lazyManager.clear();
        }
        
        if (this.memoryManager) {
            this.memoryManager.clear();
        }
        
        console.log('[ViewportOptimization] Caches cleared');
    }

    /**
     * Reset all statistics
     */
    resetStats() {
        if (this.performanceMonitor) {
            this.performanceMonitor.reset();
        }
        
        if (this.viewportManager) {
            this.viewportManager.stats = {
                viewportUpdates: 0,
                tilesLoaded: 0,
                tilesUnloaded: 0,
                nodesRendered: 0,
                edgesRendered: 0,
                lastUpdateTime: 0,
                avgUpdateTime: 0
            };
        }
        
        console.log('[ViewportOptimization] Statistics reset');
    }

    /**
     * Cleanup and destroy
     */
    destroy() {
        console.log('[ViewportOptimization] Destroying...');
        
        if (this.viewportManager) {
            this.viewportManager.destroy();
        }
        
        this.clearCaches();
        
        this.spatialIndex = null;
        this.lazyManager = null;
        this.lodManager = null;
        this.memoryManager = null;
        this.viewportManager = null;
        this.performanceMonitor = null;
        this.adaptiveQuality = null;
        
        this.initialized = false;
        this.enabled = false;
        
        console.log('[ViewportOptimization] Destroyed');
    }
}

/**
 * Create and initialize viewport optimization
 * Convenience function for easy setup
 */
export async function createViewportOptimization(graph, container, options = {}) {
    const optimization = new ViewportOptimization(graph, options);
    await optimization.initialize(container);
    return optimization;
}

/**
 * Check if viewport optimization is supported
 */
export function isViewportOptimizationSupported() {
    return typeof SVGElement !== 'undefined' 
        && typeof MutationObserver !== 'undefined'
        && typeof ResizeObserver !== 'undefined';
}

/**
 * Get recommended settings based on graph size
 */
export function getRecommendedSettings(nodeCount, edgeCount) {
    const settings = {
        enableViewportCulling: true,
        enableLazyLoading: true,
        enableLOD: true,
        enablePrefetch: true,
        enableAdaptiveQuality: true,
        showPerformanceOverlay: false
    };
    
    // Small graphs (< 100 nodes)
    if (nodeCount < 100) {
        settings.enableViewportCulling = false;
        settings.enableLazyLoading = false;
        settings.tileSize = 2000;
        settings.bufferZones = 2;
    }
    // Medium graphs (100-1000 nodes)
    else if (nodeCount < 1000) {
        settings.tileSize = 1500;
        settings.bufferZones = 2;
        settings.maxMemoryMB = 300;
    }
    // Large graphs (1000-5000 nodes)
    else if (nodeCount < 5000) {
        settings.tileSize = 1000;
        settings.bufferZones = 1;
        settings.maxMemoryMB = 500;
    }
    // Very large graphs (5000+ nodes)
    else {
        settings.tileSize = 800;
        settings.bufferZones = 1;
        settings.maxMemoryMB = 500;
        settings.debounceDelay = 150;
        settings.enableAdaptiveQuality = true;
    }
    
    return settings;
}
