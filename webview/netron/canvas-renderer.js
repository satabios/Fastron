/**
 * Canvas-based Graph Renderer
 * High-performance rendering for large graphs using Canvas API
 */

export class CanvasGraphRenderer {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
        this.offscreenCanvas = null;
        this.offscreenCtx = null;
        
        // Try to create offscreen canvas for caching
        try {
            if (typeof OffscreenCanvas !== 'undefined') {
                this.offscreenCanvas = new OffscreenCanvas(256, 256);
                this.offscreenCtx = this.offscreenCanvas.getContext('2d');
            }
        } catch (e) {
            // Fallback to regular canvas
            this.offscreenCanvas = document.createElement('canvas');
            this.offscreenCanvas.width = 256;
            this.offscreenCanvas.height = 256;
            this.offscreenCtx = this.offscreenCanvas.getContext('2d');
        }
        
        this.nodeCache = new Map();
        this.edgeCache = new Map();
        this.maxCacheSize = options.maxCacheSize || 1000;
        
        // Color schemes
        this.colors = {
            node: {
                default: '#fff',
                border: '#333',
                text: '#000',
                layer: 'rgb(51, 85, 136)',
                activation: 'rgb(112, 41, 33)',
                pool: 'rgb(51, 85, 51)',
                normalization: 'rgb(51, 85, 68)',
                dropout: 'rgb(69, 71, 112)',
                shape: 'rgb(108, 79, 71)',
                tensor: 'rgb(89, 66, 59)',
                transform: 'rgb(51, 85, 68)',
                data: 'rgb(85, 85, 85)',
                quantization: 'rgb(80, 40, 0)',
                attention: 'rgb(120, 60, 0)'
            },
            edge: {
                default: '#000',
                hover: 'rgba(220, 0, 0, 0.9)',
                select: 'rgba(220, 0, 0, 0.9)'
            }
        };
        
