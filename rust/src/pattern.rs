//! Candidate search only. Hash hits still require full metadata and connection verification.
struct Patterns {
    input: Vec<u32>,
    prefix: Vec<u32>,
    power: Vec<u32>,
    missing: Vec<u32>,
    forks: Vec<u32>,
    next: Vec<usize>,
    output: Vec<u32>,
}

impl Patterns {
    fn new(count: usize) -> Self {
        Self { input: vec![0; count * 2], prefix: vec![0; count + 1], power: vec![0; count + 1],
            missing: vec![0; count + 1], forks: vec![0; count + 1], next: vec![count; count], output: Vec::with_capacity(2048) }
    }

    fn prepare(&mut self) {
        self.power[0] = 1;
        for i in 0..self.input.len() / 2 {
            let flags = self.input[i * 2 + 1];
            self.prefix[i + 1] = self.prefix[i].wrapping_mul(16777619).wrapping_add(self.input[i * 2]).wrapping_add(1);
            self.power[i + 1] = self.power[i].wrapping_mul(16777619);
            self.missing[i + 1] = self.missing[i] + u32::from(flags & 1 == 0);
            self.forks[i + 1] = self.forks[i] + u32::from(flags & 4 != 0);
        }
        let mut last = std::collections::HashMap::new();
        for i in (0..self.next.len()).rev() {
            self.next[i] = last.insert(self.input[i * 2], i).unwrap_or(self.next.len());
        }
    }

    fn hash(&self, start: usize, count: usize) -> u32 {
        self.prefix[start + count].wrapping_sub(self.prefix[start].wrapping_mul(self.power[count]))
    }

    fn scan(&mut self, start: usize) {
        self.output.clear();
        let count = self.input.len() / 2;
        if start >= count || self.input[start * 2 + 1] & 1 == 0 { return; }
        let mut at = self.next[start];
        let limit = start + 1024.min((count - start) / 2);
        while at <= limit {
            let period = at - start;
            at = self.next[at];
            if self.missing[start + period] != self.missing[start] { break; }
            if period > 1 && self.input[start * 2 + 1] & 2 == 0 && self.forks[start + period] != self.forks[start] { continue; }
            let token = self.hash(start, period);
            let mut repeats = 1;
            while start + (repeats + 1) * period <= count &&
                self.missing[start + (repeats + 1) * period] == self.missing[start + repeats * period] &&
                self.hash(start + repeats * period, period) == token {
                repeats += 1;
            }
            if repeats > 1 { self.output.extend([period as u32, repeats as u32]); }
        }
    }
}

#[cfg(target_arch = "wasm32")]
mod abi {
    use super::Patterns;
    #[no_mangle]
    pub extern "C" fn pattern_new(count: usize) -> *mut Patterns {
        if count > 10_000_000 { return std::ptr::null_mut(); }
        Box::into_raw(Box::new(Patterns::new(count)))
    }
    #[no_mangle]
    pub unsafe extern "C" fn pattern_input(p: *mut Patterns) -> *mut u32 { (*p).input.as_mut_ptr() }
    #[no_mangle]
    pub unsafe extern "C" fn pattern_prepare(p: *mut Patterns) { (*p).prepare(); }
    #[no_mangle]
    pub unsafe extern "C" fn pattern_scan(p: *mut Patterns, start: usize) -> usize {
        (*p).scan(start);
        (*p).output.len()
    }
    #[no_mangle]
    pub unsafe extern "C" fn pattern_output(p: *const Patterns) -> *const u32 { (*p).output.as_ptr() }
    #[no_mangle]
    pub unsafe extern "C" fn pattern_free(p: *mut Patterns) { drop(Box::from_raw(p)); }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeat_boundaries_and_wrapping_hashes() {
        let mut p = Patterns::new(8);
        for i in 0..8 { p.input[i * 2] = if i % 2 == 0 { u32::MAX } else { 23 }; p.input[i * 2 + 1] = 3; }
        p.prepare();
        p.scan(0);
        assert_eq!(p.output, [2, 4, 4, 2]);
        p.input[4 * 2 + 1] = 0;
        p.prepare();
        p.scan(0);
        assert_eq!(p.output, [2, 2]);
        p.scan(8);
        assert!(p.output.is_empty());
    }
    #[test]
    fn forks_stay_with_their_branches() {
        let mut p = Patterns::new(6);
        p.input = vec![0, 1, 1, 5, 0, 1, 1, 5, 0, 1, 1, 5];
        p.prepare();
        p.scan(0);
        assert!(p.output.is_empty());
        p.input[1] |= 2;
        p.scan(0);
        assert_eq!(p.output, [2, 3]);
    }
}
