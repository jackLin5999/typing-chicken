//! `/ToUnicode` CMap parsing.
//!
//! This is what makes Chinese PDFs readable at all. A CJK PDF almost always
//! uses a CID-keyed font (`/Encoding /Identity-H`), where the bytes in a `Tj`
//! string are *glyph indices*, not characters — `4E2D` means "glyph #0x4E2D",
//! which is unrelated to U+4E2D. The only thing that maps them back to real
//! characters is the font's `/ToUnicode` stream, a small PostScript-flavoured
//! program of `beginbfchar` / `beginbfrange` blocks. lopdf 0.32 never reads it
//! (`Document::decode_text`, document.rs:514, returns the literal string
//! `"?Identity-H Unimplemented?"` for Identity-H), which is why a Chinese PDF
//! currently imports as zero characters.
//!
//! We do not implement a full PostScript CMap interpreter — just the three
//! block kinds that carry the mapping, with everything else ignored.

use std::collections::HashMap;

use super::lexer::{Lexer, Token};

/// A `bfrange` such as `<00000000> <FFFFFFFF> <00000000>` would otherwise
/// loop 2^32 times and hang the import.
const MAX_BFRANGE_SPAN: u32 = 65_536;
/// Ceiling on entries from a single CMap, so a pathological file cannot
/// exhaust memory.
const MAX_MAP_ENTRIES: usize = 1 << 20;
/// Abandon a `begin*` block after this many unexpected tokens. Guarantees a
/// truncated CMap (one missing its `end*` keyword) cannot swallow the rest of
/// the stream or loop.
const MAX_MALFORMED_IN_BLOCK: usize = 8;

#[derive(Debug)]
struct CodeSpace {
    lo: u32,
    hi: u32,
    len: u8,
}

/// Counts fed to the "has text but nothing decoded" diagnosis.
#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct DecodeStat {
    pub mapped: usize,
    pub unmapped: usize,
}

#[derive(Debug, Default)]
pub(crate) struct CMap {
    map: HashMap<u32, String>,
    codespaces: Vec<CodeSpace>,
    /// Code width to assume when no `codespacerange` claims a code: 2 for
    /// Type0/Identity-H, 1 for simple fonts.
    default_len: u8,
}

impl CMap {
    pub fn parse(data: &[u8], default_len: u8) -> CMap {
        let mut cmap = CMap {
            map: HashMap::new(),
            codespaces: Vec::new(),
            default_len: default_len.max(1),
        };

        let tokens: Vec<Token> = Lexer::new(data).collect();
        let mut i = 0;

        while i < tokens.len() {
            let keyword = match &tokens[i] {
                Token::Keyword(k) => *k,
                _ => {
                    i += 1;
                    continue;
                }
            };
            match keyword {
                b"begincodespacerange" => {
                    i = cmap.read_codespace_range(&tokens, i + 1);
                }
                b"beginbfchar" => {
                    i = cmap.read_bfchar(&tokens, i + 1);
                }
                b"beginbfrange" => {
                    i = cmap.read_bfrange(&tokens, i + 1);
                }
                // `usecmap` references a *predefined* CMap that is not present
                // in the file — there is nothing to resolve, so ignore it, as
                // we do `def`, `dict`, `begincidrange` and the rest.
                _ => i += 1,
            }
        }

        cmap
    }

