/**
 * Performance Monitor
 * Tracks and reports performance metrics
 */

export class PerformanceMonitor {
    constructor() {
        this.metrics = {
            loadTime: 0,
            layoutTime: 0,
            renderTime: 0,
            memoryUsage: 0,
            fps: 0,
            visibleNodes: 0,
            totalNodes: 0,
            visibleEdges: 0,
            totalEdges: 0
        };
        
        this.timers = new Map();
        this.frameTimings = [];
        this.maxFrameTimings = 60;
        this.lastFrameTime = 0;
    }

    /**
     * Start timing a metric
     */
    startMetric(name) {
        this.timers.set(name, performance.now());
    }

    /**
     * End timing a metric
     */
    endMetric(name) {
        const start = this.timers.get(name);
        if (start !== undefined) {
            this.metrics[name] = performance.now() - start;
            this.timers.delete(name);
            return this.metrics[name];
        }
        return 0;
    }

    /**
     * Record a frame timing
     */
    recordFrame() {
        const now = performance.now();
        if (this.lastFrameTime > 0) {
            const frameTime = now - this.lastFrameTime;
            this.frameTimings.push(frameTime);
            
            if (this.frameTimings.length > this.maxFrameTimings) {
                this.frameTimings.shift();
            }
            
            // Calculate FPS
            const avgFrameTime = this.frameTimings.reduce((a, b) => a + b, 0) / this.frameTimings.length;
            this.metrics.fps = Math.round(1000 / avgFrameTime);
        }
        this.lastFrameTime = now;
    }

    /**
     * Update a metric value
     */
    updateMetric(name, value) {
        this.metrics[name] = value;
    }

    /**
     * Get current metrics
     */
    getMetrics() {
        return { ...this.metrics };
    }

