/**
 * Tensor Weight Loading Configuration
 * Global settings to control tensor weight loading behavior
 */

// Global configuration for tensor loading
window.NETRON_CONFIG = window.NETRON_CONFIG || {};

// Skip loading tensor weights by default (huge memory savings!)
window.NETRON_CONFIG.skipTensorWeights = true;

// Maximum tensor size to display (in elements)
window.NETRON_CONFIG.maxTensorDisplaySize = 1000;

// Show tensor metadata instead of full data
window.NETRON_CONFIG.showTensorMetadata = true;

// Log memory savings
window.NETRON_CONFIG.logMemorySavings = true;

console.log('[Netron Optimization] Tensor weight loading disabled by default');
console.log('[Netron Optimization] This significantly reduces memory usage');
console.log('[Netron Optimization] To enable: window.NETRON_CONFIG.skipTensorWeights = false');
