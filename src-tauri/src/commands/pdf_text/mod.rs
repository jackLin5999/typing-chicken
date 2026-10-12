//! PDF text extraction that understands CJK fonts.
//!
//! Why this exists: `lopdf::Document::extract_text` resolves a font's encoding
//! through `Document::decode_text` (document.rs:514), which knows four
//! Latin-1 style tables and returns the literal string
//! `"?Identity-H Unimplemented?"` for `/Identity-H` — the encoding every
//! CID-keyed Chinese font uses. It also never reads a font's `/ToUnicode`
//! map, which is the *only* thing that can turn glyph indices back into
//! characters. The result was that a Chinese PDF imported as zero characters
//! (see the module docs on `cmap.rs`), and `split_into_chapters` then produced
//! one empty "Full Text" chapter with no error anywhere.
//!
//! The other reason for a bespoke walker: `Content::decode` parses a page's
//! operators with a nom grammar that has no `BI`/`ID`/`EI` inline-image rule
//! (nom_parser.rs:488), and `strip_nom` discards the unparsed remainder
//! instead of failing — so a page containing an inline image silently loses
//! every operator after it.
//!
//! Scope: this recovers a *text layer*. A scanned PDF (pages that are nothing
//! but a JPEG) has no text layer to recover, and this module says so
//! explicitly rather than importing an empty book.

mod cmap;
mod font;
mod lexer;
mod walker;

use std::sync::Arc;

use lopdf::{Document, Object, Stream};

use font::{FontCache, FontDecoder};

/// Backstop against a pathological document inflating the chapter text until
/// the app runs out of memory.
const MAX_OUTPUT_BYTES: usize = 32 * 1024 * 1024;

#[derive(Debug, Default, Clone)]
pub struct ExtractionStats {
    pub pages_total: usize,
    pub pages_with_text: usize,
    pub pages_skipped: usize,
    /// `Tj`/`TJ`/`'`/`"` operators seen, whether or not they decoded. This is
    /// what separates "the page has no text at all, it is a scan" from "the
    /// page draws text but we cannot decode it".
    pub text_show_ops: usize,
    pub mapped_codes: usize,
    pub unmapped_codes: usize,
    pub image_xobjects: usize,
    pub fonts_total: usize,
    pub fonts_with_tounicode: usize,
    pub fonts_undecodable: usize,
    pub vertical_fonts: usize,
}

#[derive(Debug)]
pub enum PdfTextError {
    Parse(String),
    Encrypted,
    /// No text operators anywhere, but the file does contain images — the
    /// signature of a scanned book.
    NoTextLayer { pages: usize, images: usize },
    /// No text operators and no images either.
    NoTextFound,
    /// Text operators present, but every code was unmappable — a font with no
    /// usable `/ToUnicode` table.
    Undecodable { text_ops: usize, unmapped: usize },
}

impl PdfTextError {
    /// Stable prefix so the UI can branch on the reason without parsing prose.
    pub fn code(&self) -> &'static str {
        match self {
            PdfTextError::Parse(_) => "PDF_PARSE",
            PdfTextError::Encrypted => "PDF_ENCRYPTED",
            PdfTextError::NoTextLayer { .. } => "PDF_SCANNED",
            PdfTextError::NoTextFound => "PDF_EMPTY",
            PdfTextError::Undecodable { .. } => "PDF_UNDECODABLE",
        }
    }

    pub fn user_message(&self) -> String {
        match self {
            PdfTextError::Parse(detail) => format!("PDF 文件损坏或无法解析（{}）。", detail),
            PdfTextError::Encrypted => {
                "这个 PDF 已加密，无法读取其中的文字。".to_string()
            }
            PdfTextError::NoTextLayer { pages, images } => format!(
                "这个 PDF 是扫描版：{} 页全部是图片（共 {} 张），没有文字层，需要 OCR 才能提取文字。",
                pages, images
            ),
            PdfTextError::NoTextFound => {
                "这个 PDF 里没有任何文字内容。".to_string()
            }
            PdfTextError::Undecodable {
                text_ops,
                unmapped,
            } => format!(
                "这个 PDF 含有文字，但字体缺少 Unicode 映射表，无法还原成可读的字符（{} 处文字、{} 个字符无法识别）。",
                text_ops, unmapped
            ),
        }
    }
}

