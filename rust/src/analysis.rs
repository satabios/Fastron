//! Metadata-only graph analysis. All identities in results are graph-local indices.
use std::collections::{HashMap, HashSet, VecDeque};
use std::fmt::Write;
use crate::pattern::Patterns;

const NONE: u32 = u32::MAX;
const LIMIT: usize = 0x1000_0000;
type Result<T> = std::result::Result<T, String>;

struct Reader<'a> { bytes: &'a [u8], at: usize }
impl<'a> Reader<'a> {
    fn uint(&mut self) -> Result<u32> {
        let data = self.bytes.get(self.at..self.at + 4).ok_or("Truncated analysis input")?;
        self.at += 4;
        Ok(u32::from_le_bytes(data.try_into().unwrap()))
    }
    fn count(&mut self, width: usize) -> Result<usize> {
        let count = self.uint()? as usize;
        if count > 10_000_000 || count > self.bytes.len().saturating_sub(self.at) / width { return Err("Invalid analysis table length".into()); }
        Ok(count)
    }
    fn bytes(&mut self) -> Result<Vec<u8>> {
        let count = self.count(1)?;
        let data = self.bytes[self.at..self.at + count].to_vec(); self.at += count; Ok(data)
    }
    fn indices(&mut self) -> Result<Vec<u32>> {
        let count = self.count(4)?;
        (0..count).map(|_| self.uint()).collect()
    }
    fn string(&mut self, strings: &[u32]) -> Result<u32> {
        strings.get(self.uint()? as usize).copied().ok_or("Invalid string index".into())
    }
    fn ports(&mut self, strings: &[u32]) -> Result<Vec<Port>> {
        let count = self.count(16)?;
        (0..count).map(|_| Ok(Port { name: self.string(strings)?, kind: self.string(strings)?, meta: self.uint()?, values: self.indices()? })).collect()
    }
}

#[derive(Clone, Default)]
struct Value { tag: u32, kind: u32, identity: u32, atom: Vec<u8>, props: Vec<(u32, u32)> }
#[derive(Clone, Default)]
struct Tensor { name: u32, meta: u32, dtype: u32, initializer: bool, dims: Option<Vec<u32>> }
#[derive(Clone, Default)]
struct Port { name: u32, kind: u32, meta: u32, values: Vec<u32> }
#[derive(Clone, Default)]
struct Node {
    name: u32, group: u32, scope: u32, kind: u32, meta: u32,
    attrs: Vec<(u32, u32, u32)>, inputs: Vec<Port>, outputs: Vec<Port>, controls: Vec<u32>, bodies: Vec<(u32, u32)>,
}
#[derive(Clone, Default)]
struct Group {
    id: String, label: String, parent: usize, children: Vec<i32>, members: Vec<u32>, active: bool,
    inputs: Vec<u32>, outputs: Vec<u32>, controls: Vec<u32>,
}
#[derive(Default)]
struct Graph {
    values: Vec<Value>, tensors: Vec<Tensor>, nodes: Vec<Node>, inputs: Vec<Port>, outputs: Vec<Port>, interface: u32,
    producers: HashMap<u32, (u32, u32, u32)>, predecessors: Vec<Vec<u32>>, successors: Vec<Vec<u32>>,
    labels: Vec<u32>, next_labels: Vec<u32>, groups: Vec<Group>, scopes: HashMap<String, usize>, parents: Vec<usize>,
    stage: usize, cursor: usize, boundary_group: usize, boundary_member: usize, duplicate: bool,
    pattern: Option<Patterns>, candidates: Vec<(usize, usize)>, candidate: usize, offset: usize, create: usize,
}

fn equal(a: &Graph, ia: u32, b: &Graph, ib: u32) -> bool {
    let mut pending = vec![(ia, ib)];
    let mut seen = HashSet::new();
    while let Some((ia, ib)) = pending.pop() {
        if !seen.insert((ia, ib)) { continue; }
        let aa = &a.values[ia as usize]; let bb = &b.values[ib as usize];
        if aa.identity != 0 && aa.identity == bb.identity { continue; }
        if aa.tag == 11 && aa.identity != bb.identity { return false; }
        if aa.tag != bb.tag || aa.kind != bb.kind || aa.atom != bb.atom || aa.props.len() != bb.props.len() { return false; }
        if aa.tag == 7 && aa.atom.len() == 8 && f64::from_le_bytes(aa.atom[..].try_into().unwrap()).is_nan() { return false; }
        if aa.tag == 9 || aa.tag == 10 {
            for &(key, value) in &aa.props {
                let Some(&(_, other)) = bb.props.iter().find(|&&(other, _)| key_equal(a, key, b, other)) else { return false; };
                if aa.tag == 9 { pending.push((value, other)); }
            }
        } else {
            for (&(key, value), &(other_key, other)) in aa.props.iter().zip(&bb.props) {
                if key != other_key { return false; }
                pending.push((value, other));
            }
        }
    }
    true
}

fn key_equal(a: &Graph, ia: u32, b: &Graph, ib: u32) -> bool {
    let aa = &a.values[ia as usize]; let bb = &b.values[ib as usize];
    if aa.tag >= 6 { return aa.identity == bb.identity; }
    if aa.tag == 3 && bb.tag == 3 {
        let x = f64::from_le_bytes(aa.atom[..].try_into().unwrap());
        let y = f64::from_le_bytes(bb.atom[..].try_into().unwrap());
        return x == y || (x.is_nan() && y.is_nan());
    }
    aa.tag == bb.tag && aa.atom == bb.atom
}

fn hash(text: &[u8]) -> u32 { text.iter().fold(5381u32, |value, byte| value.wrapping_mul(33).wrapping_add(*byte as u32) & 0x7fff_ffff) }
fn label_hash(kind: u32, pred: &[u32], succ: &[u32]) -> u32 {
    let mut out = kind.wrapping_mul(16777619);
    for value in pred { out = out.wrapping_mul(16777619).wrapping_add(*value); }
    out = out.wrapping_mul(16777619).wrapping_add(NONE);
    for value in succ { out = out.wrapping_mul(16777619).wrapping_add(*value); }
    out
}

impl Graph {
    fn pattern_equal(&self, start: usize, period: usize, offset: usize) -> bool {
        let block = start + (offset / period) * period;
        let ai = start + offset % period; let bi = start + offset;
        let a = &self.nodes[ai]; let b = &self.nodes[bi];
        if a.kind != b.kind || !equal(self, a.meta, self, b.meta) || a.attrs.len() != b.attrs.len() ||
            !a.attrs.iter().zip(&b.attrs).all(|(x, y)| x.0 == y.0 && x.1 == y.1 && equal(self, x.2, self, y.2)) ||
            !pattern_ports_equal(self, &a.inputs, &b.inputs) || !pattern_ports_equal(self, &a.outputs, &b.outputs) || a.controls.len() != b.controls.len() { return false; }
        let internal = |value: u32, base: usize| {
            self.producers.get(&self.tensors[value as usize].name).and_then(|&(index, port, slot)|
                if index as usize >= base && (index as usize) < base + period { Some((index as usize - base, port, slot)) } else { None })
        };
        a.inputs.iter().flat_map(|p| &p.values).chain(&a.controls).zip(b.inputs.iter().flat_map(|p| &p.values).chain(&b.controls))
            .all(|(x, y)| internal(*x, start) == internal(*y, block))
    }