    /// Number of distinct codes mapped — used by the tests that check the
    /// `bfrange` forms and the span clamp.
    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.map.len()
    }

    pub fn get(&self, code: u32) -> Option<&str> {
        self.map.get(&code).map(String::as_str)
    }

    /// Split one code off the front of `bytes` at `pos`, returning the code
    /// value and how many bytes it occupied. Always returns a nonzero length
    /// when `pos < bytes.len()`, so a caller looping over the result cannot
    /// spin on an unmapped code.
    pub fn read_code(&self, bytes: &[u8], pos: usize) -> (u32, usize) {
        let avail = bytes.len().saturating_sub(pos);
        if avail == 0 {
            return (0, 0);
        }

        let mut best: Option<(u32, usize)> = None;
        for cs in &self.codespaces {
            let len = cs.len as usize;
            if len == 0 || len > avail {
                continue;
            }
            let value = be_int(&bytes[pos..pos + len]);
            if value >= cs.lo && value <= cs.hi {
                // Longest match wins: a 2-byte range and a 1-byte range can
                // both claim a leading 0x00 byte.
                if best.map_or(true, |(_, best_len)| len > best_len) {
                    best = Some((value, len));
                }
            }
        }
        if let Some(found) = best {
            return found;
        }

        // Nothing claimed it — fall back to the font's default code width.
        let len = (self.default_len as usize).min(avail).max(1);
        (be_int(&bytes[pos..pos + len]), len)
    }

    fn insert(&mut self, code: u32, value: String) {
        if self.map.len() < MAX_MAP_ENTRIES && !value.is_empty() {
            self.map.insert(code, value);
        }
    }

    fn read_codespace_range(&mut self, tokens: &[Token], mut i: usize) -> usize {
        let mut malformed = 0;
        while i < tokens.len() && malformed < MAX_MALFORMED_IN_BLOCK {
            if is_end_keyword(&tokens[i], b"endcodespacerange") {
                return i + 1;
            }
            match (tokens.get(i), tokens.get(i + 1)) {
                (Some(Token::Str(lo)), Some(Token::Str(hi))) => {
                    let len = lo.len().min(4) as u8;
                    if len > 0 {
                        self.codespaces.push(CodeSpace {
                            lo: be_int(lo),
                            hi: be_int(hi),
                            len,
                        });
                    }
                    i += 2;
                }
                _ => {
                    i += 1;
                    malformed += 1;
                }
            }
        }
        i
    }

    fn read_bfchar(&mut self, tokens: &[Token], mut i: usize) -> usize {
        let mut malformed = 0;
        while i < tokens.len() && malformed < MAX_MALFORMED_IN_BLOCK {
            if is_end_keyword(&tokens[i], b"endbfchar") {
                return i + 1;
            }
            match (tokens.get(i), tokens.get(i + 1)) {
                (Some(Token::Str(src)), Some(Token::Str(dst))) => {
                    let value = utf16be_to_string(dst);
                    self.insert(be_int(src), value);
                    i += 2;
                }
                _ => {
                    i += 1;
                    malformed += 1;
                }
            }
        }
        i
    }

    fn read_bfrange(&mut self, tokens: &[Token], mut i: usize) -> usize {
        let mut malformed = 0;
        while i < tokens.len() && malformed < MAX_MALFORMED_IN_BLOCK {
            if is_end_keyword(&tokens[i], b"endbfrange") {
                return i + 1;
            }

            let (lo, hi, dst_start) = match (tokens.get(i), tokens.get(i + 1)) {
                (Some(Token::Str(lo)), Some(Token::Str(hi))) => {
                    (be_int(lo), be_int(hi), i + 2)
                }
                _ => {
                    i += 1;
                    malformed += 1;
                    continue;
                }
            };
            if hi < lo {
                i = dst_start;
                malformed += 1;
                continue;
            }

            match tokens.get(dst_start) {
                // Form 1: a single destination; successive codes increment it.
                Some(Token::Str(dst)) => {
                    let span = hi - lo;
                    if span <= MAX_BFRANGE_SPAN {
                        for k in 0..=span {
                            if self.map.len() >= MAX_MAP_ENTRIES {
                                break;
                            }
                            let value = increment_utf16be(dst, k);
                            self.insert(lo.wrapping_add(k), value);
                        }
                    }
                    i = dst_start + 1;
                }
                // Form 2: an explicit destination per code.
                Some(Token::ArrayOpen) => {
                    let mut j = dst_start + 1;
                    let mut k: u32 = 0;
                    while j < tokens.len() {
                        match &tokens[j] {
                            Token::Str(dst) => {
                                let value = utf16be_to_string(dst);
                                if lo.wrapping_add(k) <= hi {
                                    self.insert(lo.wrapping_add(k), value);
                                }
                                k = k.saturating_add(1);
                                j += 1;
                            }
                            Token::ArrayClose => {
                                j += 1;
                                break;
                            }
                            _ => {
                                j += 1;
                                malformed += 1;
                                if malformed >= MAX_MALFORMED_IN_BLOCK {
                                    break;
                                }
                            }
                        }
                    }
                    i = j;
                }
                _ => {
                    i = dst_start;
                    malformed += 1;
                }
            }
        }
        i
    }
}