#[derive(Debug)]
pub struct PdfExtraction {
    pub text: String,
    /// Extraction diagnostics — ToUnicode coverage, unmapped codes, skipped
    /// pages. The production path only needs `text`, so this is compiled in
    /// for the tests that pin down *why* a PDF decoded the way it did.
    #[cfg(test)]
    pub stats: ExtractionStats,
}

/// Read a stream's bytes, decompressing when it has a filter.
///
/// `Stream::decompressed_content` (object.rs:574) returns `Err(DictKey)` for a
/// stream with no `/Filter`, so an unfiltered content stream — which every
/// hand-built test fixture has — must take the raw bytes instead.
pub(crate) fn stream_bytes(stream: &Stream) -> Option<Vec<u8>> {
    if stream.dict.has(b"Filter") {
        stream.decompressed_content().ok()
    } else {
        Some(stream.content.clone())
    }
}

/// Characters that set their own width, so a gap next to one of them is
/// layout rather than a word break.
///
/// Deliberately separate from `parser.rs`'s `is_cjk`: that one is a GB18030
/// plausibility test, and widening it to include CJK punctuation would make
/// Latin text containing a full-width comma look like valid GB18030 and break
/// TXT import.
pub(crate) fn is_wide_cjk(c: char) -> bool {
    matches!(c as u32,
        0x2E80..=0x303F   // radicals, Kangxi, CJK punctuation
        | 0x3040..=0x33FF // kana, compatibility
        | 0x3400..=0x4DBF // extension A
        | 0x4E00..=0x9FFF // unified ideographs
        | 0xA000..=0xA4CF // Yi
        | 0xAC00..=0xD7FF // hangul
        | 0xF900..=0xFAFF // compatibility ideographs
        | 0xFE30..=0xFE4F // compatibility forms
        | 0xFF00..=0xFF60 // fullwidth forms
        | 0xFFE0..=0xFFE6
        | 0x20000..=0x3FFFF) // extensions B and beyond
}

/// Extract all text from a PDF held in memory.
///
/// Takes bytes rather than a path so the extractor is exercisable from
/// in-memory fixtures with no file I/O.
pub fn extract_pdf_text_from_bytes(bytes: &[u8]) -> Result<PdfExtraction, PdfTextError> {
    let mut doc = Document::load_mem(bytes).map_err(|e| PdfTextError::Parse(e.to_string()))?;

    // An encrypted document otherwise yields decrypted-looking garbage rather
    // than an error. An empty user password is common on downloaded PDFs, so
    // try that once before giving up. (lopdf only implements RC4 revisions
    // 2–3 — encryption.rs:96 — so AES files land in the error branch.)
    if doc.is_encrypted() && doc.decrypt("").is_err() {
        return Err(PdfTextError::Encrypted);
    }

    let mut stats = ExtractionStats {
        image_xobjects: count_image_xobjects(&doc),
        ..Default::default()
    };

    // Called once: `get_pages` rebuilds a map by walking the whole page tree,
    // so calling it per page — as `extract_text` does — is quadratic.
    let pages = doc.get_pages();
    stats.pages_total = pages.len();

    let mut cache = FontCache::new();
    let mut out = String::new();

    for page_id in pages.values() {
        let resources = font::page_fonts(&doc, *page_id);
        let mut fonts: Vec<(Vec<u8>, Arc<FontDecoder>)> = Vec::with_capacity(resources.len());
        for resource in &resources {
            let decoder = cache.get(&doc, resource);
            fonts.push((resource.name.clone(), decoder));
        }

        let mut page_text = String::new();
        let mut skipped = false;
        for content_id in doc.get_page_contents(*page_id) {
            let stream = match doc.get_object(content_id).and_then(Object::as_stream) {
                Ok(stream) => stream,
                Err(_) => continue,
            };
            match stream_bytes(stream) {
                Some(data) => {
                    let text = walker::walk_page(&data, &fonts, &mut stats);
                    if !text.is_empty() {
                        if !page_text.is_empty() && !page_text.ends_with('\n') {
                            page_text.push('\n');
                        }
                        page_text.push_str(&text);
                    }
                }
                // An unsupported filter: do not feed compressed bytes to the
                // lexer, they would decode to noise.
                None => skipped = true,
            }
        }

        if skipped {
            stats.pages_skipped += 1;
        }
        if !page_text.trim().is_empty() {
            stats.pages_with_text += 1;
        }
        if !page_text.is_empty() {
            if !out.is_empty() && !out.ends_with('\n') {
                out.push('\n');
            }
            out.push_str(&page_text);
        }

        if out.len() >= MAX_OUTPUT_BYTES {
            break;
        }
    }

    let fonts = cache.stats();
    stats.fonts_total = fonts.total;
    stats.fonts_with_tounicode = fonts.with_tounicode;
    stats.fonts_undecodable = fonts.undecodable;
    stats.vertical_fonts = fonts.vertical;

    if stats.text_show_ops == 0 {
        return Err(if stats.image_xobjects > 0 {
            PdfTextError::NoTextLayer {
                pages: stats.pages_total,
                images: stats.image_xobjects,
            }
        } else {
            PdfTextError::NoTextFound
        });
    }

    if out.trim().is_empty() {
        return Err(PdfTextError::Undecodable {
            text_ops: stats.text_show_ops,
            unmapped: stats.unmapped_codes,
        });
    }

    Ok(PdfExtraction {
        text: out,
        #[cfg(test)]
        stats,
    })
}

