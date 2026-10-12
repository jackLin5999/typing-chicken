use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;

/// A chapter extracted from a parsed book, with TOC hierarchy info.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ParsedChapter {
    pub title: String,
    pub content: String,
    /// TOC depth: 0 = top-level, 1 = second-level, 2 = third-level, etc.
    pub level: usize,
}

/// Simplified TOC entry we can clone and pass around independently of EpubDoc.
#[derive(Clone)]
struct TocNode {
    label: String,
    content: String,
    children: Vec<TocNode>,
}

/// Convert an epub NavPoint tree into our cloneable TocNode tree.
fn convert_toc(navpoints: &[epub::doc::NavPoint]) -> Vec<TocNode> {
    navpoints
        .iter()
        .map(|np| TocNode {
            label: np.label.clone(),
            content: np.content.to_string_lossy().to_string(),
            children: convert_toc(&np.children),
        })
        .collect()
}

/// Extract the last path segment (filename) from a TOC content reference.
fn toc_filename(content: &str) -> &str {
    let without_fragment = content.split('#').next().unwrap_or(content);
    without_fragment
        .rsplit('/')
        .next()
        .unwrap_or(without_fragment)
}

/// Try to get content for a TOC reference, trying both by-ID and by-path.
fn fetch_content(book: &mut epub::doc::EpubDoc<std::io::Cursor<Vec<u8>>>, reference: &str, spine: &[String]) -> Option<Vec<u8>> {
    if let Ok(raw) = book
        .get_resource(reference)
        .or_else(|_| book.get_resource_by_path(reference))
    {
        return Some(raw);
    }

    let ref_key = toc_filename(reference);
    let matched_id = spine.iter().find(|sid| {
        let sid_key = sid.rsplit('/').next().unwrap_or(sid);
        sid_key == ref_key || sid.contains(ref_key) || ref_key.contains(sid_key)
    })?;

    book.get_resource(matched_id)
        .or_else(|_| book.get_resource_by_path(matched_id))
        .ok()
}

/// Recursively walk the TOC tree, collecting leaf chapters with their depth level.
fn walk_toc_nodes(
    book: &mut epub::doc::EpubDoc<std::io::Cursor<Vec<u8>>>,
    nodes: &[TocNode],
    spine: &[String],
    level: usize,
    chapters: &mut Vec<ParsedChapter>,
    image_map: Option<&HashMap<String, String>>,
) {
    for node in nodes {
        let label = node.label.trim().to_string();
        if label.is_empty() {
            continue;
        }

        if !node.children.is_empty() {
            // Section header with children — may have its own intro content
            let has_own_content = !node.content.is_empty()
                && node.content != "/"
                && !node.content.ends_with('/');

            if has_own_content {
                if let Some(raw) = fetch_content(book, &node.content, spine) {
                    let text = clean_html(&String::from_utf8_lossy(&raw), image_map);
                    if !text.trim().is_empty() {
                        chapters.push(ParsedChapter { title: label, content: text, level });
                    }
                }
            }

            walk_toc_nodes(book, &node.children, spine, level + 1, chapters, image_map);
        } else {
            // Leaf node = actual chapter content
            if node.content.is_empty() || node.content == "/" || node.content.ends_with('/') {
                continue;
            }

            if let Some(raw) = fetch_content(book, &node.content, spine) {
                let text = clean_html(&String::from_utf8_lossy(&raw), image_map);
                if !text.trim().is_empty() {
                    chapters.push(ParsedChapter { title: label, content: text, level });
                }
            }
        }
    }
}

