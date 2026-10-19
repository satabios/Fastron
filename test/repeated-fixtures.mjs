import * as fs from 'node:fs';
import * as path from 'node:path';

const varint = (value) => {
    const result = [];
    do {
        result.push((value % 128) | (value >= 128 ? 128 : 0));
        value = Math.floor(value / 128);
    } while (value);
    return Buffer.from(result);
};
const prefix = (field, length) => Buffer.concat([varint(field * 8 + 2), varint(length)]);
const field = (id, value) => {
    const body = typeof value === 'string' ? Buffer.from(value) : value;
    return Buffer.concat([prefix(id, body.length), body]);
};
const uint64 = (value) => {
    const result = Buffer.alloc(8);
    result.writeBigUInt64LE(BigInt(value));
    return result;
};
const uint32 = (value) => {
    const result = Buffer.alloc(4);
    result.writeUInt32LE(value);
    return result;
};
const text = (value) => Buffer.concat([uint64(Buffer.byteLength(value)), Buffer.from(value)]);

export const writeRepeatedModel = (folder, format, count = 24, tensorBytes = 4 * 1024 * 1024) => {
    if (!['safetensors', 'gguf', 'onnx'].includes(format) || !Number.isSafeInteger(count) || count < 1 ||
        !Number.isSafeInteger(tensorBytes) || tensorBytes < 4 || tensorBytes % 4 !== 0) {
        throw new Error('Use a supported format, positive layer count and tensor byte size divisible by four.');
    }
    const file = path.join(folder, `repeated.${format}`);
    const tensors = [];
    if (format === 'onnx') {
        const nodes = [];
        for (let i = 0; i < count; i++) {
            nodes.push(field(1, Buffer.concat([field(1, i ? `output_${i - 1}` : 'input'), field(1, `encoder.layers.${i}.weight`),
                field(2, `hidden_${i}`), field(3, `encoder.layers.${i}.add`), field(4, 'Add')])));
            nodes.push(field(1, Buffer.concat([field(1, `hidden_${i}`), field(2, `output_${i}`), field(3, `encoder.layers.${i}.relu`), field(4, 'Relu')])));
            tensors.push({ name: `encoder.layers.${i}.weight`, bytes: tensorBytes, marker: i * 10 });
        }
        const type = field(1, Buffer.concat([Buffer.from([8, 1]), field(2, field(1, Buffer.concat([Buffer.from([8]), varint(tensorBytes / 4)])))]));
        const info = (name) => Buffer.concat([field(1, name), field(2, type)]);
        const ports = Buffer.concat([field(11, info('input')), field(12, info(`output_${count - 1}`)),
            ...Array.from({ length: count }, (_, i) => field(13, info(`hidden_${i}`))),
            ...Array.from({ length: count - 1 }, (_, i) => field(13, info(`output_${i}`)))]);
        for (const tensor of tensors) {
            tensor.header = Buffer.concat([field(1, varint(tensorBytes / 4)), Buffer.from([16, 1]), field(8, tensor.name), prefix(9, tensorBytes)]);
        }
        const bodySize = nodes.reduce((n, node) => n + node.length, ports.length) +
            tensors.reduce((n, tensor) => n + prefix(5, tensor.header.length + tensor.bytes).length + tensor.header.length + tensor.bytes, 0);
        const descriptor = fs.openSync(file, 'w');
        let position = 0;
        const append = (data) => {
            fs.writeSync(descriptor, data, 0, data.length, position);
            position += data.length;
        };
        try {
            append(Buffer.concat([Buffer.from([8, 8]), field(8, Buffer.from([16, 13])), prefix(7, bodySize), ...nodes]));
            for (const tensor of tensors) {
                append(prefix(5, tensor.header.length + tensor.bytes));
                append(tensor.header);
                tensor.offset = position;
                const marker = Buffer.alloc(4);
                marker.writeFloatLE(tensor.marker);
                fs.writeSync(descriptor, marker, 0, marker.length, position);
                position += tensor.bytes;
            }
            append(ports);
            fs.ftruncateSync(descriptor, position);
        } finally {
            fs.closeSync(descriptor);
        }
        return { file, tensors };
    }
    let length = 0;
    for (let i = 0; i < count; i++) {
        for (const module of ['q_proj', 'v_proj']) {
            for (const parameter of ['weight', 'bias']) {
                const name = format === 'gguf' ? `blk.${i}.${module}.${parameter}` : `encoder.layers.${i}.${module}.${parameter}`;
                const bytes = parameter === 'weight' ? tensorBytes : 16;
                if (format === 'gguf') {
                    length = Math.ceil(length / 32) * 32;
                }
                tensors.push({ name, bytes, marker: i * 10 + (module === 'v_proj' ? 1 : 0) + (parameter === 'bias' ? 0.5 : 0), offset: length });
                length += bytes;
            }
        }
    }
    let header = null;
    if (format === 'safetensors') {
        const obj = Object.fromEntries(tensors.map((tensor) => [tensor.name, { dtype: 'F32', shape: [tensor.bytes / 4], data_offsets: [tensor.offset, tensor.offset + tensor.bytes] }]));
        const json = Buffer.from(JSON.stringify(obj));
        const body = Buffer.concat([json, Buffer.alloc((8 - json.length % 8) % 8, 32)]);
        header = Buffer.concat([uint64(body.length), body]);
    } else {
        header = Buffer.concat([Buffer.from('GGUF'), uint32(3), uint64(tensors.length), uint64(0),
            ...tensors.map((tensor) => Buffer.concat([text(tensor.name), uint32(1), uint64(tensor.bytes / 4), uint32(0), uint64(tensor.offset)]))]);
        header = Buffer.concat([header, Buffer.alloc((32 - header.length % 32) % 32)]);
    }
    const descriptor = fs.openSync(file, 'w');
    try {
        fs.writeSync(descriptor, header);
        for (const tensor of tensors) {
            tensor.offset += header.length;
            const marker = Buffer.alloc(4);
            marker.writeFloatLE(tensor.marker);
            fs.writeSync(descriptor, marker, 0, marker.length, tensor.offset);
        }
        fs.ftruncateSync(descriptor, header.length + length);
    } finally {
        fs.closeSync(descriptor);
    }
    return { file, tensors };
};
