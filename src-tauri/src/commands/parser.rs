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
    let content = fs::read_to_string(file_path).map_err(|e| e.to_string())?;

    let title = Path::new(file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();

    let author = "Unknown Author".to_string();

    let chapters = split_into_chapters(&content);

    Ok((title, author, chapters, None))
}

/// Parse a PDF file — extract raw text using lopdf.
/// Wrapped in catch_unwind because lopdf can panic on malformed PDFs.
pub fn parse_pdf_internal(file_path: &str) -> Result<(String, String, Vec<ParsedChapter>, Option<String>), String> {
    let file_path_owned = file_path.to_string();
    let bytes = fs::read(file_path).map_err(|e| e.to_string())?;

    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let doc = lopdf::Document::load_mem(&bytes).map_err(|e| format!("Failed to parse PDF: {}", e))?;

        let title = Path::new(&file_path_owned)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Untitled")
            .to_string();

        let mut all_text = String::new();
        let page_count = doc.page_iter().count();

        for page_num in 1..=page_count {
            if let Ok(text) = doc.extract_text(&[page_num as u32]) {
                all_text.push_str(&text);
                all_text.push('\n');
            }
        }

        let chapters = split_into_chapters(&all_text);

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

/// Strip HTML tags and decode common entities, returning plain text.
/// If `image_map` is provided, &lt;img&gt; tags are replaced with `[IMG:filename]`
/// markers using the mapping from original src → extracted filename.
fn clean_html(html: &str, image_map: Option<&HashMap<String, String>>) -> String {
    let mut text = html.to_string();

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
            let lower = text.to_lowercase();
            let start = match lower.find(open_tag) {
                Some(s) => s,
                None => break,
            };
            let end = match lower[start..].find(close_tag) {
                Some(e) => start + e + close_tag.len(),
                None => break,
            };
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

    // Decode common HTML entities
    text = text.replace("&amp;", "&");
    text = text.replace("&lt;", "<");
    text = text.replace("&gt;", ">");
    text = text.replace("&quot;", "\"");
    text = text.replace("&apos;", "'");
    text = text.replace("&#39;", "'");
    text = text.replace("&nbsp;", " ");

    // Collapse multiple consecutive newlines
    text = collapse_newlines(&text);

    text.trim().to_string()
}

/// Replace `<img src="...">` tags with `[IMG:filename]` markers.
fn replace_img_tags(html: &str, image_map: &HashMap<String, String>) -> String {
    let mut result = String::with_capacity(html.len());
    let mut remaining = html;
    let lower_start = "<img";

    loop {
        let lower = remaining.to_lowercase();
        let start = match lower.find(lower_start) {
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
    let lower = tag.to_lowercase();
    let src_pos = lower.find("src")?;
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
        let lower = remaining.to_lowercase();
        // Find the earliest of <tag... or </tag>
        let open_pos = lower.find(&open_start);
        let close_pos = lower.find(&close_tag);

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
