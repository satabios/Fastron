/**
 * Level of Detail (LOD) Manager
 * Determines rendering quality based on zoom level and distance
 */

export class LODManager {
    constructor() {
        this.lodLevels = {
            high: { minZoom: 1.0, maxNodes: 100, minNodeSize: 20 },
            medium: { minZoom: 0.5, maxNodes: 500, minNodeSize: 10 },
            low: { minZoom: 0, maxNodes: Infinity, minNodeSize: 2 }
        };
    }

    /**
     * Determine LOD based on zoom level, node count, and distance from center
     */
    determineLOD(zoom, nodeCount, distanceFromCenter) {
        // High detail for close-up views
        if (zoom >= 1.0 && nodeCount < 100) {
            return 'high';
        }
        
        // Medium detail for moderate zoom
        if (zoom >= 0.5 && nodeCount < 500) {
            return 'medium';
        }
        
        // Low detail for distant nodes
        if (distanceFromCenter > 2000 || zoom < 0.5) {
            return 'low';
        }
        
        return 'medium';
    }

    /**
     * Determine if a node should be rendered based on LOD
     */
    shouldRenderNode(node, viewport, zoom) {
        const lod = this.determineLOD(zoom, 1, 0);
        const minSize = this.lodLevels[lod].minNodeSize;
        
        // Skip rendering very small nodes at low zoom
        if (node.width * zoom < minSize || node.height * zoom < minSize) {
            return false;
        }
        
        return true;
    }

    /**
     * Simplify node representation based on LOD
     */
    simplifyNode(node, lod) {
        switch (lod) {
            case 'low':
                // Minimal representation - just position and size
                return {
                    id: node.id || node.v,
                    x: node.x,
                    y: node.y,
                    width: node.width,
                    height: node.height,
                    type: node.type || 'node',
                    simplified: true
                };
            
            case 'medium':
                // Include basic label but skip detailed blocks
                return {
                    id: node.id || node.v,
                    x: node.x,
                    y: node.y,
                    width: node.width,
                    height: node.height,
                    type: node.type || 'node',
                    label: node.label ? (node.label.name || node.label.type || '') : '',
                    simplified: true
                };
            
            case 'high':
            default:
                // Full detail
                return node;
        }
    }

    /**
     * Simplify edge representation based on LOD
     */
    simplifyEdge(edge, lod) {
        if (!edge.points || edge.points.length === 0) {
            return edge;
        }

        switch (lod) {
            case 'low':
                // Straight line between endpoints
                return {
                    ...edge,
                    points: [edge.points[0], edge.points[edge.points.length - 1]],
                    simplified: true
                };
            
            case 'medium':
                // Simplified curve with fewer points
                if (edge.points.length <= 4) {
                    return edge;
                }
                const step = Math.ceil(edge.points.length / 4);
                const simplifiedPoints = [];
                for (let i = 0; i < edge.points.length; i += step) {
                    simplifiedPoints.push(edge.points[i]);
                }
                // Always include last point
                if (simplifiedPoints[simplifiedPoints.length - 1] !== edge.points[edge.points.length - 1]) {
                    simplifiedPoints.push(edge.points[edge.points.length - 1]);
                }
                return {
                    ...edge,
                    points: simplifiedPoints,
                    simplified: true
                };
            
            case 'high':
            default:
                // Full detail
                return edge;
        }
    }

    /**
     * Get rendering settings for a specific LOD level
     */
    getRenderSettings(lod) {
        const settings = {
            high: {
                renderText: true,
                renderBorders: true,
                renderShadows: true,
                renderDetails: true,
                antialiasing: true,
                lineWidth: 1,
                fontSize: 11
            },
            medium: {
                renderText: true,
                renderBorders: true,
                renderShadows: false,
                renderDetails: false,
                antialiasing: true,
                lineWidth: 1,
                fontSize: 9
            },
            low: {
                renderText: false,
                renderBorders: false,
                renderShadows: false,
                renderDetails: false,
                antialiasing: false,
                lineWidth: 0.5,
                fontSize: 0
            }
        };
        
        return settings[lod] || settings.medium;
    }

    /**
     * Calculate distance from viewport center
     */
    getDistanceFromCenter(nodeX, nodeY, viewportX, viewportY, viewportWidth, viewportHeight) {
        const centerX = viewportX + viewportWidth / 2;
        const centerY = viewportY + viewportHeight / 2;
        const dx = nodeX - centerX;
        const dy = nodeY - centerY;
        return Math.sqrt(dx * dx + dy * dy);
    }

    /**
     * Determine LOD for a specific node based on viewport
     */
    getNodeLOD(node, viewport) {
        const distance = this.getDistanceFromCenter(
            node.x,
            node.y,
            viewport.x,
            viewport.y,
            viewport.width,
            viewport.height
        );
        
        return this.determineLOD(viewport.zoom, 1, distance);
    }
}