/// Parse an EPUB file — converts TOC to cloneable tree, then recursively
/// walks it to extract chapters with hierarchy (level 0/1/2 for 一级/二级/三级).
/// `books_dir` is the root directory where book data is stored; images will be
/// extracted to `books_dir/{book_id}/images/`.
/// Returns (title, author, chapters, cover_image_filename).
pub fn parse_epub_internal(
    file_path: &str,
    books_dir: Option<&Path>,
) -> Result<(String, String, Vec<ParsedChapter>, Option<String>), String> {
    let file = fs::File::open(file_path).map_err(|e| e.to_string())?;
    let mut reader = std::io::BufReader::new(file);
    let mut epub_bytes = Vec::new();
    reader.read_to_end(&mut epub_bytes).map_err(|e| e.to_string())?;

    let mut book = epub::doc::EpubDoc::from_reader(std::io::Cursor::new(epub_bytes))
        .map_err(|e| format!("Failed to parse EPUB: {}", e))?;

    let title = book
        .metadata
        .get("title")
        .cloned()
        .and_then(|v| v.into_iter().next())
        .unwrap_or_else(|| {
            Path::new(file_path)
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("Untitled")
                .to_string()
        });

    let author = book
        .metadata
        .get("creator")
        .cloned()
        .and_then(|v| v.into_iter().next())
        .unwrap_or_else(|| "Unknown Author".to_string());

    // ── Extract images from the EPUB ──────────────────────────────────
    let (image_map, mut cover_image): (Option<HashMap<String, String>>, Option<String>) =
        if let Some(dir) = books_dir {
            let images_dir = dir.join("images");
            let (map, first_img) = extract_images_from_epub(&mut book, &images_dir);
            if map.is_empty() {
                (None, None)
            } else {
                (Some(map), first_img)
            }
        } else {
            (None, None)
        };

    // ── Detect cover from EPUB metadata ──────────────────────────────
    // If the EPUB declares a cover in metadata, look it up in the image map.
    if let (Some(ref map), Ok(cover_id)) = (&image_map, book.get_cover_id()) {
        // Try to find the cover by resource ID, or by path from resources
        if let Some(cover_filename) = map.get(&cover_id).cloned() {
            cover_image = Some(cover_filename);
        } else if let Some((cover_path, _)) = book.resources.get(&cover_id) {
            let cover_path_str = cover_path.to_string_lossy().to_string();
            if let Some(cover_filename) = map.get(&cover_path_str).cloned() {
                cover_image = Some(cover_filename);
            }
        }
    }

    let mut chapters = Vec::new();
    let spine = book.spine.clone();

    // ── Strategy 1: Convert TOC to cloneable tree, then walk it ────────
    let toc_tree = convert_toc(&book.toc);
    if !toc_tree.is_empty() {
        walk_toc_nodes(&mut book, &toc_tree, &spine, 0, &mut chapters, image_map.as_ref());
    }

    // ── Strategy 2: TOC produced nothing → spine-based fallback ────────
    if chapters.is_empty() {
        let mut spine_chapters: Vec<(String, String, usize)> = Vec::new();

        for resource_id in &spine {
            if let Ok(raw) = book
                .get_resource(resource_id)
                .or_else(|_| book.get_resource_by_path(resource_id))
            {
                let text = clean_html(&String::from_utf8_lossy(&raw), image_map.as_ref());
                if text.trim().is_empty() { continue; }

                let fallback_title = Path::new(resource_id)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Chapter")
                    .to_string();

                let subs = split_into_chapters(&text);
                if subs.len() <= 1 {
                    spine_chapters.push((fallback_title, text, 0));
                } else {
                    for sub in subs {
                        spine_chapters.push((sub.title, sub.content, sub.level));
                    }
                }
            }
        }

        let mut merged: Vec<ParsedChapter> = Vec::new();
        let mut pending: Option<(String, String, usize)> = None;

        for (ch_title, ch_content, ch_level) in spine_chapters {
            if ch_content.len() < 500 {
                if let Some((ref mut _p, ref mut c, _)) = pending {
                    c.push_str("\n\n"); c.push_str(&ch_title); c.push_str("\n\n"); c.push_str(&ch_content);
                } else {
                    pending = Some((ch_title, ch_content, ch_level));
                }
            } else {
                if let Some((pt, pc, pl)) = pending.take() {
                    merged.push(ParsedChapter { title: pt, content: pc, level: pl });
                }
                merged.push(ParsedChapter { title: ch_title, content: ch_content, level: ch_level });
            }
        }
        if let Some((pt, pc, pl)) = pending.take() {
            merged.push(ParsedChapter { title: pt, content: pc, level: pl });
        }

        chapters = merged;
    }

    // ── Strategy 3: Everything failed → dump full text ──────────────────
    if chapters.is_empty() {
        let mut all_text = String::new();
        for resource_id in &spine {
            if let Ok(raw) = book
                .get_resource(resource_id)
                .or_else(|_| book.get_resource_by_path(resource_id))
            {
                all_text.push_str(&clean_html(&String::from_utf8_lossy(&raw), image_map.as_ref()));
                all_text.push_str("\n\n");
            }
        }
        let chapters_from_text = split_into_chapters(&all_text);
        if !chapters_from_text.is_empty() {
            chapters = chapters_from_text;
        } else if !all_text.trim().is_empty() {
            chapters.push(ParsedChapter { title: "Full Text".to_string(), content: all_text.trim().to_string(), level: 0 });
        }
    }

    Ok((title, author, chapters, cover_image))
}

