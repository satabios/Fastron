//! Metadata-only indexing. Tensor bodies retain their original file offsets.
#![cfg(any(target_arch = "wasm32", test))]

type Result<T> = std::result::Result<T, String>;

trait Source {
    fn read_at(&mut self, offset: u64, bytes: &mut [u8]) -> Result<()>;
}

struct Cursor<'a> {
    source: &'a mut dyn Source,
    length: u64,
    position: u64,
    offset: u64,
    window: Vec<u8>,
}

impl<'a> Cursor<'a> {
    fn new(source: &'a mut dyn Source, length: u64) -> Self {
        Self { source, length, position: 0, offset: 0, window: Vec::new() }
    }
    fn skip(&mut self, length: u64) -> Result<()> {
        if length > self.length - self.position { return Err("Unexpected end of file".into()); }
        self.position += length;
        Ok(())
    }
    fn take(&mut self, length: u64) -> Result<Vec<u8>> {
        if length > self.length - self.position { return Err("Unexpected end of file".into()); }
        let mut out = Vec::new();
        while (out.len() as u64) < length {
            if self.position < self.offset || self.position >= self.offset + self.window.len() as u64 {
                self.offset = self.position;
                self.window.resize((self.length - self.position).min(65536) as usize, 0);
                self.source.read_at(self.offset, &mut self.window)?;
            }
            let start = (self.position - self.offset) as usize;
            let count = (length - out.len() as u64).min((self.window.len() - start) as u64) as usize;
            out.extend_from_slice(&self.window[start..start + count]);
            self.position += count as u64;
        }
        Ok(out)
    }
    fn uint(&mut self, width: usize) -> Result<u64> {
        let bytes = self.take(width as u64)?;
        Ok(bytes.iter().enumerate().fold(0, |v, (i, b)| v | ((*b as u64) << (8 * i))))
    }
    fn varint(&mut self) -> Result<u64> {
        let mut value = 0;
        for i in 0..10 {
            let byte = self.uint(1)?;
            if i == 9 && byte > 1 { return Err("Invalid protobuf varint".into()); }
            value |= (byte & 127) << (7 * i);
            if byte & 128 == 0 { return Ok(value); }
        }
        Err("Invalid protobuf varint".into())
    }
    fn string(&mut self) -> Result<String> {
        let size = self.uint(8)?;
        String::from_utf8(self.take(size)?).map_err(|_| "Invalid UTF-8".into())
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Message { Model, Graph, Node, Attribute, Tensor, Sparse, Training, Function }

#[repr(C)]
#[derive(Default, Debug)]
struct TensorRange { start: u64, length: u64, raw_start: u64, raw_length: u64 }

fn nested(parent: Message, field: u64) -> Option<Message> {
    use Message::*;
    match (parent, field) {
        (Model, 7) | (Training, 1 | 2) | (Attribute, 6 | 11) => Some(Graph),
        (Model, 20) => Some(Training), (Model, 25) => Some(Function),
        (Graph, 1) | (Function, 7) => Some(Node),
        (Node, 5) | (Function, 11) => Some(Attribute),
        (Graph, 5) | (Attribute, 5 | 10) | (Sparse, 1 | 2) => Some(Tensor),
        (Graph, 15) | (Attribute, 22 | 23) => Some(Sparse),
        _ => None,
    }
}

fn varint(mut value: u64, out: &mut Vec<u8>) {
    loop {
        out.push((value as u8 & 127) | if value > 127 { 128 } else { 0 });
        value >>= 7;
        if value == 0 { break; }
    }
}

fn protobuf(c: &mut Cursor, end: u64, kind: Message, depth: usize, ranges: &mut Vec<TensorRange>) -> Result<Vec<u8>> {
    if depth > 128 { return Err("Protobuf nesting exceeds 128 levels".into()); }
    let index = ranges.len();
    if kind == Message::Tensor {
        ranges.push(TensorRange { start: c.position, length: end - c.position, ..Default::default() });
    }
    let mut out = Vec::new();
    let mut typed = false;
    while c.position < end {
        let tag = c.varint()?;
        let field = tag >> 3;
        let wire = tag & 7;
        if field == 0 || field > 0x1fffffff { return Err("Invalid protobuf field".into()); }
        let bulk = kind == Message::Tensor && matches!(field, 4 | 5 | 6 | 7 | 9 | 10 | 11);
        if bulk && field != 9 { typed = true; }
        let value = match wire {
            0 => { let v = c.varint()?; let mut b = Vec::new(); varint(v, &mut b); b },
            1 => if bulk { c.skip(8)?; Vec::new() } else { c.take(8)? },
            5 => if bulk { c.skip(4)?; Vec::new() } else { c.take(4)? },
            2 => {
                let size = c.varint()?;
                if size > end.saturating_sub(c.position) { return Err("Protobuf field exceeds its message".into()); }
                if bulk {
                    if field == 9 {
                        ranges[index].raw_start = c.position;
                        ranges[index].raw_length = size;
                    }
                    c.skip(size)?;
                    Vec::new()
                } else {
                    let body = if let Some(child) = nested(kind, field) {
                        protobuf(c, c.position + size, child, depth + 1, ranges)?
                    } else { c.take(size)? };
                    let mut b = Vec::new();
                    varint(body.len() as u64, &mut b);
                    b.extend(body);
                    b
                }
            },
            _ => return Err("Unsupported protobuf wire type".into()),
        };
        if c.position > end { return Err("Protobuf field exceeds its message".into()); }
        if !bulk { varint(tag, &mut out); out.extend(value); }
    }
    if typed && kind == Message::Tensor { ranges[index].raw_start = 0; ranges[index].raw_length = 0; }
    Ok(out)
}

fn gguf_value(c: &mut Cursor, kind: u64, depth: usize) -> Result<Option<u64>> {
    if depth > 128 { return Err("GGUF nesting exceeds 128 levels".into()); }
    match kind {
        0 | 1 | 7 => Ok(Some(c.uint(1)?)),
        2 | 3 => Ok(Some(c.uint(2)?)),
        4 | 5 | 6 => Ok(Some(c.uint(4)?)),
        10 | 11 | 12 => Ok(Some(c.uint(8)?)),
        8 => { c.string()?; Ok(None) },
        9 => {
            let inner = c.uint(4)?;
            let count = c.uint(8)?;
            if count > c.length { return Err("Invalid GGUF array length".into()); }
            for _ in 0..count { gguf_value(c, inner, depth + 1)?; }
            Ok(None)
        },
        _ => Err("Unsupported GGUF metadata type".into()),
    }
}

fn gguf(c: &mut Cursor) -> Result<Vec<u8>> {
    if c.take(4)? != b"GGUF" { return Err("Invalid GGUF signature".into()); }
    if !matches!(c.uint(4)?, 2 | 3) { return Err("Unsupported GGUF version".into()); }
    let tensors = c.uint(8)?;
    let entries = c.uint(8)?;
    if tensors > c.length || entries > c.length { return Err("Invalid GGUF counts".into()); }
    let mut alignment = 32;
    for _ in 0..entries {
        let name = c.string()?;
        let kind = c.uint(4)?;
        let value = gguf_value(c, kind, 0)?;
        if name == "general.alignment" { alignment = value.ok_or("Invalid GGUF alignment")?; }
    }
    for _ in 0..tensors {
        c.string()?;
        let dims = c.uint(4)?;
        c.skip(dims.checked_mul(8).ok_or("Invalid GGUF dimensions")?)?;
        c.skip(12)?;
    }
    if alignment == 0 { return Err("Invalid GGUF alignment".into()); }
    let padding = (alignment - c.position % alignment) % alignment;
    // Metadata-only GGUF files need no payload padding.
    if tensors > 0 { c.skip(padding)?; }
    let length = c.position;
    c.position = 0;
    c.take(length)
}

struct Index { kind: u32, metadata: Vec<u8>, ranges: Vec<TensorRange>, error: String }

fn index(source: &mut dyn Source, length: u64, kind: u32) -> Index {
    let mut c = Cursor::new(source, length);
    let mut ranges = Vec::new();
    let result = match kind {
        1 => protobuf(&mut c, length, Message::Model, 0, &mut ranges),
        2 => gguf(&mut c),
        3 => (|| {
            let header = c.uint(8)?;
            c.skip(header)?;
            c.position = 0;
            c.take(header.checked_add(8).ok_or("Invalid Safetensors header")?)
        })(),
        _ => Err("Unsupported indexed format".into()),
    };
    match result {
        Ok(metadata) => Index { kind, metadata, ranges, error: String::new() },
        Err(error) => Index { kind: 0, metadata: Vec::new(), ranges: Vec::new(), error },
    }
}

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::*;
    #[link(wasm_import_module = "source")]
    extern "C" { fn read_at(offset: u64, ptr: *mut u8, length: u32) -> i32; }
    struct Host;
    impl Source for Host {
        fn read_at(&mut self, offset: u64, bytes: &mut [u8]) -> Result<()> {
            if unsafe { read_at(offset, bytes.as_mut_ptr(), bytes.len() as u32) } == bytes.len() as i32 { Ok(()) }
            else { Err("Unable to read source".into()) }
        }
    }
    #[no_mangle]
    pub extern "C" fn index_model(kind: u32, length: u64) -> *mut Index { Box::into_raw(Box::new(index(&mut Host, length, kind))) }
    #[no_mangle]
    pub unsafe extern "C" fn result_kind(p: *const Index) -> u32 { (*p).kind }
    #[no_mangle]
    pub unsafe extern "C" fn metadata_ptr(p: *const Index) -> *const u8 { (*p).metadata.as_ptr() }
    #[no_mangle]
    pub unsafe extern "C" fn metadata_len(p: *const Index) -> usize { (*p).metadata.len() }
    #[no_mangle]
    pub unsafe extern "C" fn ranges_ptr(p: *const Index) -> *const TensorRange { (*p).ranges.as_ptr() }
    #[no_mangle]
    pub unsafe extern "C" fn ranges_len(p: *const Index) -> usize { (*p).ranges.len() }
    #[no_mangle]
    pub unsafe extern "C" fn error_ptr(p: *const Index) -> *const u8 { (*p).error.as_ptr() }
    #[no_mangle]
    pub unsafe extern "C" fn error_len(p: *const Index) -> usize { let result = &*p; result.error.len() }
    #[no_mangle]
    pub unsafe extern "C" fn free_index(p: *mut Index) { drop(Box::from_raw(p)); }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Bytes { data: Vec<u8>, reads: usize }
    impl Source for Bytes {
        fn read_at(&mut self, offset: u64, out: &mut [u8]) -> Result<()> {
            self.reads += out.len();
            out.copy_from_slice(&self.data[offset as usize..offset as usize + out.len()]);
            Ok(())
        }
    }
    fn field(id: u64, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new(); varint(id * 8 + 2, &mut out); varint(body.len() as u64, &mut out); out.extend(body); out
    }
    #[test]
    fn onnx_skips_payload_and_preserves_tensor_metadata() {
        let mut tensor = vec![8, 2, 16, 1];
        tensor.extend(field(9, &vec![42; 4 * 1024 * 1024]));
        tensor.extend(field(8, b"weight"));
        let graph = field(5, &tensor);
        let mut source = Bytes { data: field(7, &graph), reads: 0 };
        let length = source.data.len() as u64;
        let result = index(&mut source, length, 1);
        assert_eq!(result.kind, 1, "{}", result.error);
        assert_eq!(result.metadata, field(7, &field(5, &[8, 2, 16, 1, 66, 6, b'w', b'e', b'i', b'g', b'h', b't'])));
        assert_eq!(result.ranges.len(), 1);
        assert_eq!(result.ranges[0].length, tensor.len() as u64);
        assert_eq!(result.ranges[0].raw_length, 4 * 1024 * 1024);
        assert!(source.reads < 131072);
    }
    #[test]
    fn nested_graphs_and_functions_keep_tensor_order() {
        let tensor = field(9, b"data");
        let attribute = field(6, &field(5, &tensor));
        let node = field(5, &attribute);
        let mut data = field(7, &field(1, &node));
        data.extend(field(25, &field(7, &node)));
        data.extend(field(20, &field(2, &field(15, &field(1, &tensor)))));
        let length = data.len() as u64;
        let result = index(&mut Bytes { data, reads: 0 }, length, 1);
        assert_eq!(result.kind, 1, "{}", result.error);
        assert_eq!(result.ranges.len(), 3);
        assert!(result.ranges.windows(2).all(|r| r[0].start < r[1].start));
    }
    #[test]
    fn malformed_protobuf_is_rejected() {
        for data in [vec![58, 127], vec![0], vec![58, 1, 8], vec![8; 11]] {
            let length = data.len() as u64;
            assert_eq!(index(&mut Bytes { data, reads: 0 }, length, 1).kind, 0);
        }
    }
    #[test]
    fn safetensors_reads_only_header() {
        let header = b"{\"weight\":{}}";
        let mut data = (header.len() as u64).to_le_bytes().to_vec(); data.extend(header); data.resize(1048576, 0);
        let mut source = Bytes { data, reads: 0 };
        let result = index(&mut source, 1048576, 3);
        assert_eq!(result.metadata.len(), header.len() + 8);
        assert_eq!(source.reads, 65536);
    }
    #[test]
    fn gguf_header_preserves_alignment() {
        let mut data = b"GGUF".to_vec(); data.extend(3u32.to_le_bytes()); data.extend(1u64.to_le_bytes()); data.extend(0u64.to_le_bytes());
        data.extend(1u64.to_le_bytes()); data.push(b'w'); data.extend(1u32.to_le_bytes()); data.extend(2u64.to_le_bytes()); data.extend(0u32.to_le_bytes()); data.extend(0u64.to_le_bytes()); data.resize(1048576, 0);
        let mut source = Bytes { data, reads: 0 };
        let result = index(&mut source, 1048576, 2);
        assert_eq!(result.metadata.len(), 64);
        assert_eq!(source.reads, 65536);
    }
}