fn is_end_keyword(token: &Token, name: &[u8]) -> bool {
    matches!(token, Token::Keyword(k) if *k == name)
}

/// Big-endian byte string → integer. More than 4 bytes (only reachable from a
/// malformed CMap) keeps the leading four.
fn be_int(bytes: &[u8]) -> u32 {
    let mut value: u32 = 0;
    for &b in bytes.iter().take(4) {
        value = (value << 8) | b as u32;
    }
    value
}

/// Decode a big-endian UTF-16 byte string into text, pairing surrogates.
/// Unpaired surrogates are dropped, as are NUL and control characters — a
/// `/ToUnicode` destination of `<0000>` means "no glyph", not a real U+0000.
pub(crate) fn utf16be_to_string(bytes: &[u8]) -> String {
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|c| u16::from_be_bytes([c[0], c[1]]))
        .collect();

    let mut out = String::with_capacity(units.len());
    for decoded in char::decode_utf16(units) {
        if let Ok(ch) = decoded {
            if ch != '\0' && (ch >= ' ' || ch == '\t' || ch == '\n' || ch == '\r') {
                out.push(ch);
            }
        }
    }
    out
}

/// The destination of a `bfrange` entry for the code `base + offset`.
///
/// For up to four destination bytes the whole value is incremented, which is
/// exactly the spec's behaviour: `<D840DC00> + 1` is `<D840DC01>`, a valid
/// next code point in the supplementary plane. Longer destinations map one
/// code to several code points (a ligature); incrementing the whole string
/// would corrupt the earlier ones, so only the final code unit moves.
fn increment_utf16be(base: &[u8], offset: u32) -> String {
    if base.len() <= 4 {
        let value = be_int(base).wrapping_add(offset);
        let bytes = value.to_be_bytes();
        utf16be_to_string(&bytes[4 - base.len()..])
    } else {
        let mut bytes = base.to_vec();
        let last = bytes.len() - 2;
        let value =
            u16::from_be_bytes([bytes[last], bytes[last + 1]]).wrapping_add(offset as u16);
        bytes[last..].copy_from_slice(&value.to_be_bytes());
        utf16be_to_string(&bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const IDENTITY_H_CMAP: &[u8] = b"\
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
2 beginbfchar
<4E2D> <4E2D>
<6587> <6587>
endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end";

    #[test]
    fn parses_a_typical_identity_h_cmap() {
        let cmap = CMap::parse(IDENTITY_H_CMAP, 2);
        assert_eq!(cmap.get(0x4E2D), Some("中"));
        assert_eq!(cmap.get(0x6587), Some("文"));
        assert_eq!(cmap.len(), 2);
    }

    #[test]
    fn decodes_a_two_byte_cid_string() {
        let cmap = CMap::parse(IDENTITY_H_CMAP, 2);
        let mut out = String::new();
        let mut i = 0;
        let bytes = [0x4Eu8, 0x2D, 0x65, 0x87];
        while i < bytes.len() {
            let (code, len) = cmap.read_code(&bytes, i);
            if len == 0 {
                break;
            }
            if let Some(s) = cmap.get(code) {
                out.push_str(s);
            }
            i += len;
        }
        assert_eq!(out, "中文");
    }

    #[test]
    fn bfchar_destination_may_be_several_code_points() {
        let cmap = CMap::parse(b"1 beginbfchar <01> <0041 0042> endbfchar", 1);
        assert_eq!(cmap.get(1), Some("AB"));
    }

    #[test]
    fn bfrange_increments_a_bmp_destination() {
        // U+4E00 一, U+4E01 丁, U+4E02 丂 — consecutive code points.
        let cmap = CMap::parse(b"1 beginbfrange <0001> <0003> <4E00> endbfrange", 2);
        assert_eq!(cmap.get(1), Some("一"));
        assert_eq!(cmap.get(2), Some("丁"));
        assert_eq!(cmap.get(3), Some("丂"));
    }

    #[test]
    fn bfrange_increments_across_a_surrogate_pair() {
        // U+20000 (𠀀) and U+20001: D840 DC00 -> D840 DC01.
        let cmap = CMap::parse(b"1 beginbfrange <0001> <0003> <D840DC00> endbfrange", 2);
        assert_eq!(cmap.get(1), Some("\u{20000}"));
        assert_eq!(cmap.get(2), Some("\u{20001}"));
        assert_eq!(cmap.get(3), Some("\u{20002}"));
    }

    #[test]
    fn bfrange_array_form_maps_each_code_explicitly() {
        let cmap = CMap::parse(b"1 beginbfrange <10> <12> [<4E00> <4E01> <4E02>] endbfrange", 1);
        assert_eq!(cmap.get(0x10), Some("一"));
        assert_eq!(cmap.get(0x11), Some("丁"));
        assert_eq!(cmap.get(0x12), Some("丂"));
    }

    #[test]
    fn codespace_decides_the_code_width() {
        let cmap = CMap::parse(
            b"1 begincodespacerange <00> <FF> endcodespacerange 1 beginbfchar <41> <0041> endbfchar",
            2,
        );
        // The 1-byte codespace overrides the 2-byte default.
        assert_eq!(cmap.read_code(b"A\x00", 0), (0x41, 1));
    }

    #[test]
    fn unmapped_codes_are_skipped_but_still_advance() {
        let cmap = CMap::parse(b"1 begincodespacerange <0000> <FFFF> endcodespacerange", 2);
        // No mappings at all: read_code must still return a nonzero length or
        // the caller loops forever.
        let (_, len) = cmap.read_code(&[0xAB, 0xCD], 0);
        assert_eq!(len, 2);
    }

    #[test]
    fn a_truncated_block_does_not_swallow_the_stream() {
        // No endbfchar: parsing must stop at the malformed-token cap.
        let cmap = CMap::parse(b"1 beginbfchar <01> <4E2D> ] ] ] ] ] ] ] ] ] ] ] ]", 1);
        assert_eq!(cmap.get(1), Some("中"));
    }

    #[test]
    fn a_hostile_range_is_clamped_instead_of_hanging() {
        let cmap = CMap::parse(b"1 beginbfrange <00000000> <FFFFFFFF> <00000000> endbfrange", 2);
        // The point is that this test finishes at all.
        assert!(cmap.len() <= MAX_MAP_ENTRIES);
    }

    #[test]
    fn usecmap_is_ignored_without_panicking() {
        let cmap = CMap::parse(b"/UniGB-UCS2-H usecmap 1 beginbfchar <01> <4E2D> endbfchar", 2);
        assert_eq!(cmap.get(1), Some("中"));
    }

    #[test]
    fn nul_and_control_destinations_are_dropped() {
        let cmap = CMap::parse(b"2 beginbfchar <01> <0000> <02> <0007> endbfchar", 1);
        assert!(cmap.get(1).is_none());
        assert!(cmap.get(2).is_none());
    }

    #[test]
    fn unpaired_surrogates_do_not_become_replacement_characters() {
        assert_eq!(utf16be_to_string(&[0xD8, 0x40]), "");
        assert_eq!(utf16be_to_string(&[0x00, 0x41]), "A");
    }
}