/// Parse a TXT file — infer chapter breaks from common patterns.
pub fn parse_txt_internal(file_path: &str) -> Result<(String, String, Vec<ParsedChapter>, Option<String>), String> {
    let bytes = fs::read(file_path).map_err(|e| e.to_string())?;
    let content = decode_text(&bytes);

    let title = Path::new(file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();

    let author = "Unknown Author".to_string();

    let chapters = split_into_chapters(&content);

    Ok((title, author, chapters, None))
}

/// Decode a text file into a String, tolerating non-UTF-8 encodings.
///
/// `fs::read_to_string` accepts valid UTF-8 and nothing else, which rules out
/// most Chinese e-books: the majority of the ones people actually download
/// ship as GB18030/GBK, and one saved from Notepad as "Unicode" is UTF-16.
/// Both used to fail the import outright.
///
/// Order of attempts:
///   1. Byte-order mark — an explicit declaration, so it beats any guess.
///   2. Strict UTF-8 — the common case, and strict so we can tell it failed.
///   3. GB18030 — per the WHATWG standard it decodes *every* byte sequence, so
///      it cannot fail; it is a strict superset of GBK and GB2312.
///   4. Windows-1252 — if step 3 produced no CJK at all, the file was probably
///      Western European rather than Chinese and step 3 made mojibake of it.
fn decode_text(bytes: &[u8]) -> String {
    // 1. Byte-order mark
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(&bytes[3..]).into_owned();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return text.into_owned();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return text.into_owned();
    }

    // 2. Plain UTF-8
    if let Ok(text) = std::str::from_utf8(bytes) {
        return text.to_string();
    }

    // 3. GB18030
    let (gb18030, _, _) = encoding_rs::GB18030.decode(bytes);
    if gb18030.chars().any(is_cjk) {
        return gb18030.into_owned();
    }

    // 4. Western European
    let (latin, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
    latin.into_owned()
}

/// True for the scripts that make GB18030 a plausible reading of a byte
/// sequence: CJK ideographs (plus extension A and compatibility), kana, hangul.
fn is_cjk(c: char) -> bool {
    let cp = c as u32;
    (0x3040..=0x30FF).contains(&cp)
        || (0x3400..=0x4DBF).contains(&cp)
        || (0x4E00..=0x9FFF).contains(&cp)
        || (0xAC00..=0xD7AF).contains(&cp)
        || (0xF900..=0xFAFF).contains(&cp)
}

/// Parse a PDF file — extract text with the CMap-aware extractor in
/// `super::pdf_text`, which understands the CID fonts Chinese PDFs use.
///
/// A PDF with no usable text layer (a scan, or a font with no `/ToUnicode`)
/// returns a descriptive `Err` rather than importing an empty book.
///
/// Wrapped in `catch_unwind` because a malformed PDF can make `lopdf` panic.
pub fn parse_pdf_internal(file_path: &str) -> Result<(String, String, Vec<ParsedChapter>, Option<String>), String> {
    let file_path_owned = file_path.to_string();
    let bytes = fs::read(file_path).map_err(|e| e.to_string())?;

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let extraction = super::pdf_text::extract_pdf_text_from_bytes(&bytes)
            .map_err(|e| format!("{}: {}", e.code(), e.user_message()))?;

        let title = Path::new(&file_path_owned)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string();

        let text = collapse_newlines(&extraction.text);
        let chapters = split_into_chapters(&text);

        Ok::<_, String>((title, chapters))
    }))
    .map_err(|_| "PDF parser panicked — the file may be malformed or use unsupported features".to_string())?;

    let (title, chapters) = result?;
    let author = "Unknown Author".to_string();
    Ok((title, author, chapters, None))
}

