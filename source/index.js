// Global configuration for tensor weight loading optimization
window.NETRON_CONFIG = {
    skipTensorWeights: true,           // Skip loading tensor weights by default (huge memory savings!)
    maxTensorDisplaySize: 1000,        // Maximum tensor size to display (in elements)
    showTensorMetadata: true,          // Show tensor metadata instead of full data
    logMemorySavings: false,           // Log memory savings to console
    enableOptimizations: true,         // Enable performance optimizations
    cacheEnabled: true,                // Enable in-memory caching
    cacheMaxMemoryMB: 2048,            // Cache memory budget (MB)
    streamingChunkSizeMB: 10,          // Chunk size for streaming reads (MB)
    streamingThresholdMB: 50,          // Stream files larger than this (MB)
    fileReadChunkSizeMB: 16,            // Browser file chunk read size (MB)
    streamWindowSizeMB: 16,             // In-memory stream window size (MB)
    maxLayoutWorkers: 4,               // Worker budget for graph/layout tasks
    gpuAcceleration: true,             // Enable GPU compositing hints when available
    gpuAvailable: false,               // Runtime-detected availability
    gpuBackend: 'cpu',                 // Runtime-selected backend: webgpu|webgl2|webgl|cpu
    gpuVendor: 'none',                 // Detected GPU vendor: nvidia|qualcomm|apple|amd|intel|arm|unknown|none
    gpuDevice: '',                     // GPU device/renderer string
    gpuArchitecture: '',               // GPU architecture (WebGPU only)
    gpuLabel: '',                      // Human-readable GPU label shown in About panel
    cudaAvailable: false,              // NVIDIA GPU detected (CUDA via WebGPU/WebGL)
    adrenoAvailable: false             // Qualcomm Adreno GPU detected
};
// eslint-disable-next-line no-console
console.log('[Fastron] Tensor weight loading:', window.NETRON_CONFIG.skipTensorWeights ? 'DISABLED (saves memory)' : 'ENABLED (full data)');

window.exports = {};

window.exports.require = function(id, callback) {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
        throw new Error("Invalid module '" + id + "'.");
    }
    let base = window.location.href || '';
    base = base.split('?')[0].split('#')[0];
    const index = base.lastIndexOf('/');
    base = index > 0 ? base.substring(0, index + 1) : base;
    base = base.lastIndexOf('/') === base.length - 1 ? base : base + '/';
    var url = base + id + '.js';
    var scripts = document.head.getElementsByTagName('script');
    for (var i = 0; i < scripts.length; i++) {
        if (url === scripts[i].getAttribute('src')) {
            throw new Error("Duplicate import of '" + url + "'.");
        }
    }
    var script = document.createElement('script');
    script.setAttribute('id', id);
    script.setAttribute('type', 'module');
    /* eslint-disable no-use-before-define */
    var loadHandler = function() {
        script.removeEventListener('load', loadHandler);
        script.removeEventListener('error', errorHandler);
        callback();
    };
    var errorHandler = function(e) {
        script.removeEventListener('load', loadHandler);
        script.removeEventListener('error', errorHandler);
        callback(null, new Error("The script '" + e.target.src + "' failed to load."));
    };
    /* eslint-enable no-use-before-define */
    script.addEventListener('load', loadHandler, false);
    script.addEventListener('error', errorHandler, false);
    script.setAttribute('src', url);
    document.head.appendChild(script);
};

window.exports.preload = function(callback) {
    var modules = [
        ['view', 'browser']
    ];
    var next = function() {
        if (modules.length === 0) {
            callback();
        } else {
            var ids = modules.pop();
            /* eslint-disable no-loop-func */
            var resolved = ids.length;
            for (var i = 0; i < ids.length; i++) {
                window.exports.require(ids[i], function(module, error) {
                    if (error) {
                        callback(null, error);
                    } else {
                        resolved--;
                        if (resolved === 0) {
                            next();
                        }
                    }
                });
            }
            /* eslint-enable no-loop-func */
        }
    };
    next();
};

window.exports.terminate = function(message) {
    document.getElementById('message-text').innerText = message;
    var button = document.getElementById('message-button');
    button.style.display = 'none';
    button.onclick = null;
    document.body.setAttribute('class', 'welcome message');
    if (window.__view__) {
        /* eslint-disable no-unused-vars */
        try {
            window.__view__.show('welcome message');
        } catch (error) {
            // continue regardless of error
        }
        /* eslint-enable no-unused-vars */
    }
};

window.addEventListener('error', function (event) {
    var error = event instanceof ErrorEvent && event.error && event.error instanceof Error ? event.error : new Error(event && event.message ? event.message : JSON.stringify(event));
    window.exports.terminate(error.message);
});

window.addEventListener('load', function() {
    if (typeof Symbol !== 'function' || typeof Symbol.asyncIterator !== 'symbol' ||
        typeof BigInt !== 'function' || typeof BigInt.asIntN !== 'function' || typeof BigInt.asUintN !== 'function' || typeof DataView.prototype.getBigInt64 !== 'function') {
        throw new Error('Please update your browser to use this application.');
    }
    var ua = window.navigator.userAgent;
    var chrome = ua.match(/Chrom(e|ium)\/([0-9]+)\./);
    var safari = ua.match(/Version\/(\d+).*Safari/);
    var firefox = ua.match(/Firefox\/([0-9]+)\./);
    if ((Array.isArray(chrome) && parseInt(chrome[2], 10) < 80) ||
        (Array.isArray(safari) && parseInt(safari[1], 10) < 15) ||
        (Array.isArray(firefox) && parseInt(firefox[1], 10) < 114)) {
        throw new Error('Please update your browser to use this application.');
    }
    window.exports.preload(function(value, error) {
        if (error) {
            window.exports.terminate(error.message);
        } else {
            var host = new window.exports.browser.Host();
            window.__view__ = new window.exports.view.View(host);
            window.__view__.start();
        }
    });
});