    fn pattern_step(&mut self) {
        if self.nodes.len() < 4 || self.duplicate || (self.pattern.is_none() && self.groups.len() > 1) { self.cursor = self.nodes.len(); return; }
        if self.pattern.is_none() {
            let mut pattern = Patterns::new(self.nodes.len());
            for (index, node) in self.nodes.iter().enumerate() { pattern.input[index * 2] = node.kind; pattern.input[index * 2 + 1] = 3; }
            pattern.prepare(); self.pattern = Some(pattern);
        }
        if self.candidates.is_empty() {
            let pattern = self.pattern.as_mut().unwrap(); pattern.scan(self.cursor);
            self.candidates = pattern.output.chunks_exact(2).filter(|v| v[0] > 1).map(|v| (v[0] as usize, v[1] as usize)).collect();
            self.candidate = 0;
            if self.candidates.is_empty() { self.cursor += 1; return; }
            self.offset = self.candidates[0].0;
        }
        let (period, repeats) = self.candidates[self.candidate];
        if self.offset < period * repeats {
            if self.pattern_equal(self.cursor, period, self.offset) { self.offset += 1; }
            else {
                self.candidate += 1;
                if self.candidate >= self.candidates.len() { self.candidates.clear(); self.cursor += 1; }
                else { self.offset = self.candidates[self.candidate].0; }
            }
        } else {
            let start = self.cursor + self.create * period;
            let id = self.groups.len();
            let members: Vec<_> = (start as u32..(start + period) as u32).collect();
            for &node in &members { self.parents[node as usize] = id; self.groups[0].children[node as usize] = 0; }
            self.groups[0].children[start] = id as i32;
            self.groups.push(Group { id: format!("/@{start}"), label: format!("Repeated pattern {}", self.create), parent: 0, active: true,
                children: members.iter().map(|v| -(*v as i32) - 1).collect(), members, ..Group::default() });
            self.create += 1;
            if self.create == repeats { self.cursor += period * repeats; self.candidates.clear(); self.create = 0; }
        }
    }
    fn decode(bytes: &[u8], strings: &mut Vec<String>, pool: &mut HashMap<String, u32>) -> Result<(u32, Self)> {
        if bytes.len() > LIMIT { return Err("Analysis input exceeds limit".into()); }
        let mut read = Reader { bytes, at: 0 };
        if read.uint()? != 0x32414746 { return Err("Invalid analysis input version".into()); }
        let id = read.uint()?;
        if id > 100_000 { return Err("Invalid graph id".into()); }
        let count = read.count(4)?;
        let mut local = Vec::with_capacity(count);
        for _ in 0..count {
            let text = String::from_utf8(read.bytes()?).map_err(|_| "Invalid UTF-8")?;
            let global = *pool.entry(text.clone()).or_insert_with(|| { let id = strings.len() as u32; strings.push(text); id });
            local.push(global);
        }
        let count = read.count(20)?;
        let mut arena = Vec::with_capacity(count);
        for _ in 0..count {
            let tag = read.uint()?; let kind = read.string(&local)?; let identity = read.uint()?; let atom = read.bytes()?;
            if tag > 11 || ((tag == 3 || tag == 7) && atom.len() != 8) || (tag == 2 && atom.len() != 1) { return Err("Invalid metadata value".into()); }
            let count = read.count(8)?;
            let mut props = Vec::with_capacity(count);
            for _ in 0..count {
                let key = if tag == 9 || tag == 10 { read.uint()? } else { read.string(&local)? };
                props.push((key, read.uint()?));
            }
            // Keys use interned IDs; order must be independent of each graph's insertion order.
            if tag == 8 { props.sort_unstable_by_key(|item| item.0); }
            arena.push(Value { tag, kind, identity, atom, props });
        }
        for value in &arena {
            for &(key, value_id) in &value.props {
                if (value.tag == 9 || value.tag == 10) && key as usize >= arena.len() { return Err("Invalid metadata key".into()); }
                if value.tag != 10 && value_id as usize >= arena.len() { return Err("Invalid metadata reference".into()); }
            }
        }
        let count = read.count(20)?;
        let mut tensors = Vec::with_capacity(count);
        for _ in 0..count {
            let name = read.string(&local)?; let meta = read.uint()?; let dtype = read.string(&local)?; let initializer = read.uint()? != 0;
            let count = read.uint()?;
            let dims = if count == NONE { None } else {
                if count as usize > bytes.len().saturating_sub(read.at) / 4 { return Err("Invalid dimension count".into()); }
                Some((0..count).map(|_| read.uint()).collect::<Result<Vec<_>>>()?)
            };
            if meta as usize >= arena.len() || dims.as_ref().is_some_and(|dims| dims.iter().any(|v| *v as usize >= arena.len())) { return Err("Invalid tensor metadata".into()); }
            tensors.push(Tensor { name, meta, dtype, initializer, dims });
        }
        let count = read.count(40)?;
        let mut nodes = Vec::with_capacity(count);
        for _ in 0..count {
            let name = read.string(&local)?; let group = read.string(&local)?; let scope = read.string(&local)?;
            let kind = read.string(&local)?; let meta = read.uint()?;
            let count = read.count(12)?;
            let mut attrs = (0..count).map(|_| Ok((read.string(&local)?, read.string(&local)?, read.uint()?))).collect::<Result<Vec<_>>>()?;
            attrs.sort_by_key(|item| item.0);
            let inputs = read.ports(&local)?; let outputs = read.ports(&local)?; let controls = read.indices()?;
            let count = read.count(8)?;
            let bodies = (0..count).map(|_| Ok((read.string(&local)?, read.uint()?))).collect::<Result<Vec<_>>>()?;
            if meta as usize >= arena.len() || attrs.iter().any(|v| v.2 as usize >= arena.len()) { return Err("Invalid node metadata".into()); }
            if strings[scope as usize].split('/').count() > 1024 { return Err("Graph scope exceeds 1024 levels".into()); }
            nodes.push(Node { name, group, scope, kind, meta, attrs, inputs, outputs, controls, bodies });
        }
        let inputs = read.ports(&local)?; let outputs = read.ports(&local)?; let interface = read.uint()?;
        if interface as usize >= arena.len() || read.at != bytes.len() { return Err("Invalid graph metadata".into()); }
        for port in inputs.iter().chain(&outputs).chain(nodes.iter().flat_map(|node| node.inputs.iter().chain(&node.outputs))) {
            if port.meta as usize >= arena.len() || port.values.iter().any(|index| *index as usize >= tensors.len()) { return Err("Invalid tensor index".into()); }
        }
        if nodes.iter().any(|node| node.controls.iter().any(|index| *index as usize >= tensors.len())) { return Err("Invalid control edge".into()); }
        let n = nodes.len();
        Ok((id, Self { values: arena, tensors, nodes, inputs, outputs, interface, predecessors: vec![Vec::new(); n], successors: vec![Vec::new(); n],
            labels: vec![0; n], next_labels: vec![0; n], parents: vec![0; n], groups: vec![Group { active: true, ..Group::default() }], ..Self::default() }))
    }