/// Extract image resources from an EPUB document into `images_dir`.
/// Returns a map from original src path → saved filename, and the filename
/// of the first image extracted (as a cover candidate).
fn extract_images_from_epub(
    book: &mut epub::doc::EpubDoc<std::io::Cursor<Vec<u8>>>,
    images_dir: &Path,
) -> (HashMap<String, String>, Option<String>) {
    let mut map = HashMap::new();
    fs::create_dir_all(images_dir).ok();

    let img_extensions = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"];

    // Iterate all resources in the EPUB; extract image-typed ones.
    // `book.resources` is `HashMap<resource_id, (actual_path, mime)>`.
    // HTML <img src> references actual_path, not resource_id, so the map must
    // be keyed by actual_path (and by resource_id + basename for fallback).
    let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut first_image: Option<String> = None;

    for (res_id, (res_path, _res_mime)) in book.resources.clone() {
        let lower = res_path.to_string_lossy().to_lowercase();
        let is_image = img_extensions
            .iter()
            .any(|ext| lower.ends_with(&format!(".{}", ext)));

        if !is_image || seen_ids.contains(&res_id) {
            continue;
        }
        seen_ids.insert(res_id.clone());

        // Fetch by resource ID first, fall back to actual path
        if let Ok(raw) = book
            .get_resource(&res_id)
            .or_else(|_| book.get_resource_by_path(&res_path))
        {
            // Generate a safe filename from the actual path
            let ext = res_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("png");
            let basename = res_path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("image");
            let safe_name = sanitize_filename(basename);
            let base_filename = format!("{}.{}", safe_name, ext);

            // Avoid overwrites
            let final_name = if images_dir.join(&base_filename).exists() {
                let unique = format!(
                    "{}_{}.{}",
                    safe_name,
                    uuid::Uuid::new_v4().to_string().split('-').next().unwrap_or("0"),
                    ext
                );
                unique
            } else {
                base_filename.clone()
            };

            let dest = images_dir.join(&final_name);
            if fs::write(&dest, &raw).is_ok() {
                // Map by actual path (primary — matches HTML src attr)
                map.insert(res_path.to_string_lossy().to_string(), final_name.clone());
                // Also map by resource ID (fallback for EPUBs that use id-based refs)
                map.insert(res_id.clone(), final_name.clone());
                // Also map by bare basename (fallback for fuzzy matching)
                map.insert(base_filename, final_name.clone());
                // Track first image as cover candidate
                if first_image.is_none() {
                    first_image = Some(final_name);
                }
            }
        }
    }

    (map, first_image)
}

/// Sanitize a filename component: remove unsafe characters.
fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' || c == '.' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

/// Normalize relative paths like "../Images/foo.jpg" → "Images/foo.jpg".
fn normalize_src(src: &str) -> String {
    let mut parts: Vec<&str> = src.split('/').collect();
    // Collapse leading "../" or "./" segments
    while let Some(first) = parts.first() {
        if *first == ".." || *first == "." {
            parts.remove(0);
        } else {
            break;
        }
    }
    parts.join("/")
}

#[tauri::command]
pub async fn parse_epub(file_path: String) -> Result<Vec<ParsedChapter>, String> {
    let (_, _, chapters, _cover) = parse_epub_internal(&file_path, None)?;
    Ok(chapters)
}

#[tauri::command]
pub async fn parse_txt(file_path: String) -> Result<Vec<ParsedChapter>, String> {
    let (_, _, chapters, _cover) = parse_txt_internal(&file_path)?;
    Ok(chapters)
}

#[tauri::command]
pub async fn parse_pdf(file_path: String) -> Result<Vec<ParsedChapter>, String> {
    let (_, _, chapters, _cover) = parse_pdf_internal(&file_path)?;
    Ok(chapters)
}

// ── Helpers ───────────────────────────────────────────────────────────────

/// Find `needle` in `haystack`, ASCII-case-insensitively, returning a byte
/// index into `haystack` itself.
///
/// The tempting version — `haystack.to_lowercase().find(needle)` — is wrong,
/// because `to_lowercase` applies the full Unicode case mapping, which is
/// allowed to change the byte length: `İ` (U+0130) is two bytes and lowercases
/// to `i` + U+0307, three bytes, while `ẞ` (U+1E9E) shrinks from three to two.
/// A match found in the lowercased copy then names a different offset in the
/// original, and callers slice the original with it. The result is either a
/// panic (`replace_range` and slicing demand char boundaries) or, worse,
/// silently deleted text when the shifted offset happens to land on a boundary.
///
/// HTML tag names are pure ASCII, so a byte-wise comparison is the correct
/// search. It also guarantees the returned index is a char boundary: every byte
/// it can match is < 0x80, so the match cannot begin inside a multi-byte
/// character.
fn find_ascii_ci(haystack: &str, needle: &str) -> Option<usize> {
    let needle = needle.as_bytes();
    if needle.is_empty() {
        return None;
    }
    haystack
        .as_bytes()
        .windows(needle.len())
        .position(|window| window.eq_ignore_ascii_case(needle))
}

