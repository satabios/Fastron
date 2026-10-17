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
    skipped_to: Option<u64>,
    capture: Option<Vec<u8>>,
}

impl<'a> Cursor<'a> {
    fn new(source: &'a mut dyn Source, length: u64) -> Self {
        Self { source, length, position: 0, offset: 0, window: Vec::new(), skipped_to: None, capture: None }
    }
    fn skip(&mut self, length: u64) -> Result<()> {
        if length > self.length - self.position { return Err("Unexpected end of file".into()); }
        if self.capture.is_some() { return self.read(length, None); }
        self.position += length;
        if length > 0 && self.position >= self.offset + self.window.len() as u64 { self.skipped_to = Some(self.position); }
        Ok(())
    }
    fn take(&mut self, length: u64) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        self.read(length, Some(&mut out))?;
        Ok(out)
    }
    fn read(&mut self, mut length: u64, mut out: Option<&mut Vec<u8>>) -> Result<()> {
        if length > self.length - self.position { return Err("Unexpected end of file".into()); }
        while length > 0 {
            if self.position < self.offset || self.position >= self.offset + self.window.len() as u64 {
                // Payload skips need a small probe; contiguous metadata keeps large sequential reads.
                let size = if self.skipped_to == Some(self.position) { 256 }
                    else if self.window.is_empty() { 65536 }
                    else { (self.window.len() * 2).min(65536) };
                self.skipped_to = None;
                self.offset = self.position;
                self.window.resize((self.length - self.position).min(size as u64) as usize, 0);
                self.source.read_at(self.offset, &mut self.window)?;
            }
            let start = (self.position - self.offset) as usize;
            let count = length.min((self.window.len() - start) as u64) as usize;
            let bytes = &self.window[start..start + count];
            if let Some(out) = &mut out { out.extend_from_slice(bytes); }
            if let Some(capture) = &mut self.capture { capture.extend_from_slice(bytes); }
            self.position += count as u64;
            length -= count as u64;
        }
        Ok(())
    }
    fn uint(&mut self, width: usize) -> Result<u64> {
        let end = self.offset + self.window.len() as u64;
        if self.position >= self.offset && self.position <= end && width as u64 <= end - self.position {
            // Most scalars fit the metadata window; avoid an allocation for every varint byte.
            let start = (self.position - self.offset) as usize;
            let bytes = &self.window[start..start + width];
            if let Some(capture) = &mut self.capture { capture.extend_from_slice(bytes); }
            self.position += width as u64;
            return Ok(bytes.iter().enumerate().fold(0, |v, (i, b)| v | ((*b as u64) << (8 * i))));
        }
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
    fn string(&mut self) -> Result<&str> {
        let size = self.uint(8)?;
        let start = self.position as usize;
        self.skip(size)?;
        std::str::from_utf8(&self.capture.as_ref().unwrap()[start..self.position as usize]).map_err(|_| "Invalid UTF-8".into())
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Message { Model, Graph, Node, Attribute, Tensor, Sparse, Training, Function }

#[repr(C)]
#[derive(Default, Debug)]
struct TensorRange { start: u64, length: u64, raw_start: u64, raw_length: u64 }

#[repr(C)]
#[derive(Default, Debug)]
struct PackedRange { start: u64, length: u64, field: u64 }

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

fn protobuf(c: &mut Cursor, end: u64, kind: Message, depth: usize, ranges: &mut Vec<TensorRange>, packed: &mut Vec<PackedRange>) -> Result<Vec<u8>> {
    if depth > 128 { return Err("Protobuf nesting exceeds 128 levels".into()); }
    let index = ranges.len();
    if kind == Message::Tensor {
        ranges.push(TensorRange { start: c.position, length: end - c.position, ..Default::default() });
        packed.push(PackedRange::default());
    }
    let mut out = Vec::new();
    let mut typed = false;
    let mut storage_fields = 0u8;
    let mut segmented = false;
    while c.position < end {
        let tag = c.varint()?;
        let field = tag >> 3;
        let wire = tag & 7;
        if field == 0 || field > 0x1fffffff { return Err("Invalid protobuf field".into()); }
        let bulk = kind == Message::Tensor && matches!(field, 4 | 5 | 6 | 7 | 9 | 10 | 11);
        if bulk { storage_fields = storage_fields.saturating_add(1); }
        if kind == Message::Tensor && field == 3 { segmented = true; }
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
                    if size > 0 && ((field == 4 && size % 4 == 0) || (field == 10 && size % 8 == 0)) {
                        packed[index] = PackedRange { start: c.position, length: size, field };
                    }
                    c.skip(size)?;
                    Vec::new()
                } else {
                    let body = if let Some(child) = nested(kind, field) {
                        protobuf(c, c.position + size, child, depth + 1, ranges, packed)?
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
    if kind == Message::Tensor && (storage_fields != 1 || segmented) { packed[index] = PackedRange::default(); }
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
    c.capture = Some(Vec::new());
    if c.take(4)? != b"GGUF" { return Err("Invalid GGUF signature".into()); }
    if !matches!(c.uint(4)?, 2 | 3) { return Err("Unsupported GGUF version".into()); }
    let tensors = c.uint(8)?;
    let entries = c.uint(8)?;
    if tensors > c.length || entries > c.length { return Err("Invalid GGUF counts".into()); }
    let mut alignment = 32;
    for _ in 0..entries {
        let is_alignment = c.string()? == "general.alignment";
        let kind = c.uint(4)?;
        let value = gguf_value(c, kind, 0)?;
        if is_alignment { alignment = value.ok_or("Invalid GGUF alignment")?; }
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
    Ok(c.capture.take().unwrap())
}

struct Index { kind: u32, metadata: Vec<u8>, ranges: Vec<TensorRange>, packed: Vec<PackedRange>, error: String }

fn index(source: &mut dyn Source, length: u64, kind: u32) -> Index {
    let mut c = Cursor::new(source, length);
    let mut ranges = Vec::new();
    let mut packed = Vec::new();
    let result = match kind {
        1 => protobuf(&mut c, length, Message::Model, 0, &mut ranges, &mut packed),
        2 => gguf(&mut c),
        3 => (|| {
            c.capture = Some(Vec::new());
            let header = c.uint(8)?;
            c.skip(header)?;
            Ok(c.capture.take().unwrap())
        })(),
        _ => Err("Unsupported indexed format".into()),
    };
    match result {
        Ok(metadata) => Index { kind, metadata, ranges, packed, error: String::new() },
        Err(error) => Index { kind: 0, metadata: Vec::new(), ranges: Vec::new(), packed: Vec::new(), error },
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
    pub unsafe extern "C" fn packed_ranges_ptr(p: *const Index) -> *const PackedRange { (*p).packed.as_ptr() }
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
    struct Bytes { data: Vec<u8>, reads: usize, requests: Vec<(u64, usize)> }
    impl Bytes {
        fn new(data: Vec<u8>) -> Self { Self { data, reads: 0, requests: Vec::new() } }
    }
    impl Source for Bytes {
        fn read_at(&mut self, offset: u64, out: &mut [u8]) -> Result<()> {
            self.reads += out.len();
            self.requests.push((offset, out.len()));
            out.copy_from_slice(&self.data[offset as usize..offset as usize + out.len()]);
            Ok(())
        }
    }
    fn field(id: u64, body: &[u8]) -> Vec<u8> {
        let mut out = Vec::new(); varint(id * 8 + 2, &mut out); varint(body.len() as u64, &mut out); out.extend(body); out
    }
    #[test]
    fn scalar_reads_preserve_capture_across_window_boundaries_and_eof() {
        let data: Vec<u8> = (0..65540).map(|i| (i % 251) as u8).collect();
        let mut source = Bytes::new(data.clone());
        let mut reference = Bytes::new(data.clone());
        let mut cursor = Cursor::new(&mut source, data.len() as u64);
        let mut slow = Cursor::new(&mut reference, data.len() as u64);
        cursor.capture = Some(Vec::new());
        slow.capture = Some(Vec::new());
        for width in [1, 2, 4, 8] {
            let bytes = slow.take(width).unwrap();
            let expected = bytes.iter().enumerate().fold(0, |v, (i, b)| v | ((*b as u64) << (8 * i)));
            assert_eq!(cursor.uint(width as usize).unwrap(), expected);
        }
        let skip = 65532 - cursor.position;
        cursor.skip(skip).unwrap(); slow.skip(skip).unwrap();
        assert_eq!(cursor.uint(8).unwrap(), u64::from_le_bytes(slow.take(8).unwrap().try_into().unwrap()));
        assert_eq!(cursor.capture, slow.capture);
        assert_eq!(cursor.capture.as_ref().unwrap(), &data);
        assert!(cursor.uint(1).is_err());
        assert_eq!(cursor.position, data.len() as u64);
        assert_eq!(source.requests, reference.requests);
    }
    #[test]
    fn scalar_reads_after_payload_skips_refill_the_metadata_window() {
        let data: Vec<u8> = (0..200000).map(|i| (i % 251) as u8).collect();
        let mut source = Bytes::new(data.clone());
        let mut cursor = Cursor::new(&mut source, data.len() as u64);
        assert_eq!(cursor.uint(4).unwrap(), u32::from_le_bytes(data[..4].try_into().unwrap()) as u64);
        cursor.skip(99999).unwrap();
        assert_eq!(cursor.uint(4).unwrap(), u32::from_le_bytes(data[100003..100007].try_into().unwrap()) as u64);
        assert_eq!(cursor.position, 100007);
        assert_eq!(source.requests, vec![(0, 65536), (100003, 256)]);
    }
    #[test]
    fn onnx_skips_payload_and_preserves_tensor_metadata() {
        let mut tensor = vec![8, 2, 16, 1];
        tensor.extend(field(9, &vec![42; 4 * 1024 * 1024]));
        tensor.extend(field(8, b"weight"));
        let graph = field(5, &tensor);
        let mut source = Bytes::new(field(7, &graph));
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
        let result = index(&mut Bytes::new(data), length, 1);
        assert_eq!(result.kind, 1, "{}", result.error);
        assert_eq!(result.ranges.len(), 3);
        assert_eq!(result.packed.len(), 3);
        assert!(result.ranges.windows(2).all(|r| r[0].start < r[1].start));
    }
    #[test]
    fn malformed_protobuf_is_rejected() {
        for data in [vec![58, 127], vec![0], vec![58, 1, 8], vec![8; 11]] {
            let length = data.len() as u64;
            assert_eq!(index(&mut Bytes::new(data), length, 1).kind, 0);
        }
    }
    #[test]
    fn safetensors_reads_only_header() {
        let header = b"{\"weight\":{}}";
        let mut data = (header.len() as u64).to_le_bytes().to_vec(); data.extend(header); data.resize(1048576, 0);
        let mut source = Bytes::new(data);
        let result = index(&mut source, 1048576, 3);
        assert_eq!(result.metadata.len(), header.len() + 8);
        assert_eq!(source.reads, 65536);
    }
    #[test]
    fn gguf_header_preserves_alignment() {
        let mut data = b"GGUF".to_vec(); data.extend(3u32.to_le_bytes()); data.extend(1u64.to_le_bytes()); data.extend(0u64.to_le_bytes());
        data.extend(1u64.to_le_bytes()); data.push(b'w'); data.extend(1u32.to_le_bytes()); data.extend(2u64.to_le_bytes()); data.extend(0u32.to_le_bytes()); data.extend(0u64.to_le_bytes()); data.resize(1048576, 0);
        let mut source = Bytes::new(data);
        let result = index(&mut source, 1048576, 2);
        assert_eq!(result.metadata.len(), 64);
        assert_eq!(source.reads, 65536);
    }
    #[test]
    fn scattered_onnx_payloads_use_small_read_windows() {
        let payload = vec![42; 128 * 1024];
        let mut graph = Vec::new();
        let mut metadata = Vec::new();
        for i in 0..128 {
            let mut tensor = vec![8, 2, 16, 1];
            let name = field(8, format!("weight.{i}").as_bytes());
            tensor.extend(field(9, &payload));
            tensor.extend(&name);
            graph.extend(field(5, &tensor));
            let mut compact = vec![8, 2, 16, 1];
            compact.extend(name);
            metadata.extend(field(5, &compact));
        }
        let mut source = Bytes::new(field(7, &graph));
        let length = source.data.len() as u64;
        let result = index(&mut source, length, 1);
        assert_eq!(result.kind, 1, "{}", result.error);
        assert_eq!(result.metadata, field(7, &metadata));
        assert_eq!(result.ranges.len(), 128);
        for range in result.ranges {
            assert_eq!(range.raw_length, payload.len() as u64);
            assert_eq!(&source.data[range.raw_start as usize..(range.raw_start + range.raw_length) as usize], payload);
        }
        assert_eq!(source.requests.len(), 129);
        assert!(source.reads <= 65536 + 128 * 256);
    }
    #[test]
    fn contiguous_onnx_metadata_keeps_large_sequential_reads() {
        let mut source = Bytes::new(field(2, &vec![b'a'; 2 * 1024 * 1024]));
        let length = source.data.len() as u64;
        let result = index(&mut source, length, 1);
        assert_eq!(result.kind, 1, "{}", result.error);
        assert_eq!(result.metadata, source.data);
        assert_eq!(source.requests.len(), (length as usize).div_ceil(65536));
        assert_eq!(source.reads as u64, length);
    }
    #[test]
    fn read_windows_grow_after_a_payload_followed_by_large_metadata() {
        let name = vec![b'a'; 512 * 1024];
        let mut tensor = field(9, &vec![42; 128 * 1024]);
        tensor.extend(field(8, &name));
        let mut source = Bytes::new(field(7, &field(5, &tensor)));
        let length = source.data.len() as u64;
        let result = index(&mut source, length, 1);
        assert_eq!(result.kind, 1, "{}", result.error);
        assert_eq!(result.metadata, field(7, &field(5, &field(8, &name))));
        assert!(source.requests.len() <= 18);
    }
    fn gguf_prefix(tensors: u64, entries: u64) -> Vec<u8> {
        let mut data = b"GGUF".to_vec();
        data.extend(3u32.to_le_bytes()); data.extend(tensors.to_le_bytes()); data.extend(entries.to_le_bytes());
        data
    }
    fn gguf_string(value: &[u8]) -> Vec<u8> {
        let mut data = (value.len() as u64).to_le_bytes().to_vec(); data.extend(value); data
    }
    #[test]
    fn large_gguf_header_is_retained_without_rereading() {
        let mut data = gguf_prefix(1, 2);
        data.extend(gguf_string(b"general.alignment")); data.extend(4u32.to_le_bytes()); data.extend(64u32.to_le_bytes());
        data.extend(gguf_string(b"tokenizer.ggml.tokens")); data.extend(9u32.to_le_bytes());
        data.extend(8u32.to_le_bytes()); data.extend(128u64.to_le_bytes());
        for _ in 0..128 { data.extend(gguf_string("☃".repeat(6250).as_bytes())); }
        data.extend(gguf_string(b"w")); data.extend(1u32.to_le_bytes()); data.extend(2u64.to_le_bytes()); data.extend([0; 12]);
        let header_length = data.len().div_ceil(64) * 64;
        data.resize(header_length, 0);
        data.resize(header_length + 1048576, 42);
        let mut source = Bytes::new(data);
        let length = source.data.len() as u64;
        let result = index(&mut source, length, 2);
        assert_eq!(result.kind, 2, "{}", result.error);
        assert_eq!(result.metadata, source.data[..header_length]);
        assert_eq!(source.requests.len(), header_length.div_ceil(65536));
        assert_eq!(source.reads, header_length.div_ceil(65536) * 65536);
        assert!(source.requests.windows(2).all(|r| r[0].0 + r[0].1 as u64 == r[1].0));
    }
    #[test]
    fn malformed_and_truncated_gguf_headers_are_rejected() {
        let mut string = gguf_prefix(0, 1);
        string.extend(gguf_string(b"key")); string.extend(8u32.to_le_bytes()); string.extend(gguf_string(b"value"));
        for end in 0..string.len() {
            let mut source = Bytes::new(string[..end].to_vec());
            assert_eq!(index(&mut source, end as u64, 2).kind, 0, "Accepted {end}-byte truncated header");
        }
        for kind in [8u32, 9, 100] {
            let mut data = gguf_prefix(0, 1);
            data.extend(gguf_string(b"key")); data.extend(kind.to_le_bytes());
            if kind == 8 { data.extend(gguf_string(&[0xff])); }
            if kind == 9 { data.extend(8u32.to_le_bytes()); data.extend(u64::MAX.to_le_bytes()); }
            let length = data.len() as u64;
            assert_eq!(index(&mut Bytes::new(data), length, 2).kind, 0);
        }
        let mut alignment = gguf_prefix(1, 1);
        alignment.extend(gguf_string(b"general.alignment")); alignment.extend(4u32.to_le_bytes()); alignment.extend(0u32.to_le_bytes());
        alignment.extend(gguf_string(b"w")); alignment.extend(0u32.to_le_bytes()); alignment.extend([0; 12]);
        let length = alignment.len() as u64;
        assert_eq!(index(&mut Bytes::new(alignment), length, 2).kind, 0);
        let mut unpadded = gguf_prefix(1, 0);
        unpadded.extend(gguf_string(b"w")); unpadded.extend(0u32.to_le_bytes()); unpadded.extend([0; 12]);
        let length = unpadded.len() as u64;
        assert_eq!(index(&mut Bytes::new(unpadded), length, 2).kind, 0);
    }
    #[test]
    fn metadata_only_gguf_does_not_require_payload_padding() {
        let mut source = Bytes::new(gguf_prefix(0, 0));
        let result = index(&mut source, 24, 2);
        assert_eq!(result.kind, 2, "{}", result.error);
        assert_eq!(result.metadata, source.data);
    }
    #[test]
    fn large_safetensors_header_is_read_once_and_truncation_is_rejected() {
        let header = vec![b'a'; 2 * 1024 * 1024];
        let mut data = (header.len() as u64).to_le_bytes().to_vec(); data.extend(&header);
        let header_length = data.len();
        data.resize(header_length + 1048576, 0);
        let mut source = Bytes::new(data);
        let length = source.data.len() as u64;
        let result = index(&mut source, length, 3);
        assert_eq!(result.kind, 3, "{}", result.error);
        assert_eq!(result.metadata, source.data[..header_length]);
        assert_eq!(source.requests.len(), header_length.div_ceil(65536));
        for length in [0, 7, header_length - 1] {
            let mut source = Bytes::new(source.data[..length].to_vec());
            assert_eq!(index(&mut source, length as u64, 3).kind, 0);
        }
    }
    #[test]
    fn packed_float_ranges_are_separate_from_original_raw_range_abi() {
        assert_eq!(std::mem::size_of::<TensorRange>(), 32);
        assert_eq!(std::mem::size_of::<PackedRange>(), 24);
        for (storage, dtype, payload) in [(4, 1, vec![0u8; 8]), (10, 11, vec![0u8; 16])] {
            let mut tensor = vec![8, 2, 16, dtype];
            tensor.extend(field(storage, &payload));
            let mut source = Bytes::new(field(7, &field(5, &tensor)));
            let length = source.data.len() as u64;
            let result = index(&mut source, length, 1);
            assert_eq!(result.kind, 1, "{}", result.error);
            assert_eq!(result.metadata, field(7, &field(5, &[8, 2, 16, dtype])));
            assert_eq!(result.ranges[0].length, tensor.len() as u64);
            assert_eq!(result.ranges[0].raw_start, 0);
            assert_eq!(result.ranges[0].raw_length, 0);
            assert_eq!(result.packed[0].field, storage);
            assert_eq!(result.packed[0].length, payload.len() as u64);
            let start = result.packed[0].start as usize;
            assert_eq!(&source.data[start..start + payload.len()], payload);
        }
    }
    #[test]
    fn unsupported_typed_storage_has_no_packed_preview_range() {
        let floats = field(4, &[0; 8]);
        let mut unpacked = vec![4 * 8 + 5]; unpacked.extend([0; 4]);
        let mut repeated = floats.clone(); repeated.extend(&floats);
        let mut mixed = field(9, &[0; 8]); mixed.extend(&floats);
        let mut segmented = field(3, &[8, 0, 16, 2]); segmented.extend(&floats);
        for storage in [field(5, &[1, 2]), field(6, b"value"), unpacked, repeated, mixed, segmented, field(4, &[0; 3]), field(4, &[])] {
            let mut tensor = vec![8, 2, 16, 1]; tensor.extend(storage);
            let mut source = Bytes::new(field(7, &field(5, &tensor)));
            let length = source.data.len() as u64;
            let result = index(&mut source, length, 1);
            assert_eq!(result.kind, 1, "{}", result.error);
            assert_eq!(result.packed[0].field, 0);
        }
    }
}