    /**
     * Get memory usage if available
     */
    getMemoryUsage() {
        if (performance.memory) {
            return {
                usedJSHeapSize: performance.memory.usedJSHeapSize,
                totalJSHeapSize: performance.memory.totalJSHeapSize,
                jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
                usedMB: Math.round(performance.memory.usedJSHeapSize / 1024 / 1024),
                totalMB: Math.round(performance.memory.totalJSHeapSize / 1024 / 1024),
                limitMB: Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024)
            };
        }
        return null;
    }

    /**
     * Log metrics to console
     */
    logMetrics() {
        console.group('Performance Metrics');
        console.table(this.metrics);
        
        const memory = this.getMemoryUsage();
        if (memory) {
            console.group('Memory Usage');
            console.table(memory);
            console.groupEnd();
        }
        
        console.groupEnd();
    }

    /**
     * Export metrics as JSON
     */
    exportMetrics() {
        return JSON.stringify({
            metrics: this.metrics,
            memory: this.getMemoryUsage(),
            timestamp: new Date().toISOString()
        }, null, 2);
    }

    /**
     * Create performance report
     */
    createReport() {
        const memory = this.getMemoryUsage();
        
        return {
            summary: {
                totalLoadTime: this.metrics.loadTime,
                layoutTime: this.metrics.layoutTime,
                renderTime: this.metrics.renderTime,
                fps: this.metrics.fps,
                memoryUsedMB: memory ? memory.usedMB : 'N/A'
            },
            graph: {
                totalNodes: this.metrics.totalNodes,
                visibleNodes: this.metrics.visibleNodes,
                totalEdges: this.metrics.totalEdges,
                visibleEdges: this.metrics.visibleEdges,
                visibilityRatio: this.metrics.totalNodes > 0 
                    ? (this.metrics.visibleNodes / this.metrics.totalNodes * 100).toFixed(2) + '%'
                    : 'N/A'
            },
            performance: {
                fps: this.metrics.fps,
                avgFrameTime: this.frameTimings.length > 0
                    ? (this.frameTimings.reduce((a, b) => a + b, 0) / this.frameTimings.length).toFixed(2) + 'ms'
                    : 'N/A',
                minFrameTime: this.frameTimings.length > 0
                    ? Math.min(...this.frameTimings).toFixed(2) + 'ms'
                    : 'N/A',
                maxFrameTime: this.frameTimings.length > 0
                    ? Math.max(...this.frameTimings).toFixed(2) + 'ms'
                    : 'N/A'
            },
            memory: memory || { status: 'Not available' }
        };
    }

    /**
     * Display performance overlay
     */
    createOverlay(container) {
        const overlay = document.createElement('div');
        overlay.id = 'performance-overlay';
        overlay.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            background: rgba(0, 0, 0, 0.8);
            color: #0f0;
            padding: 10px;
            font-family: monospace;
            font-size: 12px;
            border-radius: 5px;
            z-index: 10000;
            min-width: 200px;
        `;
        
        container.appendChild(overlay);
        
        // Update overlay periodically
        setInterval(() => {
            const report = this.createReport();
            overlay.innerHTML = `
                <div><strong>Performance Monitor</strong></div>
                <div>FPS: ${report.performance.fps}</div>
                <div>Nodes: ${report.graph.visibleNodes}/${report.graph.totalNodes}</div>
                <div>Edges: ${report.graph.visibleEdges}/${report.graph.totalEdges}</div>
                <div>Memory: ${report.summary.memoryUsedMB} MB</div>
                <div>Load: ${report.summary.totalLoadTime.toFixed(0)}ms</div>
            `;
        }, 1000);
        
        return overlay;
    }

    /**
     * Reset all metrics
     */
    reset() {
        this.metrics = {
            loadTime: 0,
            layoutTime: 0,
            renderTime: 0,
            memoryUsage: 0,
            fps: 0,
            visibleNodes: 0,
            totalNodes: 0,
            visibleEdges: 0,
            totalEdges: 0
        };
        this.timers.clear();
        this.frameTimings = [];
        this.lastFrameTime = 0;
    }
}

/**
 * Adaptive Quality Manager
 * Adjusts rendering quality based on performance
 */
export class AdaptiveQualityManager {
    constructor() {
        this.targetFPS = 60;
        this.currentFPS = 60;
        this.qualityLevel = 'high';
        this.frameTimings = [];
        this.maxFrameTimings = 60;
        this.listeners = [];
    }

    /**
     * Measure frame performance
     */
    measureFrame(frameTime) {
        this.frameTimings.push(frameTime);
        if (this.frameTimings.length > this.maxFrameTimings) {
            this.frameTimings.shift();
        }
        
        const avgFrameTime = this.frameTimings.reduce((a, b) => a + b, 0) / this.frameTimings.length;
        this.currentFPS = 1000 / avgFrameTime;
        
        this.adjustQuality();
    }

    /**
     * Adjust quality based on FPS
     */
    adjustQuality() {
        let newQuality = this.qualityLevel;
        
        if (this.currentFPS < 30 && this.qualityLevel !== 'low') {
            newQuality = 'low';
        } else if (this.currentFPS < 45 && this.qualityLevel === 'high') {
            newQuality = 'medium';
        } else if (this.currentFPS > 50 && this.qualityLevel === 'low') {
            newQuality = 'medium';
        } else if (this.currentFPS > 55 && this.qualityLevel === 'medium') {
            newQuality = 'high';
        }
        
        if (newQuality !== this.qualityLevel) {
            this.qualityLevel = newQuality;
            this.notifyQualityChange();
        }
    }

    /**
     * Get quality settings
     */
    getQualitySettings() {
        const settings = {
            high: {
                antialiasing: true,
                shadows: true,
                lod: 'high',
                maxNodes: 1000,
                edgeDetail: 'full'
            },
            medium: {
                antialiasing: true,
                shadows: false,
                lod: 'medium',
                maxNodes: 500,
                edgeDetail: 'simplified'
            },
            low: {
                antialiasing: false,
                shadows: false,
                lod: 'low',
                maxNodes: 200,
                edgeDetail: 'minimal'
            }
        };
        return settings[this.qualityLevel];
    }

    /**
     * Register quality change listener
     */
    onQualityChange(callback) {
        this.listeners.push(callback);
    }

    /**
     * Notify quality change
     */
    notifyQualityChange() {
        const settings = this.getQualitySettings();
        for (const listener of this.listeners) {
            listener(this.qualityLevel, settings);
        }
    }

    /**
     * Get current quality level
     */
    getQualityLevel() {
        return this.qualityLevel;
    }

    /**
     * Set quality level manually
     */
    setQualityLevel(level) {
        if (['low', 'medium', 'high'].includes(level)) {
            this.qualityLevel = level;
            this.notifyQualityChange();
        }
    }
}