/// Strip HTML tags and decode common entities, returning plain text.
/// If `image_map` is provided, &lt;img&gt; tags are replaced with `[IMG:filename]`
/// markers using the mapping from original src → extracted filename.
fn clean_html(html: &str, image_map: Option<&HashMap<String, String>>) -> String {
    // A leading BOM decodes to U+FEFF, which would otherwise become the first
    // character of the chapter — invisible, but the user would still have to
    // type past it.
    let mut text = html.trim_start_matches('\u{FEFF}').to_string();

    // ── Step 0: Replace <img> tags with [IMG:...] markers ────────────
    if let Some(map) = image_map {
        text = replace_img_tags(&text, map);
    }

    // Remove <script>, <style>, <head> blocks
    for (open_tag, close_tag) in &[
        ("<script", "</script>"),
        ("<style", "</style>"),
        ("<head", "</head>"),
    ] {
        loop {
            let start = match find_ascii_ci(&text, open_tag) {
                Some(s) => s,
                None => break,
            };
            let end = match find_ascii_ci(&text[start..], close_tag) {
                Some(e) => start + e + close_tag.len(),
                None => break,
            };
            // Both offsets were found in `text` itself, so this is on char
            // boundaries and cannot panic.
            text.replace_range(start..end, "");
        }
    }

    // Replace block-level tags with newlines
    let block_tags = ["br", "p", "div", "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "section", "article"];
    for tag in &block_tags {
        text = replace_tag_with_newline(&text, tag);
    }

    // Remove all remaining HTML tags
    text = strip_tags(&text);

    // Decode HTML character references
    text = decode_entities(&text);

    // Collapse multiple consecutive newlines
    text = collapse_newlines(&text);

    text.trim().to_string()
}

/// Decode HTML character references in a single left-to-right pass.
///
/// One pass matters. The previous implementation was a chain of `replace()`
/// calls, which decodes twice: the source text `&amp;#39;` denotes the literal
/// string "&#39;", but replacing `&amp;` first yields `&#39;`, and the next
/// replace silently turns that into `'`.
///
/// The named table covers the handful that actually occur in book prose;
/// everything else falls through to numeric decoding, which is what matters in
/// practice — `&#x4E2D;` is just "中", and books converted between formats use
/// numeric references heavily. Anything unrecognised is left verbatim.
fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;

    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];

        // Every reference handled here is well under 12 characters. Capping the
        // search keeps a stray '&' in prose from swallowing the paragraph up to
        // some far-off semicolon.
        let semi = rest
            .char_indices()
            .take(12)
            .find(|&(_, c)| c == ';')
            .map(|(i, _)| i);

        let decoded = semi.and_then(|i| match &rest[1..i] {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            body => decode_numeric(body),
        });

        match (semi, decoded) {
            (Some(i), Some(c)) => {
                out.push(c);
                rest = &rest[i + 1..];
            }
            _ => {
                // Not a reference we recognise — emit the '&' and carry on, so
                // the caller still sees the original text.
                out.push('&');
                rest = &rest[1..];
            }
        }
    }

    out.push_str(rest);
    out
}

/// Decode the body of a numeric character reference — `#123` or `#x1F600`.
/// `None` for anything malformed, or for code points that are not characters
/// (surrogate halves, out of range).
fn decode_numeric(body: &str) -> Option<char> {
    let digits = body.strip_prefix('#')?;
    let (radix, digits) = match digits
        .strip_prefix('x')
        .or_else(|| digits.strip_prefix('X'))
    {
        Some(hex) => (16, hex),
        None => (10, digits),
    };
    char::from_u32(u32::from_str_radix(digits, radix).ok()?)
}

/// Replace `<img src="...">` tags with `[IMG:filename]` markers.
fn replace_img_tags(html: &str, image_map: &HashMap<String, String>) -> String {
    let mut result = String::with_capacity(html.len());
    let mut remaining = html;

    loop {
        let start = match find_ascii_ci(remaining, "<img") {
            Some(s) => s,
            None => break,
        };

        // Push text before the img tag
        result.push_str(&remaining[..start]);

        // Find the end of the img tag
        let tag_slice = &remaining[start..];
        let tag_end = find_tag_end(tag_slice, 0);
        let tag = &tag_slice[..tag_end];

        // Try to extract src attribute
        let src = extract_src(tag);
        let marker = if let Some(ref s) = src {
            // Normalize relative paths like "../Images/foo.jpg" → "Images/foo.jpg"
            let normalized = normalize_src(s);
            // Try to match with known image paths
            let filename = image_map
                .get(s)
                .or_else(|| image_map.get(&normalized))
                .cloned();
            if let Some(fname) = filename {
                format!("\n[IMG:{}]\n", fname)
            } else {
                // Try fuzzy match: strip leading directories from src
                let basename = s.rsplit('/').next().unwrap_or(s);
                let fuzzy = image_map.iter().find(|(k, _)| k.contains(basename));
                if let Some((_, fname)) = fuzzy {
                    format!("\n[IMG:{}]\n", fname)
                } else {
                    // Unknown image — still insert a marker with the original src
                    format!("\n[IMG:{}]\n", sanitize_filename(s))
                }
            }
        } else {
            String::new()
        };

        result.push_str(&marker);
        remaining = &remaining[start + tag_end..];
    }

    result.push_str(remaining);
    result
}

