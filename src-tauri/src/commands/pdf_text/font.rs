//! Per-font decoding: turning the bytes in a `Tj` string into characters.
//!
//! The strategy, in priority order:
//!
//! 1. `/ToUnicode` present → use it. This is the only reliable source for
//!    subset fonts and CID fonts, and covers the overwhelming majority of
//!    Chinese PDFs.
//! 2. No `/ToUnicode`, but a CID font with `/Identity-H` → the codes are
//!    assumed to be UTF-16BE code units. Producers that subset without
//!    emitting a ToUnicode table usually still lay the text out this way.
//! 3. Simple font with no `/ToUnicode` → fall back to the base encoding
//!    (`/WinAnsiEncoding`, `/MacRomanEncoding`, …) plus `/Differences`.
//! 4. Anything else (Type3, Symbol, custom encodings) → undecodable, counted
//!    so the caller can tell the user *why* a PDF came back empty.

use std::collections::HashMap;
use std::sync::Arc;

use lopdf::{Dictionary, Document, Object, ObjectId};

use super::cmap::{CMap, DecodeStat};
use super::stream_bytes;

/// Fonts are cached across pages. Keying by the resolved object id — not by
/// the resource name (`/F1` means different things on different pages) — is
/// what makes a 500-page book cheap instead of quadratic.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub(crate) enum FontKey {
    Indirect(ObjectId),
    Inline(usize),
}

pub(crate) struct FontResource<'a> {
    pub name: Vec<u8>,
    pub key: FontKey,
    pub dict: &'a Dictionary,
}

/// Fonts named by a page's `/Resources`, following inheritance from the page
/// tree. Page-local entries win, matching lopdf's `get_page_fonts`.
///
/// Deliberately not `Document::get_page_fonts` (document.rs:444): that
/// dereferences the font dict before returning it, discarding the object id we
/// need as a cache key.
pub(crate) fn page_fonts<'a>(doc: &'a Document, page_id: ObjectId) -> Vec<FontResource<'a>> {
    let (own_resources, inherited_ids) = doc.get_page_resources(page_id);

    let mut sources: Vec<&'a Dictionary> = Vec::new();
    if let Some(dict) = own_resources {
        sources.push(dict);
    }
    for id in inherited_ids {
        // The page's own /Resources reference also lands in this list; a
        // duplicate is harmless because `seen` below filters by name.
        if let Ok(dict) = doc.get_dictionary(id) {
            sources.push(dict);
        }
    }

    let mut out: Vec<FontResource<'a>> = Vec::new();
    let mut seen: Vec<Vec<u8>> = Vec::new();

    for resources in sources {
        let font_dict = match resources.get(b"Font") {
            Ok(Object::Reference(id)) => match doc.get_dictionary(*id) {
                Ok(dict) => dict,
                Err(_) => continue,
            },
            Ok(Object::Dictionary(dict)) => dict,
            _ => continue,
        };

        for (name, value) in font_dict.iter() {
            if seen.iter().any(|n| n == name) {
                continue;
            }
            match value {
                Object::Reference(id) => {
                    if let Ok(dict) = doc.get_dictionary(*id) {
                        seen.push(name.clone());
                        out.push(FontResource {
                            name: name.clone(),
                            key: FontKey::Indirect(*id),
                            dict,
                        });
                    }
                }
                Object::Dictionary(dict) => {
                    // Address is stable and unique for the lifetime of the
                    // document, which is not mutated during extraction.
                    seen.push(name.clone());
                    out.push(FontResource {
                        name: name.clone(),
                        key: FontKey::Inline(dict as *const Dictionary as usize),
                        dict,
                    });
                }
                _ => {}
            }
        }
    }

    out
}

enum FontKind {
    /// A `/ToUnicode` CMap, optionally with the base encoding as a fallback
    /// for bytes the CMap does not cover (partial tables are common).
    Cmap {
        cmap: Arc<CMap>,
        fallback: Option<SimpleBase>,
    },
    Simple(SimpleBase),
    IdentityUtf16,
    Undecodable,
}

struct SimpleBase {
    /// `None` means StandardEncoding, exactly as lopdf's
    /// `Dictionary::get_font_encoding` (object.rs:356) defaults.
    base: Option<String>,
    differences: HashMap<u8, char>,
}

pub(crate) struct FontDecoder {
    kind: FontKind,
    pub has_tounicode: bool,
    pub vertical: bool,
}

