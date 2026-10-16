
import * as base from './base.js';
import * as json from './json.js';
import { NodeCatalog } from './repeated-blocks.js';

const safetensors = {};

safetensors.ModelFactory = class {

    async match(context) {
        const container = safetensors.Container.open(context);
        if (container) {
            return context.set('safetensors', container);
        }
        const obj = await context.peek('json');
        if (obj && obj.weight_map) {
            const entries = Object.entries(obj.weight_map);
            if (entries.length > 0 && entries.every(([, value]) => typeof value === 'string' && value.endsWith('.safetensors'))) {
                return context.set('safetensors.json', entries);
            }
        }
        return null;
    }

    async open(context) {
        switch (context.type) {
            case 'safetensors': {
                const container = context.value;
                await container.read();
                return new safetensors.Model(container.entries);
            }
            case 'safetensors.json': {
                const weight_map = new Map(context.value);
                const keys = new Set(weight_map.keys());
                const files = Array.from(new Set(weight_map.values()));
                const contexts = await Promise.all(files.map((name) => context.fetch(name)));
                const containers = contexts.map((context) => safetensors.Container.open(context));
                await Promise.all(containers.map((container) => container.read()));
                const entries = new Map();
                for (const container of containers) {
                    for (const [key, value] of Array.from(container.entries)) {
                        if (keys.has(key)) {
                            entries.set(key, value);
                        }
                    }
                }
                return new safetensors.Model(entries);
            }
            default: {
                throw new safetensors.Error(`Unsupported Safetensors format '${context.type}'.`);
            }
        }
    }
};

safetensors.Model = class {

    constructor(entries) {
        this.format = 'Safetensors';
        this.modules = [new safetensors.Module(entries)];
    }
};

safetensors.Module = class {

    constructor(entries) {
        this.inputs = [];
        this.outputs = [];
        const layers = new Map();
        for (const [key, value] of Array.from(entries)) {
            if (key === '__metadata__') {
                continue;
            }
            const parts = key.split('.');
            const name = parts.pop();
            const layer = parts.join('.');
            if (!layers.has(layer)) {
                layers.set(layer, []);
            }
            layers.get(layer).push([name, key, value]);
        }
        this.nodes = new NodeCatalog(Array.from(layers, ([name, values]) => ({ name, values })),
            (record) => new safetensors.Node(record.name, record.values),
            (record) => ({ name: record.name, type: { name: 'Module' }, outputs: [], attributes: [],
                inputs: record.values.map(([name, key, obj]) => ({ name, value: [{ name: key,
                    type: { dataType: safetensors.TensorType.dataType(obj.dtype), shape: { dimensions: obj.shape } }, initializer: {} }] })) })).nodes;
    }
};

safetensors.Argument = class {

    constructor(name, value) {
        this.name = name;
        this.value = value;
    }
};

safetensors.Value = class {

    constructor(name, value) {
        this.name = name;
        this.type = value.type;
        this.initializer = value;
    }
};

safetensors.Node = class {

    constructor(name, values) {
        this.name = name;
        this.type = { name: 'Module' };
        this.inputs = [];
        this.outputs = [];
        this.attributes = [];
        for (const [name, identifier, obj] of values) {
            const tensor = new safetensors.Tensor(obj);
            const value = new safetensors.Value(identifier, tensor);
            const argument = new safetensors.Argument(name, [value]);
            this.inputs.push(argument);
        }
    }
};