fn count_image_xobjects(doc: &Document) -> usize {
    doc.objects
        .values()
        .filter(|object| match object {
            Object::Stream(stream) => {
                stream.dict.get(b"Subtype").and_then(Object::as_name_str).ok() == Some("Image")
            }
            _ => false,
        })
        .count()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Assemble a PDF from `(id, body)` pairs, computing the xref offsets.
    ///
    /// Hand-writing byte offsets into a literal would fail silently: lopdf's
    /// xref reader drops entries it cannot resolve (reader.rs:203), so a
    /// mistyped offset shows up as "no text" rather than as a parse error.
    fn build_pdf(objects: &[(u32, Vec<u8>)], root_id: u32) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(b"%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");

        let mut offsets: Vec<(u32, usize)> = Vec::new();
        for (id, body) in objects {
            offsets.push((*id, out.len()));
            out.extend_from_slice(format!("{} 0 obj\n", id).as_bytes());
            out.extend_from_slice(body);
            out.extend_from_slice(b"\nendobj\n");
        }

        let max_id = objects.iter().map(|(id, _)| *id).max().unwrap_or(0);
        let xref_at = out.len();
        out.extend_from_slice(format!("xref\n0 {}\n", max_id + 1).as_bytes());
        out.extend_from_slice(b"0000000000 65535 f \n");
        for id in 1..=max_id {
            match offsets.iter().find(|(object_id, _)| *object_id == id) {
                Some((_, offset)) => {
                    out.extend_from_slice(format!("{:010} 00000 n \n", offset).as_bytes())
                }
                None => out.extend_from_slice(b"0000000000 00000 f \n"),
            }
        }
        out.extend_from_slice(
            format!(
                "trailer\n<< /Size {} /Root {} 0 R >>\nstartxref\n{}\n%%EOF\n",
                max_id + 1,
                root_id,
                xref_at
            )
            .as_bytes(),
        );
        out
    }

    fn stream_object(extra_dict: &str, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        out.extend_from_slice(
            format!("<< /Length {} {} >>\nstream\n", data.len(), extra_dict).as_bytes(),
        );
        out.extend_from_slice(data);
        out.extend_from_slice(b"\nendstream");
        out
    }

    fn page_object(font_id: Option<u32>, content_id: u32) -> Vec<u8> {
        let font_resources = match font_id {
            Some(id) => format!("/Font << /F1 {} 0 R >>", id),
            None => String::new(),
        };
        format!(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] \
             /Resources << {} >> /Contents {} 0 R >>",
            font_resources, content_id
        )
        .into_bytes()
    }

    /// A catalogue whose single page draws `content` with `font_objects`.
    fn document_with(
        font_objects: &[(u32, Vec<u8>)],
        content: &[u8],
        content_id: u32,
    ) -> Vec<u8> {
        let mut objects: Vec<(u32, Vec<u8>)> = vec![
            (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
            (
                2,
                b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec(),
            ),
            (
                3,
                page_object(font_objects.first().map(|(id, _)| *id), content_id),
            ),
            (content_id, stream_object("", content)),
        ];
        objects.extend_from_slice(font_objects);
        build_pdf(&objects, 1)
    }

    /// A `/Type0` font using `/Identity-H` plus a `/ToUnicode` CMap covering
    /// the given `(code, character)` pairs.
    fn identity_h_fonts(pairs: &[(u32, char)]) -> Vec<(u32, Vec<u8>)> {
        let mut cmap = String::from(
            "1 begincodespacerange <0000> <FFFF> endcodespacerange\n\
             beginbfchar\n",
        );
        for (code, ch) in pairs {
            cmap.push_str(&format!("<{:04X}> <{:04X}>\n", code, *ch as u32));
        }
        cmap.push_str("endbfchar\nendcmap");

        vec![
            (
                4,
                b"<< /Type /Font /Subtype /Type0 /BaseFont /Test \
                  /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 6 0 R >>"
                    .to_vec(),
            ),
            (
                5,
                b"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test \
                  /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> \
                  /DW 1000 >>"
                    .to_vec(),
            ),
            (6, stream_object("", cmap.as_bytes())),
        ]
    }

    #[test]
    fn the_fixture_builder_produces_a_loadable_pdf() {
        // De-risks the whole test strategy: if the xref offsets were wrong,
        // every other test in this module would fail for the wrong reason.
        let pdf = document_with(&[], b"BT ET", 7);
        let doc = Document::load_mem(&pdf).expect("fixture should load");
        assert_eq!(doc.get_pages().len(), 1);
    }

    #[test]
    fn identity_h_chinese_text_is_extracted() {
        let fonts = identity_h_fonts(&[(0x4E2D, '中'), (0x6587, '文')]);
        let pdf = document_with(&fonts, b"BT /F1 24 Tf 72 700 Td <4E2D6587> Tj ET", 7);
        let result = extract_pdf_text_from_bytes(&pdf).expect("should extract");
        assert_eq!(result.text, "中文");
        assert!(result.stats.fonts_with_tounicode >= 1);
        assert!(result.stats.mapped_codes >= 2);
    }

    #[test]
    fn a_simple_font_with_a_tounicode_table_is_extracted() {
        // The other real-world shape: subset TrueType with one-byte codes and
        // no Identity-H (this is what the user's 国际服务贸易 PDF uses).
        let cmap = b"1 begincodespacerange <00> <FF> endcodespacerange \
                     2 beginbfchar <41> <4E2D> <42> <6587> endbfchar endcmap";
        let fonts = vec![
            (
                4,
                b"<< /Type /Font /Subtype /TrueType /BaseFont /Test \
                  /FirstChar 65 /LastChar 66 /ToUnicode 6 0 R >>"
                    .to_vec(),
            ),
            (6, stream_object("", cmap)),
        ];
        let pdf = document_with(&fonts, b"BT /F1 12 Tf 72 700 Td (AB) Tj ET", 7);
        let result = extract_pdf_text_from_bytes(&pdf).expect("should extract");
        assert_eq!(result.text, "中文");
    }

    #[test]
    fn a_winansi_font_without_tounicode_still_decodes() {
        // The Latin regression guard: this is what worked before and must keep
        // working.
        let fonts = vec![(
            4,
            b"<< /Type /Font /Subtype /TrueType /BaseFont /Test \
              /Encoding /WinAnsiEncoding >>"
                .to_vec(),
        )];
        let pdf = document_with(&fonts, b"BT /F1 12 Tf 72 700 Td (Hello) Tj ET", 7);
        let result = extract_pdf_text_from_bytes(&pdf).expect("should extract");
        assert_eq!(result.text, "Hello");
    }

    #[test]
    fn winansi_matches_lopdfs_own_decoding_for_every_byte() {
        // Byte-for-byte parity with the path that previously handled these
        // files, so the new pipeline cannot silently drift.
        let all: Vec<u8> = (0..=255u8).collect();
        let expected: String = all
            .iter()
            .map(|b| Document::decode_text(Some("WinAnsiEncoding"), &[*b]))
            .collect();

        let fonts = vec![(
            4,
            b"<< /Type /Font /Subtype /TrueType /BaseFont /Test \
              /Encoding /WinAnsiEncoding >>"
                .to_vec(),
        )];
        let mut content = Vec::from(&b"BT /F1 12 Tf 72 700 Td ("[..]);
        for b in 0..=255u8 {
            match b {
                b'(' | b')' | b'\\' => {
                    content.push(b'\\');
                    content.push(b);
                }
                _ => content.push(b),
            }
        }
        content.extend_from_slice(b") Tj ET");

        let pdf = document_with(&fonts, &content, 7);
        let result = extract_pdf_text_from_bytes(&pdf).expect("should extract");
        assert_eq!(result.text, expected);
    }

    #[test]
    fn line_structure_survives_for_chapter_splitting() {
        let fonts = identity_h_fonts(&[
            (0x0001, '第'),
            (0x0002, '一'),
            (0x0003, '章'),
            (0x0004, '正'),
            (0x0005, '文'),
        ]);
        // Two lines: a heading and a body line. `Td` is relative.
        let content = b"BT /F1 24 Tf 72 700 Td <000100020003> Tj \
                        0 -28 Td <00040005> Tj ET";
        let pdf = document_with(&fonts, content, 7);
        let result = extract_pdf_text_from_bytes(&pdf).expect("should extract");
        assert_eq!(result.text, "第一章\n正文");
    }

    #[test]
    fn a_scanned_pdf_reports_the_missing_text_layer() {
        let image = stream_object(
            "/Type /XObject /Subtype /Image /Width 1 /Height 1 \
             /BitsPerComponent 8 /ColorSpace /DeviceGray",
            &[0x80],
        );
        let pdf = build_pdf(
            &[
                (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
                (2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_vec()),
                (3, page_object(None, 4)),
                (4, stream_object("", b"q 612 0 0 792 0 0 cm /Im1 Do Q")),
                (5, image),
            ],
            1,
        );
        match extract_pdf_text_from_bytes(&pdf) {
            Err(PdfTextError::NoTextLayer { pages, images }) => {
                assert_eq!(pages, 1);
                assert_eq!(images, 1);
            }
            other => panic!("expected NoTextLayer, got {:?}", other),
        }
    }

    #[test]
    fn a_pdf_with_neither_text_nor_images_reports_no_text() {
        let pdf = document_with(&[], b"q Q", 7);
        match extract_pdf_text_from_bytes(&pdf) {
            Err(PdfTextError::NoTextFound) => {}
            other => panic!("expected NoTextFound, got {:?}", other),
        }
    }

    #[test]
    fn text_with_no_usable_mapping_reports_undecodable() {
        // A font whose ToUnicode table does not cover the codes actually used.
        let fonts = identity_h_fonts(&[(0x4E2D, '中')]);
        let pdf = document_with(&fonts, b"BT /F1 24 Tf 72 700 Td <99999999> Tj ET", 7);
        match extract_pdf_text_from_bytes(&pdf) {
            Err(PdfTextError::Undecodable { text_ops, .. }) => assert_eq!(text_ops, 1),
            other => panic!("expected Undecodable, got {:?}", other),
        }
    }

    #[test]
    fn the_error_codes_are_stable_prefixes() {
        // The frontend keys off these strings; renaming one is a breaking
        // change, so pin them.
        assert_eq!(PdfTextError::Encrypted.code(), "PDF_ENCRYPTED");
        assert_eq!(
            PdfTextError::NoTextLayer { pages: 1, images: 1 }.code(),
            "PDF_SCANNED"
        );
        assert_eq!(PdfTextError::NoTextFound.code(), "PDF_EMPTY");
        assert_eq!(
            PdfTextError::Undecodable { text_ops: 1, unmapped: 1 }.code(),
            "PDF_UNDECODABLE"
        );
        assert_eq!(PdfTextError::Parse(String::new()).code(), "PDF_PARSE");
    }

    #[test]
    fn a_font_shared_between_pages_is_decoded_on_both() {
        let fonts = identity_h_fonts(&[(0x4E2D, '中')]);
        let mut objects: Vec<(u32, Vec<u8>)> = vec![
            (1, b"<< /Type /Catalog /Pages 2 0 R >>".to_vec()),
            (
                2,
                b"<< /Type /Pages /Kids [3 0 R 8 0 R] /Count 2 >>".to_vec(),
            ),
            (3, page_object(Some(4), 7)),
            (8, page_object(Some(4), 9)),
            (7, stream_object("", b"BT /F1 24 Tf 72 700 Td <4E2D> Tj ET")),
            (9, stream_object("", b"BT /F1 24 Tf 72 700 Td <4E2D> Tj ET")),
        ];
        objects.extend(fonts);
        let pdf = build_pdf(&objects, 1);

        let result = extract_pdf_text_from_bytes(&pdf).expect("should extract");
        assert_eq!(result.text, "中\n中");
        // One font object, cached across both pages.
        assert_eq!(result.stats.fonts_total, 1);
    }

    #[test]
    fn chapter_headings_round_trip_into_split_into_chapters() {
        use crate::commands::parser::split_into_chapters_for_test;

        let fonts = identity_h_fonts(&[
            (0x0001, '第'),
            (0x0002, '一'),
            (0x0003, '章'),
            (0x0004, '正'),
            (0x0005, '文'),
            (0x0006, '二'),
            (0x0007, '更'),
            (0x0008, '多'),
        ]);
        let content = b"BT /F1 24 Tf 72 700 Td <000100020003> Tj \
                        0 -28 Td <00040005> Tj \
                        0 -52 Td <000100060003> Tj \
                        0 -28 Td <00070008> Tj ET";
        let pdf = document_with(&fonts, content, 7);
        let text = extract_pdf_text_from_bytes(&pdf).expect("should extract").text;

        let chapters = split_into_chapters_for_test(&text);
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].title, "第一章");
        assert!(chapters[0].content.contains("正文"));
        assert_eq!(chapters[1].title, "第二章");
    }

    #[test]
    fn is_wide_cjk_covers_the_expected_ranges() {
        assert!(is_wide_cjk('中'));
        assert!(is_wide_cjk('、'));
        assert!(is_wide_cjk('，'));
        assert!(is_wide_cjk('あ'));
        assert!(is_wide_cjk('한'));
        assert!(!is_wide_cjk('A'));
        assert!(!is_wide_cjk('1'));
        assert!(!is_wide_cjk(' '));
    }

    /// Verification against real files. Gated on an environment variable so
    /// the default run never touches the machine's disk and no machine-specific
    /// path is ever committed:
    ///
    /// `DAZIJI_PDF_DIR='C:\path\to\pdfs' cargo test --no-default-features --lib -- --nocapture real_pdf_corpus`
    ///
    /// Scanned PDFs are expected to report `PDF_SCANNED` — that is the correct
    /// answer, not a failure.
    #[test]
    fn real_pdf_corpus() {
        let Ok(dir) = std::env::var("DAZIJI_PDF_DIR") else {
            return;
        };
        let entries = std::fs::read_dir(&dir).expect("DAZIJI_PDF_DIR should be readable");

        let mut checked = 0;
        for entry in entries.flatten() {
            let path = entry.path();
            let is_pdf = path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| e.eq_ignore_ascii_case("pdf"));
            if !is_pdf {
                continue;
            }

            let bytes = std::fs::read(&path).expect("pdf should be readable");
            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();

            match extract_pdf_text_from_bytes(&bytes) {
                Ok(result) => {
                    let stats = &result.stats;
                    println!(
                        "OK   {} | pages={} ops={} chars={} fonts={} tounicode={} undecodable={} vertical={} skipped={}",
                        name,
                        stats.pages_total,
                        stats.text_show_ops,
                        result.text.chars().count(),
                        stats.fonts_total,
                        stats.fonts_with_tounicode,
                        stats.fonts_undecodable,
                        stats.vertical_fonts,
                        stats.pages_skipped,
                    );
                    println!("     head: {}", head(&result.text, 80));
                    assert!(
                        !result.text.trim().is_empty(),
                        "{}: reported success with no text",
                        name
                    );
                    // The exact string lopdf used to produce for every CID font.
                    assert!(
                        !result.text.contains("Identity-H Unimplemented"),
                        "{}: leaked lopdf's placeholder",
                        name
                    );
                }
                Err(error) => {
                    println!("ERR  {} | {} {}", name, error.code(), error.user_message());
                }
            }
            checked += 1;
        }
        println!("checked {} PDF file(s) in {}", checked, dir);
    }

    fn head(text: &str, limit: usize) -> String {
        text.chars()
            .take(limit)
            .collect::<String>()
            .replace('\n', "\\n")
    }
}