    // One node (or one group member) per preparation step; the host yields between batches.
    fn prepare_step(&mut self, strings: &[String]) -> bool {
        if self.stage >= 8 { return true; }
        if self.cursor >= self.nodes.len() && self.stage < 6 {
            if self.stage == 5 { self.groups[0].children.retain(|v| *v != 0); self.pattern = None; }
            self.stage += 1; self.cursor = 0; return false;
        }
        let i = self.cursor;
        match self.stage {
            0 => {
                for (port, arg) in self.nodes[i].outputs.iter().enumerate() {
                    for (slot, &value) in arg.values.iter().enumerate() {
                        let name = self.tensors[value as usize].name;
                        if name != 0 && self.producers.insert(name, (i as u32, port as u32, slot as u32)).is_some() { self.duplicate = true; }
                    }
                }
                // WL starts with the operator spelling, matching the existing two-round refinement.
                let spelling = strings[self.nodes[i].kind as usize].split('\0').nth(1).unwrap_or("");
                self.labels[i] = hash(spelling.as_bytes());
            }
            1 => {
                for value in self.nodes[i].inputs.iter().flat_map(|arg| arg.values.iter()).chain(&self.nodes[i].controls) {
                    if let Some(&(from, _, _)) = self.producers.get(&self.tensors[*value as usize].name) {
                        if from as usize != i { self.predecessors[i].push(from); self.successors[from as usize].push(i as u32); }
                    }
                }
            }
            2 | 3 => {
                let mut pred: Vec<_> = self.predecessors[i].iter().map(|v| self.labels[*v as usize]).collect(); pred.sort_unstable();
                let mut succ: Vec<_> = self.successors[i].iter().map(|v| self.labels[*v as usize]).collect(); succ.sort_unstable();
                self.next_labels[i] = label_hash(self.labels[i], &pred, &succ);
                if i + 1 == self.nodes.len() { std::mem::swap(&mut self.labels, &mut self.next_labels); }
            }
            4 => {
                let scope = &strings[self.nodes[i].scope as usize];
                let mut parent = 0; let mut path = String::new();
                for label in scope.split('/').filter(|label| !label.is_empty()).take(1024) {
                    path.push('/'); path.push_str(label);
                    let group = if let Some(&id) = self.scopes.get(&path) { id } else {
                        let id = self.groups.len();
                        self.groups.push(Group { id: path.clone(), label: label.into(), parent, active: true, ..Group::default() });
                        self.groups[parent].children.push(id as i32); self.scopes.insert(path.clone(), id); id
                    };
                    self.groups[group].members.push(i as u32); parent = group;
                }
                self.parents[i] = parent; self.groups[parent].children.push(-(i as i32) - 1);
            }
            5 => { self.pattern_step(); return false; }
            6 => {
                // Remove single-child scope wrappers without changing original operator order.
                if self.cursor == 0 { self.cursor = self.groups.len(); }
                if self.cursor > 1 {
                    self.cursor -= 1;
                    let group = self.cursor;
                    let children = self.groups[group].children.clone();
                    if children.len() == 1 {
                        let parent = self.groups[group].parent;
                        if let Some(at) = self.groups[parent].children.iter().position(|value| *value == group as i32) {
                            self.groups[parent].children[at] = children[0];
                            if children[0] > 0 { self.groups[children[0] as usize].parent = parent; }
                            else { self.parents[(-children[0] - 1) as usize] = parent; }
                        }
                        self.groups[group].active = false;
                    }
                    return false;
                }
                self.stage = 7; self.cursor = 0; self.boundary_group = 1; return false;
            }
            7 => {
                if self.boundary_group >= self.groups.len() { self.stage = 8; return true; }
                let group = self.boundary_group;
                if !self.groups[group].active || self.boundary_member >= self.groups[group].members.len() {
                    // Stable tensor order, with aliases bundled by tensor name.
                    for kind in 0..3 {
                        let list = match kind { 0 => &mut self.groups[group].inputs, 1 => &mut self.groups[group].outputs, _ => &mut self.groups[group].controls };
                        let mut names = HashSet::new(); list.retain(|v| names.insert(self.tensors[*v as usize].name));
                    }
                    self.boundary_group += 1; self.boundary_member = 0; return false;
                }
                let index = self.groups[group].members[self.boundary_member] as usize;
                let member = |index: u32| self.groups[group].members.binary_search(&index).is_ok();
                let incoming: Vec<_> = self.nodes[index].inputs.iter().flat_map(|arg| &arg.values).copied().filter(|value| {
                    let tensor = &self.tensors[*value as usize];
                    tensor.name != 0 && !tensor.initializer && !self.producers.get(&tensor.name).is_some_and(|v| member(v.0))
                }).collect();
                let controls: Vec<_> = self.nodes[index].controls.iter().copied().filter(|value| {
                    !self.producers.get(&self.tensors[*value as usize].name).is_some_and(|v| member(v.0))
                }).collect();
                let outgoing: Vec<_> = self.nodes[index].outputs.iter().flat_map(|arg| &arg.values).copied().filter(|value| {
                    let name = self.tensors[*value as usize].name;
                    self.outputs.iter().any(|port| port.values.iter().any(|v| self.tensors[*v as usize].name == name)) ||
                        self.successors[index].iter().any(|to| !member(*to) && self.nodes[*to as usize].inputs.iter().flat_map(|arg| &arg.values)
                            .chain(&self.nodes[*to as usize].controls).any(|v| self.tensors[*v as usize].name == name))
                }).collect();
                self.groups[group].inputs.extend(incoming); self.groups[group].controls.extend(controls); self.groups[group].outputs.extend(outgoing);
                self.boundary_member += 1; return false;
            }
            _ => unreachable!(),
        }
        self.cursor += 1; false
    }
}

#[derive(Clone, Default)]
struct Match { a: u32, b: u32, local: bool, modified: bool, children: Vec<usize>, missing: bool }
#[derive(Default)]
struct Pair {
    a: u32, b: u32, matches: Vec<Match>, only_a: Vec<u32>, only_b: Vec<u32>, mapping: Vec<u32>, reverse: Vec<u32>,
    ready: bool, modified: bool, interface_changed: bool, children: Vec<Child>,
}
struct Child { node_a: u32, node_b: u32, slot: u32, pair: usize }
#[derive(Clone, Default)]
struct Best { score: i32, index: usize, tied: bool }
impl Best {
    fn update(&mut self, score: i32, index: usize) {
        if score > self.score { self.score = score; self.index = index; self.tied = false; }
        else if score == self.score { self.tied = true; }
    }
}
struct Job {
    pair: usize, stage: usize, cursor: usize, pass: usize,
    counts_a: HashMap<(u32, u32, u32), usize>, candidates: HashMap<(u32, u32, u32), Vec<u32>>,
    groups: Vec<(Vec<u32>, Vec<u32>)>, group: usize, ai: usize, bi: usize, best_a: Vec<Best>, best_b: Vec<Best>,
}
impl Job {
    fn new(pair: usize) -> Self { Self { pair, stage: 0, cursor: 0, pass: 0, counts_a: HashMap::new(), candidates: HashMap::new(),
        groups: Vec::new(), group: 0, ai: 0, bi: 0, best_a: Vec::new(), best_b: Vec::new() } }
}