/// Extract the src attribute value from an <img> tag string.
fn extract_src(tag: &str) -> Option<String> {
    let src_pos = find_ascii_ci(tag, "src")?;
    let after_src = &tag[src_pos + 3..];
    let after_equals = after_src.trim_start().strip_prefix('=')?;
    let after_equals = after_equals.trim_start();

    // Determine quote character
    let quote = after_equals.chars().next()?;
    if quote == '"' || quote == '\'' {
        let inner = &after_equals[1..];
        let end = inner.find(quote)?;
        Some(inner[..end].to_string())
    } else {
        // Unquoted attribute
        let end = after_equals
            .find(|c: char| c.is_whitespace() || c == '>')
            .unwrap_or(after_equals.len());
        if end > 0 {
            Some(after_equals[..end].to_string())
        } else {
            None
        }
    }
}

/// Replace opening and closing tags of a given name with a newline.
fn replace_tag_with_newline(text: &str, tag: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut remaining = text;
    let open_start = format!("<{}", tag);
    let close_tag = format!("</{}>", tag);

    loop {
        // Find the earliest of <tag... or </tag>
        let open_pos = find_ascii_ci(remaining, &open_start);
        let close_pos = find_ascii_ci(remaining, &close_tag);

        let (pos, skip) = match (open_pos, close_pos) {
            (None, None) => break,
            (Some(o), None) => (o, find_tag_end(remaining, o)),
            (None, Some(c)) => (c, close_tag.len()),
            (Some(o), Some(c)) if o <= c => (o, find_tag_end(remaining, o)),
            (Some(_), Some(c)) => (c, close_tag.len()),
        };

        result.push_str(&remaining[..pos]);
        result.push('\n');
        remaining = &remaining[pos + skip..];
    }

    result.push_str(remaining);
    result
}

/// Find the end of an HTML tag starting at `start`.
fn find_tag_end(text: &str, start: usize) -> usize {
    let slice = &text[start..];
    let mut in_quote: Option<char> = None;
    for (i, ch) in slice.char_indices() {
        match ch {
            '"' | '\'' if in_quote == Some(ch) => in_quote = None,
            '"' | '\'' if in_quote.is_none() => in_quote = Some(ch),
            '>' if in_quote.is_none() => return i + 1,
            _ => {}
        }
    }
    slice.len()
}

/// Remove all HTML tags from text.
fn strip_tags(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut in_tag = false;
    let mut in_quote: Option<char> = None;

    for ch in text.chars() {
        match ch {
            '<' if in_quote.is_none() => in_tag = true,
            '>' if in_quote.is_none() => in_tag = false,
            '"' if in_tag => {
                if in_quote == Some('"') {
                    in_quote = None;
                } else if in_quote.is_none() {
                    in_quote = Some('"');
                } else {
                    result.push(ch);
                }
            }
            '\'' if in_tag => {
                if in_quote == Some('\'') {
                    in_quote = None;
                } else if in_quote.is_none() {
                    in_quote = Some('\'');
                } else {
                    result.push(ch);
                }
            }
            _ if !in_tag => result.push(ch),
            _ if in_quote.is_some() => {} // skip quoted content
            _ => {} // skip tag content
        }
    }

    result
}

/// Collapse 3+ consecutive newlines into 2.
fn collapse_newlines(text: &str) -> String {
    let mut result = String::with_capacity(text.len());
    let mut newline_count = 0;

    for ch in text.chars() {
        if ch == '\n' {
            newline_count += 1;
            if newline_count <= 2 {
                result.push(ch);
            }
        } else {
            newline_count = 0;
            result.push(ch);
        }
    }

    result
}

