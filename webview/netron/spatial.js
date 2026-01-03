/*
 * Spatial indexing using QuadTree for efficient viewport culling
 * Enables O(log n) queries for visible nodes instead of O(n) iteration
 */

var spatial = spatial || {};

// QuadTree for spatial indexing of graph nodes
spatial.QuadTree = class {

    constructor(bounds, capacity = 4) {
        this.bounds = bounds;  // {x, y, width, height}
        this.capacity = capacity;
        this.nodes = [];
        this.divided = false;
        this.northeast = null;
        this.northwest = null;
        this.southeast = null;
        this.southwest = null;
    }

    // Check if a point or bounds is within this quadrant
    contains(itemBounds) {
        const itemCenterX = itemBounds.x + (itemBounds.width || 0) / 2;
        const itemCenterY = itemBounds.y + (itemBounds.height || 0) / 2;
        
        return itemCenterX >= this.bounds.x &&
               itemCenterX < this.bounds.x + this.bounds.width &&
               itemCenterY >= this.bounds.y &&
               itemCenterY < this.bounds.y + this.bounds.height;
    }

    // Check if this quadrant intersects with a query range
    intersects(range) {
        return !(range.x > this.bounds.x + this.bounds.width ||
                 range.x + range.width < this.bounds.x ||
                 range.y > this.bounds.y + this.bounds.height ||
                 range.y + range.height < this.bounds.y);
    }

    // Subdivide this quadrant into 4 sub-quadrants
    subdivide() {
        const x = this.bounds.x;
        const y = this.bounds.y;
        const w = this.bounds.width / 2;
        const h = this.bounds.height / 2;

        this.northeast = new spatial.QuadTree({ x: x + w, y: y, width: w, height: h }, this.capacity);
        this.northwest = new spatial.QuadTree({ x: x, y: y, width: w, height: h }, this.capacity);
        this.southeast = new spatial.QuadTree({ x: x + w, y: y + h, width: w, height: h }, this.capacity);
        this.southwest = new spatial.QuadTree({ x: x, y: y + h, width: w, height: h }, this.capacity);

        this.divided = true;
    }

    // Insert a node into the quadtree
    insert(node) {
        if (!node || !node.bounds) {
            return false;
        }

        if (!this.contains(node.bounds)) {
            return false;
        }

        if (this.nodes.length < this.capacity) {
            this.nodes.push(node);
            return true;
        }

        if (!this.divided) {
            this.subdivide();
        }

        return this.northeast.insert(node) ||
               this.northwest.insert(node) ||
               this.southeast.insert(node) ||
               this.southwest.insert(node);
    }

    // Query all nodes within a range (viewport)
    query(range, found = []) {
        if (!this.intersects(range)) {
            return found;
        }

        for (const node of this.nodes) {
            if (this._boundsIntersect(node.bounds, range)) {
                found.push(node);
            }
        }

        if (this.divided) {
            this.northeast.query(range, found);
            this.northwest.query(range, found);
            this.southeast.query(range, found);
            this.southwest.query(range, found);
        }

        return found;
    }

    // Check if two bounds intersect
    _boundsIntersect(a, b) {
        return !(a.x > b.x + b.width ||
                 a.x + a.width < b.x ||
                 a.y > b.y + b.height ||
                 a.y + a.height < b.y);
    }

    // Clear all nodes from the tree
    clear() {
        this.nodes = [];
        this.divided = false;
        this.northeast = null;
        this.northwest = null;
        this.southeast = null;
        this.southwest = null;
    }

    // Get total count of nodes in tree (for debugging)
    count() {
        let total = this.nodes.length;
        if (this.divided) {
            total += this.northeast.count();
            total += this.northwest.count();
            total += this.southeast.count();
            total += this.southwest.count();
        }
        return total;
    }
};

// Helper function to build QuadTree from graph nodes
spatial.buildQuadTree = (nodes, padding = 100) => {
    if (!nodes || nodes.size === 0) {
        return null;
    }

    // Calculate bounds of entire graph
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const [id, nodeEntry] of nodes) {
        const node = nodeEntry.label;
        if (node.x !== undefined && node.y !== undefined) {
            minX = Math.min(minX, node.x);
            minY = Math.min(minY, node.y);
            maxX = Math.max(maxX, node.x + (node.width || 0));
            maxY = Math.max(maxY, node.y + (node.height || 0));
        }
    }

    // Add padding to bounds
    const bounds = {
        x: minX - padding,
        y: minY - padding,
        width: maxX - minX + 2 * padding,
        height: maxY - minY + 2 * padding
    };

    // Create QuadTree with appropriate capacity (tune based on graph size)
    const capacity = nodes.size > 1000 ? 8 : 4;
    const quadTree = new spatial.QuadTree(bounds, capacity);

    // Insert all nodes
    for (const [id, nodeEntry] of nodes) {
        const node = nodeEntry.label;
        if (node.x !== undefined && node.y !== undefined) {
            const nodeBounds = {
                x: node.x,
                y: node.y,
                width: node.width || 0,
                height: node.height || 0
            };
            quadTree.insert({
                id: id,
                bounds: nodeBounds,
                node: node,
                entry: nodeEntry
            });
        }
    }

    return quadTree;
};

if (typeof module !== 'undefined' && typeof module.exports !== 'undefined') {
    module.exports.spatial = spatial;
}