fn attrs_score(a: &Graph, aa: &Node, b: &Graph, bb: &Node) -> i32 {
    let map_a: HashMap<_, _> = aa.attrs.iter().map(|v| (v.0, (v.1, v.2))).collect();
    let map_b: HashMap<_, _> = bb.attrs.iter().map(|v| (v.0, (v.1, v.2))).collect();
    let keys: HashSet<_> = map_a.keys().chain(map_b.keys()).collect();
    if keys.is_empty() { return 30; }
    let mut earned = 0.0;
    for key in &keys {
        if let (Some(&(ta, va)), Some(&(tb, vb))) = (map_a.get(key), map_b.get(key)) {
            if ta == tb { earned += if equal(a, va, b, vb) { 1.0 } else { 0.5 }; }
        }
    }
    (30.0f64 * earned / keys.len() as f64).round() as i32
}

fn shape_score(a: &Graph, aa: &[Port], b: &Graph, bb: &[Port]) -> i32 {
    let av: Vec<_> = aa.iter().flat_map(|p| p.values.iter().map(|v| &a.tensors[*v as usize])).collect();
    let bv: Vec<_> = bb.iter().flat_map(|p| p.values.iter().map(|v| &b.tensors[*v as usize])).collect();
    if av.is_empty() && bv.is_empty() { return 7; }
    if av.is_empty() || bv.is_empty() { return 0; }
    let mut matched = 0.0; let mut dtype = 0;
    for (ta, tb) in av.iter().zip(&bv) {
        matched += match (&ta.dims, &tb.dims) {
            (Some(da), Some(db)) if da.len() == db.len() => if da.is_empty() { 1.0 } else {
                0.5 + 0.5 * da.iter().zip(db).filter(|(x, y)| equal(a, **x, b, **y)).count() as f64 / da.len() as f64
            },
            _ => 0.25,
        };
        if ta.dtype != 0 && ta.dtype == tb.dtype { dtype += 1; }
    }
    let n = av.len().max(bv.len()) as f64;
    (5.0 * matched / n).round() as i32 + (2.0 * dtype as f64 / n).round() as i32
}
fn similarity(a: &Graph, ai: usize, b: &Graph, bi: usize) -> i32 {
    let aa = &a.nodes[ai]; let bb = &b.nodes[bi];
    if aa.kind != bb.kind { return 0; }
    let degree_a = a.predecessors[ai].len() + a.successors[ai].len();
    let degree_b = b.predecessors[bi].len() + b.successors[bi].len();
    let degree = (2.0 * (1.0 - degree_a.abs_diff(degree_b) as f64 / degree_a.max(degree_b).max(1) as f64)).round() as i32;
    let shapes = (shape_score(a, &aa.inputs, b, &bb.inputs) + shape_score(a, &aa.outputs, b, &bb.outputs) + degree +
        if a.labels[ai] == b.labels[bi] { 2 } else { 0 }).min(20);
    50 + attrs_score(a, aa, b, bb) + shapes
}

fn connections_equal(a: &Graph, aa: &[Port], ac: &[u32], b: &Graph, bb: &[Port], bc: &[u32], mapping: &[u32]) -> bool {
    if aa.len() != bb.len() || ac.len() != bc.len() { return false; }
    let edge_equal = |ia: u32, ib: u32| {
        let ta = &a.tensors[ia as usize]; let tb = &b.tensors[ib as usize];
        if !equal(a, ta.meta, b, tb.meta) { return false; }
        match (a.producers.get(&ta.name), b.producers.get(&tb.name)) {
            (Some(&(na, pa, sa)), Some(&(nb, pb, sb))) => mapping[na as usize] == nb && pa == pb && sa == sb,
            (None, None) => if ta.initializer || tb.initializer { ta.initializer && tb.initializer } else { ta.name == tb.name },
            _ => false,
        }
    };
    aa.iter().zip(bb).all(|(x, y)| x.name == y.name && x.kind == y.kind && equal(a, x.meta, b, y.meta) && x.values.len() == y.values.len() && x.values.iter().zip(&y.values).all(|(x, y)| edge_equal(*x, *y))) &&
        ac.iter().zip(bc).all(|(x, y)| edge_equal(*x, *y))
}

fn port_headers_equal(a: &Graph, aa: &[Port], b: &Graph, bb: &[Port]) -> bool {
    aa.len() == bb.len() && aa.iter().zip(bb).all(|(x, y)| x.name == y.name && x.kind == y.kind && equal(a, x.meta, b, y.meta) &&
        x.values.len() == y.values.len() && x.values.iter().zip(&y.values).all(|(x, y)| equal(a, a.tensors[*x as usize].meta, b, b.tensors[*y as usize].meta)))
}

fn pattern_ports_equal(g: &Graph, a: &[Port], b: &[Port]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| x.kind == y.kind && equal(g, x.meta, g, y.meta) && x.values.len() == y.values.len() &&
        x.values.iter().zip(&y.values).all(|(x, y)| equal(g, g.tensors[*x as usize].meta, g, g.tensors[*y as usize].meta)))
}