/// Split raw text into chapters based on common chapter-heading patterns.
fn split_into_chapters(text: &str) -> Vec<ParsedChapter> {
    let lines: Vec<&str> = text.lines().collect();
    let mut chapter_starts: Vec<(usize, String)> = Vec::new();

    // Detect chapter heading lines
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if is_chapter_heading(trimmed) {
            chapter_starts.push((i, trimmed.to_string()));
        }
    }

    if chapter_starts.is_empty() {
        return vec![ParsedChapter {
            title: "Full Text".to_string(),
            content: text.trim().to_string(),
            level: 0,
        }];
    }

    let mut chapters = Vec::new();

    for idx in 0..chapter_starts.len() {
        let (start_line, ref title) = chapter_starts[idx];
        let end_line = if idx + 1 < chapter_starts.len() {
            chapter_starts[idx + 1].0
        } else {
            lines.len()
        };

        let content_lines: Vec<&str> = lines[start_line..end_line].to_vec();
        let content = content_lines.join("\n").trim().to_string();

        if !content.replace(title, "").trim().is_empty() {
            chapters.push(ParsedChapter {
                title: title.clone(),
                content,
                level: 0,
            });
        }
    }

    chapters
}

/// Exposed so the PDF extractor's tests can assert that extracted line breaks
/// actually produce chapters.
#[cfg(test)]
pub(crate) fn split_into_chapters_for_test(text: &str) -> Vec<ParsedChapter> {
    split_into_chapters(text)
}