safetensors.TensorType = class {

    constructor(dtype, shape) {
        this.dataType = safetensors.TensorType.dataType(dtype);
        this.shape = shape;
    }

    static dataType(dtype) {
        switch (dtype) {
            case 'I8':      return 'int8';
            case 'I16':     return 'int16';
            case 'I32':     return 'int32';
            case 'I64':     return 'int64';
            case 'U8':      return 'uint8';
            case 'U16':     return 'uint16';
            case 'U32':     return 'uint32';
            case 'U64':     return 'uint64';
            case 'BF16':    return 'bfloat16';
            case 'F16':     return 'float16';
            case 'F32':     return 'float32';
            case 'F64':     return 'float64';
            case 'BOOL':    return 'boolean';
            case 'F8_E4M3': return 'float8e4m3fn';
            case 'F8_E5M2': return 'float8e5m2';
            default: throw new safetensors.Error(`Unsupported data type '${dtype}'.`);
        }
    }

    toString() {
        return this.dataType + this.shape.toString();
    }
};

safetensors.TensorShape = class {

    constructor(dimensions) {
        this.dimensions = dimensions;
    }

    toString() {
        return `[${this.dimensions.map((dimension) => dimension.toString()).join(',')}]`;
    }
};

safetensors.Tensor = class {

    constructor(obj) {
        const shape = new safetensors.TensorShape(obj.shape);
        this.type = new safetensors.TensorType(obj.dtype, shape);
        this.encoding = '<';
        this.data = obj.__data__;
        if (obj.__source__) {
            const source = obj.__source__;
            const position = source.position;
            try {
                source.seek(obj.__offset__ + obj.data_offsets[0]);
                this.data = source.stream(obj.data_offsets[1] - obj.data_offsets[0]);
            } finally {
                source.seek(position);
            }
        }
    }

    get values() {
        if (this.data instanceof Uint8Array) {
            return this.data;
        }
        if (this.data && this.data.peek) {
            return this.data.peek();
        }
        return null;
    }

    peek() {
        return !this.data || (!this.data.remote && !this.data.file);
    }

    async read() {
        if (this.data && !this.peek()) {
            this.data = await this.data.readAt(0, this.data.length);
        }
    }

    async preview(limit) {
        const source = this.data instanceof Uint8Array ? new base.BinaryStream(this.data) : this.data;
        return source ? base.Tensor.preview(this, source, limit) : null;
    }
};

safetensors.Container = class {

    static open(context) {
        const identifier = context.identifier;
        const stream = context.stream;
        if (stream.length > 9) {
            const buffer = stream.peek(9);
            if (buffer[6] === 0 && buffer[7] === 0 && buffer[8] === 0x7b) {
                const size = buffer[0] | buffer[1] << 8 | buffer[2] << 16 | buffer [3] << 24 | buffer [3] << 32 | buffer [3] << 40;
                if (size < stream.length) {
                    return new safetensors.Container(identifier, stream, size);
                }
            }
        }
        return null;
    }

    constructor(identifier, stream, size) {
        this.identifier = identifier;
        this.size = size;
        this.stream = stream;
        this.entries = new Map();
    }

    async read() {
        const stream = this.stream;
        const position = stream.position;
        stream.seek(8);
        const buffer = stream.read(this.size);
        const reader = json.TextReader.open(buffer);
        const obj = reader.read();
        const offset = stream.position;
        for (const [key, value] of Object.entries(obj)) {
            if (key === '__metadata__') {
                continue;
            }
            if (!value || !Array.isArray(value.data_offsets) || value.data_offsets.length !== 2) {
                throw new safetensors.Error(`Invalid tensor metadata for '${key}'.`);
            }
            const [start, end] = value.data_offsets;
            safetensors.TensorType.dataType(value.dtype);
            if (!Array.isArray(value.shape) || !value.shape.every((dim) => Number.isSafeInteger(dim) && dim >= 0) ||
                !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > stream.length - offset) {
                throw new safetensors.Error(`Invalid tensor metadata for '${key}'.`);
            }
            value.__source__ = stream;
            value.__offset__ = offset;
            this.entries.set(key, value);
        }
        stream.seek(position);
        delete this.size;
        delete this.stream;
    }
};

safetensors.Error = class extends Error {

    constructor(message) {
        super(message);
        this.name = 'Error loading Safetensors model.';
    }
};

export const ModelFactory = safetensors.ModelFactory;