#[derive(Default)]
pub struct Analysis {
    input: Vec<u8>, output: Vec<u8>, strings: Vec<String>, pool: HashMap<String, u32>, graphs: Vec<Option<Graph>>,
    pairs: Vec<Pair>, pair_ids: HashMap<(u32, u32), usize>, queue: VecDeque<usize>, job: Option<Job>,
    prepare: usize, propagation: VecDeque<usize>, parents: Vec<Vec<(usize, usize)>>, done: bool, error: String,
}
impl Analysis {
    fn new() -> Self { Self { strings: vec![String::new()], pool: HashMap::from([(String::new(), 0)]), ..Self::default() } }
    fn upload(&mut self) -> Result<u32> {
        let (id, graph) = Graph::decode(&self.input, &mut self.strings, &mut self.pool)?;
        if self.graphs.get(id as usize).is_some_and(|v| v.is_some()) { return Err("Graph already uploaded".into()); }
        self.graphs.resize_with((id as usize + 1).max(self.graphs.len()), || None);
        self.graphs[id as usize] = Some(graph); self.done = false; Ok(id)
    }
    fn graph(&self, id: u32) -> &Graph { self.graphs[id as usize].as_ref().unwrap() }
    fn pair(&mut self, a: u32, b: u32) -> usize {
        if let Some(&id) = self.pair_ids.get(&(a, b)) { return id; }
        let n = if a == NONE { 0 } else { self.graph(a).nodes.len() };
        let m = if b == NONE { 0 } else { self.graph(b).nodes.len() };
        let id = self.pairs.len();
        self.pairs.push(Pair { a, b, mapping: vec![NONE; n], reverse: vec![NONE; m], ..Pair::default() });
        self.parents.push(Vec::new()); self.pair_ids.insert((a, b), id); self.queue.push_back(id); self.done = false; id
    }
    fn start(&mut self, a: u32, b: u32) -> Result<usize> {
        for graph in [a, b] {
            if graph != NONE && !self.graphs.get(graph as usize).is_some_and(|v| v.is_some()) { return Err("Unknown graph".into()); }
        }
        Ok(self.pair(a, b))
    }
    fn add_match(&mut self, pair: usize, a: u32, b: u32) {
        let p = &mut self.pairs[pair]; p.mapping[a as usize] = b; p.reverse[b as usize] = a;
        p.matches.push(Match { a, b, ..Match::default() });
    }
    fn step(&mut self, budget: usize) -> Result<bool> {
        for _ in 0..budget.min(65536) {
            if self.prepare < self.graphs.len() {
                if let Some(graph) = &mut self.graphs[self.prepare] {
                    if graph.stage >= 4 { self.prepare += 1; }
                    else { graph.prepare_step(&self.strings); }
                } else { self.prepare += 1; }
                continue;
            }
            if self.job.is_none() { self.job = self.queue.pop_front().map(Job::new); }
            if let Some(mut job) = self.job.take() {
                if !self.job_step(&mut job)? { self.job = Some(job); }
                continue;
            }
            if let Some(child) = self.propagation.pop_front() {
                if self.pairs[child].modified {
                    for &(parent, owner) in &self.parents[child] {
                        self.pairs[parent].matches[owner].modified = true;
                        if !self.pairs[parent].modified { self.pairs[parent].modified = true; self.propagation.push_back(parent); }
                    }
                }
                continue;
            }
            self.done = true; return Ok(true);
        }
        Ok(false)
    }
    fn job_step(&mut self, job: &mut Job) -> Result<bool> {
        let pair_id = job.pair;
        let (a_id, b_id) = (self.pairs[pair_id].a, self.pairs[pair_id].b);
        if a_id == NONE || b_id == NONE {
            let p = &mut self.pairs[pair_id]; p.only_a = (0..p.mapping.len() as u32).collect(); p.only_b = (0..p.reverse.len() as u32).collect();
            p.modified = true; p.ready = true; self.propagation.push_back(pair_id); return Ok(true);
        }
        let a = self.graph(a_id); let b = self.graph(b_id);
        let key = |node: &Node| if node.name == 0 { None } else { Some(match job.pass { 0 => (node.name, node.kind, node.group), 1 => (node.name, node.kind, 0), _ => (node.name, 0, 0) }) };
        match job.stage {
            0 => {
                if job.cursor < a.nodes.len() {
                    if self.pairs[pair_id].mapping[job.cursor] == NONE {
                        if let Some(key) = key(&a.nodes[job.cursor]) { *job.counts_a.entry(key).or_default() += 1; }
                    }
                    job.cursor += 1;
                } else { job.stage = 1; job.cursor = 0; }
            }
            1 => {
                if job.cursor < b.nodes.len() {
                    if self.pairs[pair_id].reverse[job.cursor] == NONE {
                        if let Some(key) = key(&b.nodes[job.cursor]) { job.candidates.entry(key).or_default().push(job.cursor as u32); }
                    }
                    job.cursor += 1;
                } else { job.stage = 2; job.cursor = 0; }
            }
            2 => {
                if job.cursor < a.nodes.len() {
                    let index = job.cursor; job.cursor += 1;
                    if self.pairs[pair_id].mapping[index] == NONE {
                        if let Some(key) = key(&a.nodes[index]) {
                            if job.counts_a.get(&key) == Some(&1) {
                                if let Some(candidates) = job.candidates.get(&key) {
                                    if candidates.len() == 1 && self.pairs[pair_id].reverse[candidates[0] as usize] == NONE { self.add_match(pair_id, index as u32, candidates[0]); }
                                }
                            }
                        }
                    }
                } else {
                    job.cursor = 0; job.counts_a.clear(); job.candidates.clear(); job.pass += 1;
                    job.stage = if job.pass < 3 { 0 } else { 3 };
                }
            }
            3 => {
                if job.cursor < a.nodes.len() {
                    if self.pairs[pair_id].mapping[job.cursor] == NONE { job.candidates.entry((a.nodes[job.cursor].kind, 0, 0)).or_default().push(job.cursor as u32); }
                    job.cursor += 1;
                } else {
                    let mut b_groups: HashMap<u32, Vec<u32>> = HashMap::new();
                    for (index, node) in b.nodes.iter().enumerate() {
                        if self.pairs[pair_id].reverse[index] == NONE { b_groups.entry(node.kind).or_default().push(index as u32); }
                    }
                    let mut keys: Vec<_> = job.candidates.keys().copied().collect(); keys.sort_unstable();
                    for key in keys { if let Some(other) = b_groups.remove(&key.0) { job.groups.push((job.candidates.remove(&key).unwrap(), other)); } }
                    job.stage = 4; job.cursor = 0;
                }
            }
            4 => {
                if job.group >= job.groups.len() { job.stage = 5; job.cursor = 0; return Ok(false); }
                let (ga, gb) = &job.groups[job.group];
                if job.best_a.is_empty() {
                    job.best_a = vec![Best { score: 79, ..Best::default() }; ga.len()];
                    job.best_b = vec![Best { score: 79, ..Best::default() }; gb.len()];
                }
                if job.ai < ga.len() {
                    let score = similarity(a, ga[job.ai] as usize, b, gb[job.bi] as usize);
                    job.best_a[job.ai].update(score, job.bi); job.best_b[job.bi].update(score, job.ai);
                    job.bi += 1; if job.bi == gb.len() { job.bi = 0; job.ai += 1; }
                } else if job.cursor < ga.len() {
                    let ai = job.cursor; job.cursor += 1;
                    let best = &job.best_a[ai]; let bi = best.index;
                    if best.score >= 80 && !best.tied && !job.best_b[bi].tied && job.best_b[bi].index == ai { self.add_match(pair_id, ga[ai], gb[bi]); }
                } else { job.group += 1; job.ai = 0; job.bi = 0; job.cursor = 0; job.best_a.clear(); job.best_b.clear(); }
            }
            5 => {
                if job.cursor < self.pairs[pair_id].matches.len() {
                    let at = job.cursor; job.cursor += 1;
                    let matched = &self.pairs[pair_id].matches[at];
                    let aa = &a.nodes[matched.a as usize]; let bb = &b.nodes[matched.b as usize];
                    let attrs_equal = aa.attrs.len() == bb.attrs.len() && aa.attrs.iter().zip(&bb.attrs).all(|(x, y)|
                        x.0 == y.0 && x.1 == y.1 && equal(a, x.2, b, y.2));
                    let local = aa.kind != bb.kind || !equal(a, aa.meta, b, bb.meta) || !attrs_equal ||
                        !port_headers_equal(a, &aa.outputs, b, &bb.outputs) ||
                        !connections_equal(a, &aa.inputs, &aa.controls, b, &bb.inputs, &bb.controls, &self.pairs[pair_id].mapping);
                    let ma = matched.a; let mb = matched.b;
                    let mut bodies: Vec<_> = aa.bodies.iter().map(|&(slot, id)| (slot, id, bb.bodies.iter().find(|v| v.0 == slot).map_or(NONE, |v| v.1))).collect();
                    for &(slot, id) in &bb.bodies { if !aa.bodies.iter().any(|v| v.0 == slot) { bodies.push((slot, NONE, id)); } }
                    self.pairs[pair_id].matches[at].local = local;
                    self.pairs[pair_id].matches[at].modified = local;
                    for (slot, left, right) in bodies {
                        for id in [left, right] {
                            if id != NONE && !self.graphs.get(id as usize).is_some_and(|v| v.is_some()) { return Err("Missing function body metadata".into()); }
                        }
                        let child = self.pair(left, right);
                        self.pairs[pair_id].matches[at].children.push(child);
                        self.parents[child].push((pair_id, at));
                        self.pairs[pair_id].children.push(Child { node_a: ma, node_b: mb, slot, pair: child });
                        if left == NONE || right == NONE || self.pairs[child].modified { self.pairs[pair_id].matches[at].missing = true; self.pairs[pair_id].matches[at].modified = true; }
                    }
                } else { job.stage = 6; }
            }
            6 => {
                let interface = !equal(a, a.interface, b, b.interface) ||
                    !connections_equal(a, &a.inputs, &[], b, &b.inputs, &[], &self.pairs[pair_id].mapping) ||
                    !connections_equal(a, &a.outputs, &[], b, &b.outputs, &[], &self.pairs[pair_id].mapping);
                let p = &mut self.pairs[pair_id];
                p.only_a = p.mapping.iter().enumerate().filter(|(_, v)| **v == NONE).map(|(i, _)| i as u32).collect();
                p.only_b = p.reverse.iter().enumerate().filter(|(_, v)| **v == NONE).map(|(i, _)| i as u32).collect();
                p.interface_changed = interface; p.modified = interface || !p.only_a.is_empty() || !p.only_b.is_empty() || p.matches.iter().any(|v| v.modified);
                p.ready = true; self.propagation.push_back(pair_id); job.stage = 7; job.cursor = 0;
            }
            7 => {
                let p = &self.pairs[pair_id];
                let left = job.cursor < p.only_a.len();
                let at = if left { job.cursor } else { job.cursor - p.only_a.len() };
                let list = if left { &p.only_a } else { &p.only_b };
                if at >= list.len() { return Ok(true); }
                let node = list[at]; job.cursor += 1;
                let bodies = if left { a.nodes[node as usize].bodies.clone() } else { b.nodes[node as usize].bodies.clone() };
                for (slot, graph) in bodies {
                    if !self.graphs.get(graph as usize).is_some_and(|v| v.is_some()) { return Err("Missing function body metadata".into()); }
                    let child = self.pair(if left { graph } else { NONE }, if left { NONE } else { graph });
                    self.pairs[pair_id].children.push(Child { node_a: if left { node } else { NONE }, node_b: if left { NONE } else { node }, slot, pair: child });
                }
            }
            _ => unreachable!(),
        }
        Ok(false)
    }