        // Check for dark mode
        this.darkMode = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
        if (this.darkMode) {
            this.adjustColorsForDarkMode();
        }
    }

    /**
     * Adjust colors for dark mode
     */
    adjustColorsForDarkMode() {
        this.colors.node.default = '#404040';
        this.colors.node.border = '#1d1d1d';
        this.colors.node.text = '#dfdfdf';
        this.colors.edge.default = '#888';
    }

    /**
     * Clear the canvas
     */
    clear() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        
        // Fill with background color
        this.ctx.fillStyle = this.darkMode ? '#1e1e1e' : '#ffffff';
        this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    /**
     * Render a node with LOD
     */
    renderNode(node, x, y, zoom, lod) {
        const cacheKey = `${node.id || node.v}_${lod}_${zoom.toFixed(2)}`;
        
        // Check cache for pre-rendered node
        if (this.nodeCache.has(cacheKey) && lod !== 'high') {
            const cached = this.nodeCache.get(cacheKey);
            this.ctx.drawImage(cached, x, y);
            return;
        }

        this.ctx.save();
        
        // Render based on level of detail
        switch (lod) {
            case 'low':
                this.renderNodeSimplified(node, x, y, zoom);
                break;
            case 'medium':
                this.renderNodeMedium(node, x, y, zoom);
                break;
            case 'high':
            default:
                this.renderNodeDetailed(node, x, y, zoom);
                break;
        }
        
        this.ctx.restore();
        
        // Cache rendered node (except high detail)
        if (lod !== 'high' && this.nodeCache.size < this.maxCacheSize) {
            this.cacheNode(node, cacheKey, x, y, zoom);
        }
    }

    /**
     * Render simplified node (low LOD)
     */
    renderNodeSimplified(node, x, y, zoom) {
        const width = (node.width || 100) * zoom;
        const height = (node.height || 40) * zoom;
        
        // Simple filled rectangle
        this.ctx.fillStyle = this.getNodeColor(node);
        this.ctx.fillRect(x - width / 2, y - height / 2, width, height);
    }

    /**
     * Render medium detail node
     */
    renderNodeMedium(node, x, y, zoom) {
        const width = (node.width || 100) * zoom;
        const height = (node.height || 40) * zoom;
        const centerX = x;
        const centerY = y;
        
        // Draw rounded rectangle
        this.ctx.fillStyle = this.getNodeColor(node);
        this.ctx.strokeStyle = this.colors.node.border;
        this.ctx.lineWidth = 1;
        
        this.roundRect(centerX - width / 2, centerY - height / 2, width, height, 5 * zoom);
        this.ctx.fill();
        this.ctx.stroke();
        
        // Draw label if zoom is sufficient
        if (zoom >= 0.5) {
            this.ctx.fillStyle = this.colors.node.text;
            this.ctx.font = `${Math.max(9, 11 * zoom)}px sans-serif`;
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            
            const label = this.getNodeLabel(node);
            if (label) {
                // Truncate label if too long
                const maxWidth = width - 10;
                const truncated = this.truncateText(label, maxWidth);
                this.ctx.fillText(truncated, centerX, centerY);
            }
        }
    }

    /**
     * Render detailed node (high LOD)
     */
    renderNodeDetailed(node, x, y, zoom) {
        const width = (node.width || 100) * zoom;
        const height = (node.height || 40) * zoom;
        const centerX = x;
        const centerY = y;
        
        // Draw main node rectangle
        this.ctx.fillStyle = this.getNodeColor(node);
        this.ctx.strokeStyle = this.colors.node.border;
        this.ctx.lineWidth = 1;
        
        this.roundRect(centerX - width / 2, centerY - height / 2, width, height, 5 * zoom);
        this.ctx.fill();
        this.ctx.stroke();
        
        // Draw header
        const headerHeight = 25 * zoom;
        this.ctx.fillStyle = this.getNodeHeaderColor(node);
        this.roundRect(
            centerX - width / 2,
            centerY - height / 2,
            width,
            headerHeight,
            5 * zoom,
            true, true, false, false
        );
        this.ctx.fill();
        
        // Draw header text
        this.ctx.fillStyle = '#fff';
        this.ctx.font = `bold ${Math.max(10, 11 * zoom)}px sans-serif`;
        this.ctx.textAlign = 'left';
        this.ctx.textBaseline = 'middle';
        
        const label = this.getNodeLabel(node);
        if (label) {
            const maxWidth = width - 12;
            const truncated = this.truncateText(label, maxWidth);
            this.ctx.fillText(truncated, centerX - width / 2 + 6, centerY - height / 2 + headerHeight / 2);
        }
        
        // Draw additional details if space permits
        if (height > 50 * zoom) {
            this.renderNodeDetails(node, centerX, centerY, width, height, zoom);
        }
    }

    /**
     * Render node details (attributes, inputs, outputs)
     */
    renderNodeDetails(node, centerX, centerY, width, height, zoom) {
        const headerHeight = 25 * zoom;
        let currentY = centerY - height / 2 + headerHeight + 10 * zoom;
        
        this.ctx.fillStyle = this.colors.node.text;
        this.ctx.font = `${Math.max(8, 9 * zoom)}px sans-serif`;
        this.ctx.textAlign = 'left';
        
        // Draw type if available
        if (node.type) {
            this.ctx.fillText(`Type: ${node.type}`, centerX - width / 2 + 6, currentY);
            currentY += 12 * zoom;
        }
        
        // Draw shape if available
        if (node.shape) {
            this.ctx.fillText(`Shape: ${node.shape}`, centerX - width / 2 + 6, currentY);
            currentY += 12 * zoom;
        }
    }

    /**
     * Render an edge with LOD
     */
    renderEdge(edge, points, lod, zoom = 1) {
        if (!points || points.length < 2) return;
        
        this.ctx.save();
        
        switch (lod) {
            case 'low':
                this.renderEdgeStraight(points, zoom);
                break;
            case 'medium':
            case 'high':
            default:
                this.renderEdgeCurved(points, zoom);
                break;
        }
        
        this.ctx.restore();
    }

    /**
     * Render straight edge (low LOD)
     */
    renderEdgeStraight(points, zoom) {
        this.ctx.strokeStyle = this.colors.edge.default;
        this.ctx.lineWidth = Math.max(0.5, 1 * zoom);
        
        this.ctx.beginPath();
        this.ctx.moveTo(points[0].x, points[0].y);
        this.ctx.lineTo(points[points.length - 1].x, points[points.length - 1].y);
        this.ctx.stroke();
        
        // Draw simple arrowhead
        this.drawArrowhead(
            points[points.length - 2] || points[0],
            points[points.length - 1],
            zoom
        );
    }

    /**
     * Render curved edge
     */
    renderEdgeCurved(points, zoom) {
        this.ctx.strokeStyle = this.colors.edge.default;
        this.ctx.lineWidth = Math.max(0.5, 1 * zoom);
        
        this.ctx.beginPath();
        this.ctx.moveTo(points[0].x, points[0].y);
        
        if (points.length === 2) {
            this.ctx.lineTo(points[1].x, points[1].y);
        } else {
            // Draw smooth curve through points
            for (let i = 1; i < points.length - 2; i++) {
                const xc = (points[i].x + points[i + 1].x) / 2;
                const yc = (points[i].y + points[i + 1].y) / 2;
                this.ctx.quadraticCurveTo(points[i].x, points[i].y, xc, yc);
            }
            
            // Last segment
            if (points.length > 2) {
                this.ctx.quadraticCurveTo(
                    points[points.length - 2].x,
                    points[points.length - 2].y,
                    points[points.length - 1].x,
                    points[points.length - 1].y
                );
            }
        }
        
        this.ctx.stroke();
        
        // Draw arrowhead
        this.drawArrowhead(
            points[points.length - 2] || points[0],
            points[points.length - 1],
            zoom
        );
    }

    /**
     * Draw arrowhead at edge endpoint
     */
    drawArrowhead(fromPoint, toPoint, zoom) {
        const headLength = Math.max(6, 8 * zoom);
        const headWidth = Math.max(4, 6 * zoom);
        
        const dx = toPoint.x - fromPoint.x;
        const dy = toPoint.y - fromPoint.y;
        const angle = Math.atan2(dy, dx);
        
        this.ctx.fillStyle = this.colors.edge.default;
        this.ctx.beginPath();
        this.ctx.moveTo(toPoint.x, toPoint.y);
        this.ctx.lineTo(
            toPoint.x - headLength * Math.cos(angle - Math.PI / 6),
            toPoint.y - headLength * Math.sin(angle - Math.PI / 6)
        );
        this.ctx.lineTo(
            toPoint.x - headLength * Math.cos(angle + Math.PI / 6),
            toPoint.y - headLength * Math.sin(angle + Math.PI / 6)
        );
        this.ctx.closePath();
        this.ctx.fill();
    }

    /**
     * Draw rounded rectangle
     */
    roundRect(x, y, width, height, radius, tl = true, tr = true, br = true, bl = true) {
        this.ctx.beginPath();
        this.ctx.moveTo(x + (tl ? radius : 0), y);
        this.ctx.lineTo(x + width - (tr ? radius : 0), y);
        if (tr) this.ctx.arcTo(x + width, y, x + width, y + radius, radius);
        this.ctx.lineTo(x + width, y + height - (br ? radius : 0));
        if (br) this.ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
        this.ctx.lineTo(x + (bl ? radius : 0), y + height);
        if (bl) this.ctx.arcTo(x, y + height, x, y + height - radius, radius);
        this.ctx.lineTo(x, y + (tl ? radius : 0));
        if (tl) this.ctx.arcTo(x, y, x + radius, y, radius);
        this.ctx.closePath();
    }

    /**
     * Get node color based on type
     */
    getNodeColor(node) {
        const type = node.type || 'default';
        const typeKey = type.toLowerCase().replace(/[^a-z]/g, '');
        return this.colors.node[typeKey] || this.colors.node.default;
    }

    /**
     * Get node header color
     */
    getNodeHeaderColor(node) {
        const baseColor = this.getNodeColor(node);
        // Darken the base color for header
        return this.darkenColor(baseColor, 0.2);
    }

    /**
     * Darken a color
     */
    darkenColor(color, factor) {
        // Simple darkening - multiply RGB values
        if (color.startsWith('rgb')) {
            const match = color.match(/\d+/g);
            if (match && match.length >= 3) {
                const r = Math.floor(parseInt(match[0]) * (1 - factor));
                const g = Math.floor(parseInt(match[1]) * (1 - factor));
                const b = Math.floor(parseInt(match[2]) * (1 - factor));
                return `rgb(${r}, ${g}, ${b})`;
            }
        }
        return color;
    }

    /**
     * Get node label
     */
    getNodeLabel(node) {
        if (node.label) {
            if (typeof node.label === 'string') {
                return node.label;
            }
            if (node.label.name) {
                return node.label.name;
            }
            if (node.label.type) {
                return node.label.type;
            }
        }
        return node.name || node.type || node.id || node.v || '';
    }

    /**
     * Truncate text to fit width
     */
    truncateText(text, maxWidth) {
        const metrics = this.ctx.measureText(text);
        if (metrics.width <= maxWidth) {
            return text;
        }
        
        // Binary search for best fit
        let left = 0;
        let right = text.length;
        let best = '';
        
        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const truncated = text.substring(0, mid) + '...';
            const width = this.ctx.measureText(truncated).width;
            
            if (width <= maxWidth) {
                best = truncated;
                left = mid + 1;
            } else {
                right = mid - 1;
            }
        }
        
        return best || '...';
    }

    /**
     * Cache a rendered node
     */
    cacheNode(node, key, x, y, zoom) {
        try {
            const width = (node.width || 100) * zoom;
            const height = (node.height || 40) * zoom;
            
            // Create cache canvas
            const cacheCanvas = document.createElement('canvas');
            cacheCanvas.width = Math.ceil(width);
            cacheCanvas.height = Math.ceil(height);
            const cacheCtx = cacheCanvas.getContext('2d');
            
            // Copy rendered content
            cacheCtx.drawImage(
                this.canvas,
                x - width / 2, y - height / 2, width, height,
                0, 0, width, height
            );
            
            this.nodeCache.set(key, cacheCanvas);
            
            // Limit cache size
            if (this.nodeCache.size > this.maxCacheSize) {
                const firstKey = this.nodeCache.keys().next().value;
                this.nodeCache.delete(firstKey);
            }
        } catch (e) {
            // Caching failed, continue without cache
        }
    }

    /**
     * Clear caches
     */
    clearCache() {
        this.nodeCache.clear();
        this.edgeCache.clear();
    }

    /**
     * Resize canvas
     */
    resize(width, height) {
        this.canvas.width = width;
        this.canvas.height = height;
        this.clearCache();
    }

    /**
     * Get canvas statistics
     */
    getStats() {
        return {
            nodeCacheSize: this.nodeCache.size,
            edgeCacheSize: this.edgeCache.size,
            canvasWidth: this.canvas.width,
            canvasHeight: this.canvas.height
        };
    }
}