/// Check if a line looks like a chapter heading.
fn is_chapter_heading(line: &str) -> bool {
    let lower = line.to_lowercase();

    // English patterns
    let english_patterns = [
        "chapter ", "section ", "part ", "book ", "prologue", "epilogue",
        "preface", "introduction", "foreword", "appendix", "acknowledgments",
    ];
    for pat in &english_patterns {
        if lower.starts_with(pat) {
            return true;
        }
    }

    // Chinese patterns: 第...章
    if lower.starts_with("第") && lower.contains('章') {
        return true;
    }

    // Roman numeral chapter headings: "I.", "II.", "IV.", etc.
    if lower.len() >= 2
        && lower.chars().all(|c| c == 'i' || c == 'v' || c == 'x' || c == 'l' || c == '.' || c == ' ')
        && (lower.ends_with('.') || lower.chars().all(|c| c != '.'))
    {
        let numeral_part = lower.trim_end_matches('.');
        if !numeral_part.is_empty() && numeral_part.len() <= 8 {
            return true;
        }
    }

    // Pattern: "1.", "2.", "12." etc. at the start
    if let Some(first_char) = line.chars().next() {
        if first_char.is_ascii_digit() {
            let num_end = line
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .count();
            if num_end > 0
                && line.chars().nth(num_end) == Some('.')
                && line.len() - num_end <= 10
            {
                return true;
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── Character references ────────────────────────────────────────────────

    #[test]
    fn decodes_named_entities() {
        assert_eq!(
            decode_entities("a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos;"),
            "a & b <c> \"d\" 'e'"
        );
    }

    #[test]
    fn decodes_numeric_entities_in_both_radixes() {
        // 中 = U+4E2D = 20013, 文 = U+6587 = 25991
        assert_eq!(decode_entities("&#x4E2D;&#25991;"), "中文");
        assert_eq!(decode_entities("&#X4E2D;"), "中");
    }

    #[test]
    fn does_not_decode_twice() {
        // "&amp;#39;" denotes the literal string "&#39;", not an apostrophe.
        // A chain of replace() calls gets this wrong; a single pass cannot.
        assert_eq!(decode_entities("&amp;#39;"), "&#39;");
    }

    #[test]
    fn leaves_unrecognised_references_verbatim() {
        assert_eq!(decode_entities("AT&T &unknown; &#xZZ;"), "AT&T &unknown; &#xZZ;");
    }

    #[test]
    fn rejects_non_characters() {
        // Lone surrogate half, and beyond the Unicode range.
        assert_eq!(decode_entities("&#xD800;"), "&#xD800;");
        assert_eq!(decode_entities("&#x110000;"), "&#x110000;");
    }

    #[test]
    fn a_stray_ampersand_does_not_swallow_the_text() {
        // No semicolon within reach — must not eat the following characters.
        assert_eq!(decode_entities("Tom & Jerry went home"), "Tom & Jerry went home");
    }

    // ── Text decoding ───────────────────────────────────────────────────────

    #[test]
    fn plain_utf8_passes_through() {
        assert_eq!(decode_text("中文 abc".as_bytes()), "中文 abc");
    }

    #[test]
    fn utf8_bom_is_stripped() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("中文".as_bytes());
        assert_eq!(decode_text(&bytes), "中文");
    }

    #[test]
    fn utf16le_with_bom_is_decoded() {
        let mut bytes = vec![0xFF, 0xFE];
        for unit in "中文".encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        assert_eq!(decode_text(&bytes), "中文");
    }

    #[test]
    fn gbk_text_is_recovered() {
        // "中文" as GBK — not valid UTF-8, so this used to fail the import.
        let gbk = [0xD6u8, 0xD0, 0xCE, 0xC4];
        assert_eq!(decode_text(&gbk), "中文");
    }

    #[test]
    fn gbk_punctuation_and_ascii_mix_is_recovered() {
        // "他说：OK。" as GBK — the colon and full stop are GBK two-byte forms.
        let gbk = [
            0xCBu8, 0xFB, 0xCB, 0xB5, 0xA3, 0xBA, 0x4F, 0x4B, 0xA1, 0xA3,
        ];
        assert_eq!(decode_text(&gbk), "他说：OK。");
    }

    #[test]
    fn western_european_falls_back_to_1252() {
        // "café" as Windows-1252. GB18030 turns this into mojibake with no CJK,
        // which is exactly the signal that selects the Latin fallback.
        let latin = [0x63u8, 0x61, 0x66, 0xE9];
        assert_eq!(decode_text(&latin), "café");
    }

    // ── Tag search ──────────────────────────────────────────────────────────

    #[test]
    fn ascii_search_indexes_the_original_string() {
        let s = "İ<script>";
        assert_eq!(find_ascii_ci(s, "<script"), Some(2));
        assert!(s[2..].starts_with("<script"));

        // What the old code did: `İ` (two bytes) lowercases to `i` + U+0307
        // (three), so the same search in that copy reports 3 — a byte later
        // than the tag actually sits, because the copy grew by one.
        assert_eq!(s.to_lowercase().find("<script"), Some(3));
    }

    #[test]
    fn cleaning_survives_a_case_mapping_that_grows() {
        // Regression: the script-removal loop lowercased the whole document,
        // found the tag in that copy, then handed the offset to `replace_range`
        // on the original. The `İ` shifted everything one byte right, putting
        // the end offset inside the following CJK character — a panic, so the
        // whole book failed to import.
        assert_eq!(
            clean_html("<p>İ</p><script>alert(1)</script>中文", None),
            "İ\n中文"
        );
    }

    #[test]
    fn cleaning_survives_a_case_mapping_that_shrinks() {
        // The mirror case: `ẞ` (U+1E9E, three bytes) lowercases to `ß` (two),
        // shifting the offset backwards instead.
        assert_eq!(clean_html("ẞ<script>x</script>中", None), "ẞ中");
    }

    #[test]
    fn tag_matching_is_case_insensitive() {
        assert_eq!(clean_html("<P>Hi</P><SCRIPT>bad()</SCRIPT>", None), "Hi");
    }

    // ── PDF import, end to end ──────────────────────────────────────────────

    /// Runs the real `parse_pdf_internal` over a directory of PDFs. Gated on an
    /// environment variable so the default run stays hermetic:
    ///
    /// `DAZIJI_PDF_DIR='C:\path\to\pdfs' cargo test --no-default-features --lib -- --nocapture real_pdf_import`
    ///
    /// This is the only place the whole chain runs together — file read, text
    /// extraction, newline collapsing, chapter splitting — so it is also the
    /// check that extracted line breaks are good enough to find headings.
    #[test]
    fn real_pdf_import() {
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

            let name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            match parse_pdf_internal(&path.to_string_lossy()) {
                Ok((title, _author, chapters, _cover)) => {
                    let total: usize = chapters.iter().map(|c| c.content.chars().count()).sum();
                    println!(
                        "OK   {} | title={:?} chapters={} chars={} first={:?}",
                        name,
                        title,
                        chapters.len(),
                        total,
                        chapters.first().map(|c| c.title.clone()).unwrap_or_default(),
                    );
                    assert!(
                        chapters.iter().any(|c| !c.content.trim().is_empty()),
                        "{}: imported with no readable text",
                        name
                    );
                }
                Err(message) => println!("ERR  {} | {}", name, message),
            }
            checked += 1;
        }
        println!("checked {} PDF file(s) in {}", checked, dir);
    }
}