    fn result(&mut self, id: usize) -> Result<()> {
        let p = self.pairs.get(id).ok_or("Unknown comparison")?;
        let mut out = format!("{{\"id\":{id},\"a\":{},\"b\":{},\"pending\":{},\"modified\":{},\"interfaceChanged\":{},\"pairs\":[", p.a, p.b, !self.done, p.modified, p.interface_changed);
        for (at, matched) in p.matches.iter().enumerate() {
            if at > 0 { out.push(','); }
            let status = if matched.modified { "modified" } else if !self.done && !matched.children.is_empty() { "pending" } else { "identical" };
            write!(out, "{{\"indexA\":{},\"indexB\":{},\"status\":\"{status}\"}}", matched.a, matched.b).unwrap();
        }
        write!(out, "],\"onlyInA\":{:?},\"onlyInB\":{:?},\"children\":[", p.only_a, p.only_b).unwrap();
        for (at, child) in p.children.iter().enumerate() {
            if at > 0 { out.push(','); }
            let pair = &self.pairs[child.pair];
            write!(out, "{{\"nodeA\":{},\"nodeB\":{},\"pair\":{},\"a\":{},\"b\":{},\"slot\":{} }}", child.node_a, child.node_b, child.pair, pair.a, pair.b, json(&self.strings[child.slot as usize])).unwrap();
        }
        out.push_str("]}"); self.output = out.into_bytes(); Ok(())
    }

    fn group_step(&mut self, id: u32, budget: usize) -> Result<bool> {
        let graph = self.graphs.get_mut(id as usize).and_then(Option::as_mut).ok_or("Unknown graph")?;
        for _ in 0..budget.min(65536) {
            if graph.prepare_step(&self.strings) { return Ok(true); }
        }
        Ok(false)
    }