impl FontDecoder {
    pub fn decode(&self, bytes: &[u8], out: &mut String, stat: &mut DecodeStat) {
        match &self.kind {
            FontKind::Cmap { cmap, fallback } => {
                let mut i = 0;
                while i < bytes.len() {
                    let (code, len) = cmap.read_code(bytes, i);
                    if len == 0 {
                        break;
                    }
                    match cmap.get(code) {
                        Some(text) => {
                            out.push_str(text);
                            stat.mapped += 1;
                            i += len;
                        }
                        None => {
                            // Single-byte codes in a simple font still have a
                            // base encoding to fall back on. Two-byte codes are
                            // glyph ids with no such meaning.
                            if len == 1 {
                                if let Some(fallback) = fallback {
                                    push_simple(fallback, bytes[i], out);
                                    stat.mapped += 1;
                                    i += 1;
                                    continue;
                                }
                            }
                            stat.unmapped += 1;
                            i += len;
                        }
                    }
                }
            }
            FontKind::Simple(base) => {
                for &b in bytes {
                    push_simple(base, b, out);
                }
                stat.mapped += bytes.len();
            }
            FontKind::IdentityUtf16 => {
                let text = super::cmap::utf16be_to_string(bytes);
                stat.mapped += text.chars().count();
                out.push_str(&text);
            }
            FontKind::Undecodable => {
                stat.unmapped += bytes.len();
            }
        }
    }
}

fn push_simple(base: &SimpleBase, byte: u8, out: &mut String) {
    if let Some(&ch) = base.differences.get(&byte) {
        out.push(ch);
        return;
    }
    out.push_str(&Document::decode_text(base.base.as_deref(), &[byte]));
}

/// A decoder backed by a hand-built CMap, for tests in sibling modules that
/// need a font without assembling a whole PDF.
#[cfg(test)]
pub(crate) fn test_decoder(cmap: CMap, vertical: bool) -> FontDecoder {
    FontDecoder {
        kind: FontKind::Cmap {
            cmap: Arc::new(cmap),
            fallback: None,
        },
        has_tounicode: true,
        vertical,
    }
}

pub(crate) struct FontCache {
    by_key: HashMap<FontKey, Arc<FontDecoder>>,
    /// Several font dicts frequently share one ToUnicode stream.
    by_cmap: HashMap<ObjectId, Arc<CMap>>,
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct FontStats {
    pub total: usize,
    pub with_tounicode: usize,
    pub undecodable: usize,
    pub vertical: usize,
}

impl FontCache {
    pub fn new() -> Self {
        Self {
            by_key: HashMap::new(),
            by_cmap: HashMap::new(),
        }
    }

    pub fn get(&mut self, doc: &Document, resource: &FontResource) -> Arc<FontDecoder> {
        if let Some(cached) = self.by_key.get(&resource.key) {
            return cached.clone();
        }
        let decoder = Arc::new(self.build(doc, resource.dict));
        self.by_key.insert(resource.key, decoder.clone());
        decoder
    }

    pub fn stats(&self) -> FontStats {
        let mut stats = FontStats {
            total: self.by_key.len(),
            ..Default::default()
        };
        for font in self.by_key.values() {
            if font.has_tounicode {
                stats.with_tounicode += 1;
            }
            if matches!(font.kind, FontKind::Undecodable) {
                stats.undecodable += 1;
            }
            if font.vertical {
                stats.vertical += 1;
            }
        }
        stats
    }

    fn build(&mut self, doc: &Document, dict: &Dictionary) -> FontDecoder {
        let subtype = dict
            .get(b"Subtype")
            .and_then(Object::as_name_str)
            .unwrap_or("");
        let is_type0 = subtype == "Type0";
        // CID fonts address glyphs with two-byte codes; simple fonts with one.
        let default_len = if is_type0 { 2 } else { 1 };
        let vertical = is_vertical(doc, dict);

        if let Some(cmap) = self.tounicode(doc, dict, default_len) {
            let fallback = if is_type0 {
                None
            } else {
                Some(simple_base(dict))
            };
            return FontDecoder {
                kind: FontKind::Cmap { cmap, fallback },
                has_tounicode: true,
                vertical,
            };
        }

        if is_type0 {
            return match encoding_name(dict).as_deref() {
                // `/UniGB-UCS2-H` is included because, as in lopdf's own
                // mapping (document.rs:519), the string bytes are already
                // UCS-2 — the CMap name describes the code space, and the
                // codes are Unicode.
                Some("Identity-H") | Some("Identity-V") | Some("UniGB-UCS2-H")
                | Some("UniGB-UTF16-H") => FontDecoder {
                    kind: FontKind::IdentityUtf16,
                    has_tounicode: false,
                    vertical,
                },
                _ => FontDecoder {
                    kind: FontKind::Undecodable,
                    has_tounicode: false,
                    vertical,
                },
            };
        }

        FontDecoder {
            kind: FontKind::Simple(simple_base(dict)),
            has_tounicode: false,
            vertical,
        }
    }

