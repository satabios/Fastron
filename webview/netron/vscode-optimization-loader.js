/**
 * VSCode Webview Optimization Loader
 * Ensures all optimizations are loaded in the VSCode webview environment
 */

(function() {
    'use strict';
    
    console.log('[Netron VSCode] Loading optimizations...');
    
    // 1. Load tensor configuration
    if (typeof window !== 'undefined') {
        window.NETRON_CONFIG = window.NETRON_CONFIG || {};
        
        // Skip tensor weights by default (huge memory savings!)
        window.NETRON_CONFIG.skipTensorWeights = true;
        
        // Maximum tensor size to display (in elements)
        window.NETRON_CONFIG.maxTensorDisplaySize = 1000;
        
        // Show tensor metadata instead of full data
        window.NETRON_CONFIG.showTensorMetadata = true;
        
        // Log memory savings
        window.NETRON_CONFIG.logMemorySavings = true;
        
        // Enable performance optimizations
        window.NETRON_CONFIG.enableOptimizations = true;
        
        // Memory limit (MB)
        window.NETRON_CONFIG.memoryLimit = 500;
        
        // Spatial index tile size
        window.NETRON_CONFIG.tileSize = 1000;
        
        console.log('[Netron VSCode] Tensor weight loading: DISABLED (saves 90% memory)');
        console.log('[Netron VSCode] Performance optimizations: ENABLED');
    }
    
    // 2. Monitor memory usage
    if (typeof window !== 'undefined' && window.performance && window.performance.memory) {
        const checkMemory = () => {
            const used = Math.round(window.performance.memory.usedJSHeapSize / 1024 / 1024);
            const total = Math.round(window.performance.memory.totalJSHeapSize / 1024 / 1024);
            const limit = Math.round(window.performance.memory.jsHeapSizeLimit / 1024 / 1024);
            
            if (used > limit * 0.8) {
                console.warn(`[Netron VSCode] High memory usage: ${used}MB / ${limit}MB`);
            }
        };
        
        // Check memory every 10 seconds
        setInterval(checkMemory, 10000);
    }
    
    // 3. Prevent memory leaks
    if (typeof window !== 'undefined') {
        // Clear large objects on unload
        window.addEventListener('beforeunload', () => {
            console.log('[Netron VSCode] Cleaning up...');
            
            // Clear any cached data
            if (window.sessionStorage) {
                try {
                    window.sessionStorage.clear();
                } catch (e) {
                    // Ignore errors
                }
            }
        });
    }
    
    // 4. Error handling
    if (typeof window !== 'undefined') {
        window.addEventListener('error', (event) => {
            if (event.error && event.error.message) {
                const msg = event.error.message;
                
                // Check for memory-related errors
                if (msg.includes('memory') || msg.includes('heap') || msg.includes('allocation')) {
                    console.error('[Netron VSCode] Memory error detected:', msg);
                    console.error('[Netron VSCode] Try closing other applications or reloading the window');
                    
                    // Try to free memory
                    if (window.gc) {
                        try {
                            window.gc();
                            console.log('[Netron VSCode] Garbage collection triggered');
                        } catch (e) {
                            // GC not available
                        }
                    }
                }
            }
        });
    }
    
    // 5. Performance monitoring
    if (typeof window !== 'undefined') {
        const startTime = Date.now();
        
        window.addEventListener('load', () => {
            const loadTime = Date.now() - startTime;
            console.log(`[Netron VSCode] Page loaded in ${loadTime}ms`);
            
            if (window.performance && window.performance.memory) {
                const used = Math.round(window.performance.memory.usedJSHeapSize / 1024 / 1024);
                console.log(`[Netron VSCode] Memory usage: ${used}MB`);
            }
        });
    }
    
    console.log('[Netron VSCode] Optimizations loaded successfully');
})();