    fn project(&mut self, graph: u32, pair: usize, side: u32, expanded: &[u32], initialize: bool) -> Result<()> {
        if !self.done { return Err("Graph analysis is still pending".into()); }
        if side > 1 || self.graphs.get(graph as usize).and_then(Option::as_ref).is_none() { return Err("Unknown graph or side".into()); }
        let p = self.pairs.get(pair).ok_or("Unknown comparison")?;
        if (if side == 0 { p.a } else { p.b }) != graph { return Err("Graph does not belong to comparison".into()); }
        let g = self.graph(graph);
        if g.stage < 8 { return Err("Graph grouping is still pending".into()); }
        let mut open: HashSet<_> = expanded.iter().map(|v| *v as usize).collect();
        if initialize {
            let mut children = &g.groups[0].children;
            while children.len() == 1 && children[0] > 0 {
                let group = children[0] as usize;
                open.insert(group); children = &g.groups[group].children;
            }
        }
        if open.iter().any(|v| *v >= g.groups.len()) { return Err("Invalid expanded group".into()); }
        let mut unsafe_groups = HashSet::new();
        let (owners, records, containers) = loop {
            let mut owners = vec![0usize; g.nodes.len()]; let mut records = Vec::new(); let mut containers = Vec::new();
            let mut stack: Vec<_> = g.groups[0].children.iter().rev().map(|v| (*v, 0usize)).collect();
            while let Some((entry, parent)) = stack.pop() {
                if entry < 0 {
                    let index = (-entry - 1) as usize; owners[index] = g.groups.len() + index;
                    records.push((index as u32, 0usize, parent));
                } else {
                    let group = entry as usize;
                    if open.contains(&group) || g.duplicate {
                        containers.push(group);
                        stack.extend(g.groups[group].children.iter().rev().map(|v| (*v, group)));
                    } else {
                        for &index in &g.groups[group].members { owners[index as usize] = group; }
                        records.push((NONE, group, parent));
                    }
                }
            }
            let mut edges: HashMap<usize, HashSet<usize>> = HashMap::new(); let mut degrees = HashMap::new();
            for &owner in &owners { edges.entry(owner).or_default(); degrees.entry(owner).or_insert(0usize); }
            for (node, pred) in g.predecessors.iter().enumerate() {
                let to = owners[node];
                for &source in pred {
                    let from = owners[source as usize];
                    if from != to && edges.get_mut(&from).unwrap().insert(to) { *degrees.get_mut(&to).unwrap() += 1; }
                }
            }
            let mut queue: Vec<_> = degrees.iter().filter(|v| *v.1 == 0).map(|v| *v.0).collect();
            let mut at = 0;
            while at < queue.len() {
                for to in &edges[&queue[at]] {
                    let count = degrees.get_mut(to).unwrap(); *count -= 1; if *count == 0 { queue.push(*to); }
                }
                at += 1;
            }
            let unsafe_now: Vec<_> = degrees.iter().filter(|(owner, count)| **owner < g.groups.len() && **count > 0).map(|v| *v.0).collect();
            if unsafe_now.is_empty() { break (owners, records, containers); }
            for group in unsafe_now { open.insert(group); unsafe_groups.insert(group); }
        };
        let mut statuses = vec![0usize; g.nodes.len()];
        for matched in &p.matches { statuses[if side == 0 { matched.a } else { matched.b } as usize] = if matched.modified { 1 } else { 0 }; }
        for &index in if side == 0 { &p.only_a } else { &p.only_b } { statuses[index as usize] = if side == 0 { 3 } else { 2 }; }
        let mut out = String::from("{\"groups\":["); let mut first = true;
        for (id, group) in g.groups.iter().enumerate().skip(1).filter(|(_, group)| group.active) {
            if !first { out.push(','); } first = false;
            let mut counts = [0usize; 4]; for &member in &group.members { counts[statuses[member as usize]] += 1; }
            write!(out, "{{\"key\":{id},\"id\":{},\"label\":{},\"parent\":{},\"members\":{:?},\"counts\":{:?},\"inputs\":{:?},\"outputs\":{:?},\"controls\":{:?},\"unsafe\":{}}}",
                json(&group.id), json(&group.label), json(&g.groups[group.parent].id), group.members, counts, group.inputs, group.outputs, group.controls, unsafe_groups.contains(&id) || g.duplicate).unwrap();
        }
        out.push_str("],\"records\":[");
        let mut records = records; records.sort_unstable_by_key(|v| if v.0 == NONE { g.groups[v.1].members[0] } else { v.0 });
        for (at, (index, group, parent)) in records.iter().enumerate() {
            if at > 0 { out.push(','); }
            write!(out, "{{\"index\":{index},\"group\":{},\"parent\":{}}}", json(&g.groups[*group].id), json(&g.groups[*parent].id)).unwrap();
        }
        out.push_str("],\"containers\":[");
        for (at, group) in containers.iter().enumerate() { if at > 0 { out.push(','); } out.push_str(&json(&g.groups[*group].id)); }
        let mut expanded: Vec<_> = open.into_iter().collect(); expanded.sort_unstable();
        write!(out, "],\"owners\":{:?},\"groupCount\":{},\"expanded\":{:?}}}", owners, g.groups.len(), expanded).unwrap();
        self.output = out.into_bytes(); Ok(())
    }
}

fn json(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch { '"' => out.push_str("\\\""), '\\' => out.push_str("\\\\"), '\n' => out.push_str("\\n"), '\r' => out.push_str("\\r"), '\t' => out.push_str("\\t"),
            c if c < ' ' => { write!(out, "\\u{:04x}", c as u32).unwrap(); }, c => out.push(c) }
    }
    out.push('"'); out
}