    /// Parse the font's `/ToUnicode` stream, reusing a previously parsed CMap
    /// when the same stream is shared.
    fn tounicode(
        &mut self,
        doc: &Document,
        dict: &Dictionary,
        default_len: u8,
    ) -> Option<Arc<CMap>> {
        let object = dict.get(b"ToUnicode").ok()?;

        // Remember the stream's object id so the parsed CMap can be shared.
        let cache_key = object.as_reference().ok();
        if let Some(id) = cache_key {
            if let Some(cached) = self.by_cmap.get(&id) {
                return Some(cached.clone());
            }
        }

        let stream = match object {
            Object::Reference(id) => doc.get_object(*id).and_then(Object::as_stream).ok(),
            Object::Stream(stream) => Some(stream),
            _ => None,
        }?;
        let data = stream_bytes(stream)?;

        let cmap = Arc::new(CMap::parse(&data, default_len));
        if let Some(id) = cache_key {
            self.by_cmap.insert(id, cmap.clone());
        }
        Some(cmap)
    }
}

/// `/Encoding` as a name, or the `/BaseEncoding` of a dictionary-form
/// `/Encoding`. lopdf's `get_font_encoding` only handles the name form and
/// silently reports StandardEncoding for the dictionary form.
fn encoding_name(dict: &Dictionary) -> Option<String> {
    match dict.get(b"Encoding") {
        Ok(Object::Name(name)) => Some(String::from_utf8_lossy(name).to_string()),
        Ok(Object::Dictionary(encoding)) => match encoding.get(b"BaseEncoding") {
            Ok(Object::Name(name)) => Some(String::from_utf8_lossy(name).to_string()),
            _ => None,
        },
        _ => None,
    }
}

fn simple_base(dict: &Dictionary) -> SimpleBase {
    let mut base = None;
    let mut differences = HashMap::new();

    match dict.get(b"Encoding") {
        Ok(Object::Name(name)) => base = Some(String::from_utf8_lossy(name).to_string()),
        Ok(Object::Dictionary(encoding)) => {
            if let Ok(Object::Name(name)) = encoding.get(b"BaseEncoding") {
                base = Some(String::from_utf8_lossy(name).to_string());
            }
            if let Ok(Object::Array(items)) = encoding.get(b"Differences") {
                let mut code: u32 = 0;
                for item in items {
                    match item {
                        Object::Integer(n) => code = (*n).max(0) as u32,
                        Object::Name(name) => {
                            if code <= 255 {
                                if let Some(ch) = glyph_name_to_char(name) {
                                    differences.insert(code as u8, ch);
                                }
                            }
                            code = code.saturating_add(1);
                        }
                        _ => {}
                    }
                }
            }
        }
        _ => {}
    }

    SimpleBase { base, differences }
}

/// Only `uniXXXX` and single-character names are resolved. The full Adobe
/// Glyph List lives in lopdf's private `encodings` module and is not worth
/// copying for the handful of PDFs that need it.
fn glyph_name_to_char(name: &[u8]) -> Option<char> {
    if name.len() == 1 && name[0].is_ascii_graphic() {
        return Some(name[0] as char);
    }
    if name.len() == 7 && name.starts_with(b"uni") {
        let hex = std::str::from_utf8(&name[3..]).ok()?;
        return char::from_u32(u32::from_str_radix(hex, 16).ok()?);
    }
    None
}

/// `/WMode 1` on the font or its descendant marks a vertical-writing run, for
/// which the baseline-y line heuristic in the walker is meaningless.
fn is_vertical(doc: &Document, dict: &Dictionary) -> bool {
    if dict.get(b"WMode").and_then(Object::as_i64).ok() == Some(1) {
        return true;
    }
    if let Ok(Object::Array(descendants)) = dict.get(b"DescendantFonts") {
        if let Some(first) = descendants.first() {
            let descendant = match first {
                Object::Reference(id) => doc.get_dictionary(*id).ok(),
                Object::Dictionary(dict) => Some(dict),
                _ => None,
            };
            if let Some(descendant) = descendant {
                if descendant.get(b"WMode").and_then(Object::as_i64).ok() == Some(1) {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glyph_names_resolve_uni_and_single_characters() {
        assert_eq!(glyph_name_to_char(b"A"), Some('A'));
        assert_eq!(glyph_name_to_char(b"uni4E2D"), Some('中'));
        assert_eq!(glyph_name_to_char(b"bullet"), None);
    }

    #[test]
    fn encoding_dictionary_base_is_read() {
        let mut encoding = Dictionary::new();
        encoding.set(b"BaseEncoding", Object::Name(b"WinAnsiEncoding".to_vec()));
        let mut dict = Dictionary::new();
        dict.set(b"Encoding", Object::Dictionary(encoding));
        assert_eq!(encoding_name(&dict).as_deref(), Some("WinAnsiEncoding"));
    }

    #[test]
    fn differences_override_the_base_encoding() {
        let mut encoding = Dictionary::new();
        encoding.set(b"BaseEncoding", Object::Name(b"WinAnsiEncoding".to_vec()));
        encoding.set(
            b"Differences",
            Object::Array(vec![
                Object::Integer(65),
                Object::Name(b"uni4E2D".to_vec()),
            ]),
        );
        let mut dict = Dictionary::new();
        dict.set(b"Encoding", Object::Dictionary(encoding));

        let base = simple_base(&dict);
        let mut out = String::new();
        push_simple(&base, 65, &mut out);
        assert_eq!(out, "中");
        // A byte outside the Differences still follows the base encoding.
        out.clear();
        push_simple(&base, 66, &mut out);
        assert_eq!(out, "B");
    }
}