#[cfg(target_arch = "wasm32")]
mod abi {
    use super::*;
    #[no_mangle]
    pub extern "C" fn analysis_new() -> *mut Analysis { Box::into_raw(Box::new(Analysis::new())) }
    #[no_mangle]
    pub unsafe extern "C" fn analysis_input(p: *mut Analysis, length: usize) -> *mut u8 {
        if length > LIMIT { (*p).error = "Analysis input exceeds limit".into(); return std::ptr::null_mut(); }
        (*p).input.resize(length, 0); (*p).input.as_mut_ptr()
    }
    #[no_mangle]
    pub unsafe extern "C" fn analysis_upload(p: *mut Analysis) -> u32 {
        match (*p).upload() { Ok(id) => id, Err(error) => { (*p).error = error; NONE } }
    }
    #[no_mangle]
    pub unsafe extern "C" fn analysis_start(p: *mut Analysis, a: u32, b: u32) -> u32 {
        match (*p).start(a, b) { Ok(id) => id as u32, Err(error) => { (*p).error = error; NONE } }
    }
    #[no_mangle]
    pub unsafe extern "C" fn analysis_step(p: *mut Analysis, budget: usize) -> i32 {
        match (*p).step(budget) { Ok(done) => i32::from(done), Err(error) => { (*p).error = error; -1 } }
    }
    #[no_mangle]
    pub unsafe extern "C" fn analysis_result(p: *mut Analysis, pair: usize) -> i32 {
        match (*p).result(pair) { Ok(()) => 0, Err(error) => { (*p).error = error; -1 } }
    }
    #[no_mangle]
    pub unsafe extern "C" fn analysis_group_step(p: *mut Analysis, graph: u32, budget: usize) -> i32 {
        match (*p).group_step(graph, budget) { Ok(done) => i32::from(done), Err(error) => { (*p).error = error; -1 } }
    }
    #[no_mangle]
    pub unsafe extern "C" fn analysis_project(p: *mut Analysis, graph: u32, pair: usize, side: u32, initialize: u32) -> i32 {
        if (*p).input.len() % 4 != 0 { (*p).error = "Invalid expansion table".into(); return -1; }
        let expanded: Vec<_> = (*p).input.chunks_exact(4).map(|v| u32::from_le_bytes(v.try_into().unwrap())).collect();
        match (*p).project(graph, pair, side, &expanded, initialize != 0) { Ok(()) => 0, Err(error) => { (*p).error = error; -1 } }
    }
    #[no_mangle]
    pub unsafe extern "C" fn analysis_output(p: *const Analysis) -> *const u8 { (*p).output.as_ptr() }
    #[no_mangle]
    pub unsafe extern "C" fn analysis_output_len(p: *const Analysis) -> usize { (*p).output.len() }
    #[no_mangle]
    pub unsafe extern "C" fn analysis_error(p: *const Analysis) -> *const u8 { (*p).error.as_ptr() }
    #[no_mangle]
    pub unsafe extern "C" fn analysis_error_len(p: *const Analysis) -> usize { let analysis = &*p; analysis.error.len() }
    #[no_mangle]
    pub unsafe extern "C" fn analysis_free(p: *mut Analysis) { drop(Box::from_raw(p)); }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(engine: &mut Analysis, names: &[&str], kinds: &[&str], scopes: &[&str]) -> Graph {
        let mut intern = |text: &str| *engine.pool.entry(text.into()).or_insert_with(|| { let id = engine.strings.len() as u32; engine.strings.push(text.into()); id });
        let nodes: Vec<_> = names.iter().enumerate().map(|(index, name)| Node {
            name: intern(name), kind: intern(&format!("\0{}\0", kinds[index])), scope: intern(scopes[index]),
            ..Node::default()
        }).collect();
        let n = nodes.len();
        Graph { values: vec![Value::default()], nodes, predecessors: vec![Vec::new(); n], successors: vec![Vec::new(); n],
            labels: vec![0; n], next_labels: vec![0; n], parents: vec![0; n], groups: vec![Group { active: true, ..Group::default() }], ..Graph::default() }
    }
    fn run(engine: &mut Analysis, a: Graph, b: Graph) -> usize {
        engine.graphs = vec![Some(a), Some(b)];
        let pair = engine.start(0, 1).unwrap();
        let mut steps = 0;
        while !engine.step(1).unwrap() { steps += 1; assert!(steps < 100000); }
        assert!(steps > 10);
        assert!(engine.error.is_empty());
        pair
    }
    #[test]
    fn stable_names_detect_replacements_and_anonymous_ties_stay_unmatched() {
        let mut engine = Analysis::new();
        let a = fixture(&mut engine, &["same", "", ""], &["Relu", "Add", "Add"], &["", "", ""]);
        let b = fixture(&mut engine, &["same", "", ""], &["Sigmoid", "Add", "Add"], &["", "", ""]);
        let pair = run(&mut engine, a, b);
        assert_eq!(engine.pairs[pair].matches.len(), 1);
        assert!(engine.pairs[pair].matches[0].modified);
        assert_eq!(engine.pairs[pair].only_a, [1, 2]);
        assert_eq!(engine.pairs[pair].only_b, [1, 2]);
    }
    #[test]
    fn metadata_distinguishes_duplicate_names() {
        let mut engine = Analysis::new();
        let mut a = fixture(&mut engine, &["same", "same"], &["Relu", "Relu"], &["", ""]);
        let mut b = fixture(&mut engine, &["same", "same"], &["Relu", "Relu"], &["", ""]);
        for g in [&mut a, &mut b] {
            g.values.extend([Value { tag: 3, atom: 2f64.to_le_bytes().to_vec(), ..Value::default() }, Value { tag: 3, atom: 3f64.to_le_bytes().to_vec(), ..Value::default() }]);
            g.tensors = vec![Tensor { dims: Some(vec![1]), dtype: 1, ..Tensor::default() }, Tensor { dims: Some(vec![2]), dtype: 1, ..Tensor::default() }];
        }
        a.nodes[0].inputs = vec![Port { values: vec![0], ..Port::default() }];
        a.nodes[1].inputs = vec![Port { values: vec![1], ..Port::default() }];
        b.nodes[0].inputs = vec![Port { values: vec![1], ..Port::default() }];
        b.nodes[1].inputs = vec![Port { values: vec![0], ..Port::default() }];
        let pair = run(&mut engine, a, b);
        assert_eq!(engine.pairs[pair].mapping, [1, 0]);
    }
    #[test]
    fn grouped_cycles_stay_open_and_boundaries_retain_control_edges() {
        let mut engine = Analysis::new();
        let mut a = fixture(&mut engine, &["first", "middle", "last"], &["Relu", "Relu", "Relu"], &["outer", "", "outer"]);
        a.tensors = (1..=4).map(|name| Tensor { name, ..Tensor::default() }).collect();
        for i in 0..3 {
            a.nodes[i].inputs = vec![Port { values: vec![i as u32], ..Port::default() }];
            a.nodes[i].outputs = vec![Port { values: vec![i as u32 + 1], ..Port::default() }];
        }
        a.nodes[2].controls = vec![2];
        a.outputs = vec![Port { values: vec![3], ..Port::default() }];
        engine.graphs = vec![Some(a)];
        let pair = engine.start(0, 0).unwrap();
        while !engine.step(1).unwrap() {}
        assert_eq!(engine.graph(0).stage, 4);
        assert_eq!(engine.graph(0).groups.len(), 1);
        while !engine.group_step(0, 1).unwrap() {}
        engine.project(0, pair, 0, &[], false).unwrap();
        let output = String::from_utf8(engine.output.clone()).unwrap();
        assert!(output.contains("\"unsafe\":true"));
        assert!(output.contains("\"controls\":[2]"));
        assert_eq!(engine.graph(0).groups[1].members, [0, 2]);
        assert_eq!(engine.graph(0).groups[1].outputs, [1, 3]);
    }
    #[test]
    fn shared_recursive_bodies_propagate_to_every_caller() {
        let mut engine = Analysis::new();
        let mut root_a = fixture(&mut engine, &["one", "two"], &["Function", "Function"], &["", ""]);
        let mut root_b = fixture(&mut engine, &["one", "two"], &["Function", "Function"], &["", ""]);
        for node in &mut root_a.nodes { node.bodies.push((0, 2)); }
        for node in &mut root_b.nodes { node.bodies.push((0, 3)); }
        let mut body_a = fixture(&mut engine, &["self", "inside"], &["Function", "Relu"], &["", ""]);
        let mut body_b = fixture(&mut engine, &["self", "inside"], &["Function", "Sigmoid"], &["", ""]);
        body_a.nodes[0].bodies.push((0, 2)); body_b.nodes[0].bodies.push((0, 3));
        engine.graphs = vec![Some(root_a), Some(root_b), Some(body_a), Some(body_b)];
        let root = engine.start(0, 1).unwrap();
        while !engine.step(1).unwrap() {}
        assert_eq!(engine.pairs.len(), 2);
        assert!(engine.pairs[root].matches.iter().all(|v| v.modified));
        engine.result(root).unwrap();
        assert!(String::from_utf8_lossy(&engine.output).contains("\"pending\":false"));
    }
    #[test]
    fn invalid_tables_are_errors() {
        let mut engine = Analysis::new();
        for length in 0..32 { engine.input = vec![255; length]; assert!(engine.upload().is_err()); }
        assert!(engine.start(1, 2).is_err());
        assert!(engine.result(0).is_err());
    }
    #[test]
    fn cyclic_metadata_uses_structural_equality() {
        let value = Value { tag: 8, props: vec![(1, 0)], ..Value::default() };
        let a = Graph { values: vec![value.clone()], ..Graph::default() };
        let b = Graph { values: vec![Value { props: vec![(1, 1)], ..value.clone() }, value], ..Graph::default() };
        assert!(equal(&a, 0, &b, 0));
    }
    #[test]
    fn json_escapes_control_characters() { assert_eq!(json("a\n\0\"\\"), "\"a\\n\\u0000\\\"\\\\\""); }
}
