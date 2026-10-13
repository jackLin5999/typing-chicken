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

    // ── Strategy 1.5: TOC 指向全书时用它救回来 ──────────────────────────
    // 有些书（尤其 Project Gutenberg 的中文古典小说）TOC 只有 2-3 个 navPoint
    // ——书名 + 许可证——比没有 TOC 还糟：Strategy 1 会「成功」返回两章，
    // 于是 Strategy 2 根本不会跑，整本《西遊記》就变成 2 章。
    // 判据：章节数明显配不上正文字数时，直接按正文标题重切。
    const MIN_PLAUSIBLE_CHAPTERS: usize = 5;
    const MIN_RECOVER_CHARS: usize = 50_000;

    if chapters.len() < MIN_PLAUSIBLE_CHAPTERS {
        let full_text = collect_spine_text(&mut book, &spine, image_map.as_ref());
        if full_text.chars().count() > MIN_RECOVER_CHARS {
            let resplit = split_into_chapters(&full_text);
            // 只在确实切得更多时才替换，避免把正常的少章短篇改坏
            if resplit.len() > chapters.len() {
                chapters = resplit;
            }
        }
    }

    // ── Strategy 2: TOC produced nothing → spine-based fallback ────────
    if chapters.is_empty() {
        let mut spine_chapters: Vec<(String, String, usize)> = Vec::new();

        for resource_id in &spine {
            if let Ok(raw) = book
                .get_resource(resource_id)
                .or_else(|_| book.get_resource_by_path(resource_id))
            {
                // 在每个文件**内部**裁掉 Gutenberg 的版权页/许可声明。
                // 不能整个文件跳过：版权页和正文开头往往同处一个 chunk。
                let cleaned = clean_html(&String::from_utf8_lossy(&raw), image_map.as_ref());
                let text = strip_gutenberg_markers(&cleaned);
                if text.trim().is_empty() { continue; }
                let text = text.to_string();

                let fallback_title = Path::new(resource_id)
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Chapter")
                    .to_string();

                let subs = split_into_chapters(&text);
                if subs.len() <= 1 {
                    // 整块没切出标题 → 当作一章，但正文同样要还原折行
                    spine_chapters.push((fallback_title, unwrap_wrapped_lines(&text), 0));
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
        let all_text = collect_spine_text(&mut book, &spine, image_map.as_ref());
        let chapters_from_text = split_into_chapters(&all_text);
        if !chapters_from_text.is_empty() {
            chapters = chapters_from_text;
        } else if !all_text.trim().is_empty() {
            chapters.push(ParsedChapter { title: "Full Text".to_string(), content: all_text.trim().to_string(), level: 0 });
        }
    }

    // 兜底：按内容丢掉 Gutenberg 的书名页与许可声明。
    // 上面按 id 拦过一道，但 TOC 路径（Strategy 1）绕过那两道过滤，
    // 而且别的工具重排过的 EPUB 可能换了 id —— 这里统一收口。
    chapters.retain(|c| !is_gutenberg_boilerplate_text(&c.content));

    Ok((title, author, chapters, cover_image))
}

/// 把 spine 里的所有文档清洗后拼成一整段全文。
/// Strategy 1.5（TOC 不可用时重切）与 Strategy 3（兜底 dump）共用。
fn collect_spine_text(
    book: &mut epub::doc::EpubDoc<std::io::Cursor<Vec<u8>>>,
    spine: &[String],
    image_map: Option<&HashMap<String, String>>,
) -> String {
    let mut all_text = String::new();
    for resource_id in spine {
        if let Ok(raw) = book
            .get_resource(resource_id)
            .or_else(|_| book.get_resource_by_path(resource_id))
        {
            // 同 Strategy 2：在文件内部裁标记，不整个文件跳过
            let cleaned = clean_html(&String::from_utf8_lossy(&raw), image_map);
            all_text.push_str(strip_gutenberg_markers(&cleaned));
            all_text.push_str("\n\n");
        }
    }
    all_text
}

/// Parse a TXT file — infer chapter breaks from common patterns.
pub fn parse_txt_internal(file_path: &str) -> Result<(String, String, Vec<ParsedChapter>, Option<String>), String> {
    let bytes = fs::read(file_path).map_err(|e| e.to_string())?;
    let decoded = decode_text(&bytes);
    let content = strip_gutenberg_markers(&decoded);

    let title = Path::new(file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled")
        .to_string();

    let author = "Unknown Author".to_string();

    let chapters = split_into_chapters(content);

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
    // 注意：**不要**在这里折行还原（见 unwrap_wrapped_lines 的注释）。
    // 有些书的 chunk 是纯文本转过来的，换行是它唯一的结构 ——
    // 提前还原会把整章压成一行，章节标题再也找不到行首，分章直接崩掉。
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

/// ⚠️ 不要按 spine 的资源 id 判断「整个文件都是样板」。
///
/// 曾经这么干过：把 `pg-header` / `pg-footer` 两个 id 整个跳过。
/// 结果《紅樓夢》掉了一大半正文 —— 实测 `pg-header` 那个文件长 85,228 字，
/// 而 `*** START OF THE PROJECT GUTENBERG ***` 标记在第 **836** 字，
/// 也就是说前面 836 字是版权页，**后面 8 万多字是真正的小说开头**。
/// `pg-footer` 同理：END 标记几乎就在文件开头。
///
/// 正解是**在文件内部按标记裁**（见 `strip_gutenberg_markers`），
/// 而不是按 id 丢文件。

/// 繁体 → 简体。
///
/// 为什么要这一步：Project Gutenberg 的中文书**几乎全是繁体**
/// （实测：抓下全部 444 本中文书的纯文本，抽样 20 本统计特征字 —
///  简体特征字命中 16,732 次，繁体特征字命中 632,589 次，比例约 1:38，
///  20 本全部判定为繁体）。对大陆用户来说不转换基本没法拿来练打字。
///
/// 用 `zhconv`（MediaWiki + OpenCC 规则集，词级而非字级，所以「頭髮」→「头发」
/// 而不是「头发」错成「头發」这类问题能避开）。已是简体或纯拉丁的文本过一遍是恒等的，
/// 可以无脑调用。
pub(crate) fn to_simplified(text: &str) -> String {
    zhconv::zhconv(text, zhconv::Variant::ZhHans)
}

/// 去掉纯文本版 Gutenberg 的页眉页脚。
///
/// 纯文本用 `*** START OF THE PROJECT GUTENBERG EBOOK … ***` 与
/// `*** END OF … ***` 两行标记正文边界，标记之外全是制作信息和许可声明。
/// 没找到标记就原样返回（不是 Gutenberg 的书不受影响）。
fn strip_gutenberg_markers(text: &str) -> &str {
    let mut body = text;

    if let Some(pos) = find_ascii_ci(body, "*** START OF THE PROJECT GUTENBERG") {
        // 切到标记所在行的行尾之后
        if let Some(line_end) = body[pos..].find('\n') {
            body = &body[pos + line_end + 1..];
        }
    }

    if let Some(pos) = find_ascii_ci(body, "*** END OF THE PROJECT GUTENBERG") {
        body = &body[..pos];
    }

    body.trim()
}

/// 整段都是 Gutenberg 样板文字吗（书名页 / 许可声明）。
///
/// 按 id 拦是第一道防线；这里按内容兜底 —— 别的工具重排过的 EPUB 可能换了 id，
/// 但那两段文字始终在。只看开头 600 字，避免正文里偶然提到 Gutenberg 被误伤。
fn is_gutenberg_boilerplate_text(text: &str) -> bool {
    let head: String = text
        .chars()
        .take(600)
        .collect::<String>()
        .to_ascii_lowercase();

    head.contains("the project gutenberg ebook of")
        || head.contains("start of the project gutenberg")
        || head.contains("end of the project gutenberg")
        || head.contains("project gutenberg license")
        || (head.contains("gutenberg") && head.contains("limited warranty"))
}

/// 是否「中文语境」的字符 —— 汉字/假名/谚文，外加**中文标点**。
///
/// 标点必须算进来：断行经常正好落在「。」「」之前或之后，
/// 不认它们就会在中文句子里插出一个多余的空格。
fn is_cjk_ish(c: char) -> bool {
    let cp = c as u32;
    is_cjk(c)
        || (0x3000..=0x303F).contains(&cp) // 中文标点 。、「」《》…
        || (0xFF00..=0xFFEF).contains(&cp) // 全角字符 ，？！：；
        || (0x2018..=0x201D).contains(&cp) // 弯引号 ‘ ’ “ ”
        || c == '—'
        || c == '…'
}

/// 把「硬折行」还原成整段 —— **必须在分出章节之后**再调用。
///
/// Project Gutenberg 的排版源文本是硬折行的（实测《西遊記》正文：行长度中位数 35 字，
/// 78.9% 的行落在 30–45 字），生成的 EPUB 里一行就是一句的中间，不还原的话
/// 满屏都是断在句子中间的换行 —— 这就是「格式很乱」的主因。
///
/// 但**不能提前到 `clean_html` 里做**。实测《紅樓夢》的 12 个 chunk 排版并不一致：
/// 有的每段一个 `<p>`（`<p>` 才是结构，换行只是折行），
/// 有的整个 chunk 只有 6 个 `<p>`、却有 3106 个换行（**换行才是唯一结构**）。
/// 提前还原会把后者 88KB 的正文压成几行，章节标题再也不是行首，分章从 130 章崩到 42 章。
///
/// 所以规则是：
/// - **单个**换行 = 排版折行 → 两侧都是中文就删掉，否则补一个空格
/// - **连续两个以上**换行 = 真正的段落分隔 → 保留
///
/// 注意：`<pre>` 里的换行是有意义的，这里会被一并抹平。Gutenberg 的韵文用 `<br/>`
/// 分行（保留为单个换行 → 会被还原），所以韵文会合成一段 —— 这是已知取舍。
fn unwrap_wrapped_lines(text: &str) -> String {
    // 先干掉「整行都是装饰符」的分隔线 —— 实测《紅樓夢》每个回目后面都跟着
    // 一整行破折号，留着的话用户得敲四十个「—」。
    // 换成空行而不是删掉，这样夹在正文中间时仍算段落分隔，不会把两段粘起来。
    let text: String = text
        .lines()
        .map(|l| if is_decoration_line(l) { "" } else { l })
        .collect::<Vec<_>>()
        .join("\n");

    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut last_visible: Option<char> = None;
    let mut i = 0;

    while i < chars.len() {
        let c = chars[i];

        if c == '\n' || c == '\r' {
            // 吃掉「换行 + 随后的缩进」，只数其中真正的换行个数
            let mut newlines = 0;
            while i < chars.len() && chars[i].is_whitespace() {
                if chars[i] == '\n' {
                    newlines += 1;
                }
                i += 1;
            }
            let next_visible = chars.get(i).copied();

            if newlines >= 2 {
                // 真正的段落分隔
                out.push('\n');
                last_visible = Some('\n');
            } else {
                let joins_tight = matches!(
                    (last_visible, next_visible),
                    (Some(a), Some(b)) if is_cjk_ish(a) && is_cjk_ish(b)
                );
                if !joins_tight {
                    out.push(' ');
                    last_visible = Some(' ');
                }
            }
            continue;
        }

        out.push(c);
        if !c.is_whitespace() {
            last_visible = Some(c);
        }
        i += 1;
    }

    out
}

/// 整行都是装饰符的「分隔线」吗（破折号、等号、星号、波浪线…）。
///
/// 至少 3 个字符才算，免得把正文里孤零零的一个「—」误删。
fn is_decoration_line(line: &str) -> bool {
    let trimmed = line.trim();
    let count = trimmed.chars().count();
    if count < 3 {
        return false;
    }
    trimmed.chars().all(|c| {
        matches!(
            c,
            '—' | '–' | '-' | '－' | '_' | '＿' | '=' | '＝' | '~' | '～'
                | '*' | '＊' | '﹏' | '·' | '・' | '┄' | '─' | '━' | '　'
        )
    })
}

/// 清理章节标题里的排版噪声。
///
/// 实测原始标题长这样：
/// ```text
/// 第五十回　 蘆雪庵爭聯即景詩　暖香塢雅制春燈謎
/// 第五回—————————————————————- 游幻境指迷十二釵　飲仙醪曲演紅樓夢
/// ```
/// 中间那串破折号、全角空格、连续空格都是排版装饰，打出来毫无意义，
/// 统一收成单个空格。
fn clean_chapter_title(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_gap = false;

    for c in raw.chars() {
        let is_gap = c.is_whitespace()
            || c == '—'   // 破折号
            || c == '–'
            || c == '-'   // 装饰用的连字符串
            || c == '·'
            || c == '・'
            || c == '～'
            || c == '~';

        if is_gap {
            if !in_gap {
                out.push(' ');
                in_gap = true;
            }
        } else {
            out.push(c);
            in_gap = false;
        }
    }

    out.trim().to_string()
}

/// Decode HTML character references in a single left-to-right pass.///
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

    // 在**保留行结构**的文本上找标题 —— 这是分章的前提。
    for (i, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if is_chapter_heading(trimmed) {
            chapter_starts.push((i, clean_chapter_title(trimmed)));
        }
    }

    if chapter_starts.is_empty() {
        return vec![ParsedChapter {
            title: "Full Text".to_string(),
            content: unwrap_wrapped_lines(text).trim().to_string(),
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

        // 正文从标题行的**下一行**开始 —— 标题已经单独存成 title，
        // 再塞进 content 里会让用户多打一遍。
        let body_start = (start_line + 1).min(end_line);
        let body = lines[body_start..end_line].join("\n");
        let content = unwrap_wrapped_lines(&body).trim().to_string();

        if !content.is_empty() {
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

    // Chinese patterns: 第<数字>回/章/节/節/篇/部/卷
    if is_chinese_chapter_heading(line) {
        return true;
    }

    // 无「第」的卷标题，如「卷三」「卷十二」。
    // 只有短行才算，免得正文里以「卷」开头的句子被当成标题。
    if let Some(rest) = line.strip_prefix('卷') {
        let numerals: String = rest
            .chars()
            .take_while(|c| is_cjk_numeral(*c) || c.is_ascii_whitespace())
            .collect();
        if numerals.chars().any(is_cjk_numeral) && line.chars().count() <= 30 {
            return true;
        }
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

/// 中文数字，含常见异体「〇」「○」「两」，以及 ASCII 数字。
fn is_cjk_numeral(c: char) -> bool {
    matches!(
        c,
        '零'
            | '一'
            | '二'
            | '三'
            | '四'
            | '五'
            | '六'
            | '七'
            | '八'
            | '九'
            | '十'
            | '百'
            | '千'
            | '万'
            | '两'
            // 〇 U+3007 与 ○ U+25CB 是**两个不同的字**，都会有人用。
            // 《西遊記》就写成「第一○回」…「第五○回」（U+25CB）——
            // 只收 U+3007 的话，那 5 回会被整章漏掉。
            | '〇'
            | '○'
            // 廿/卅：古籍里表示二十/三十
            | '廿'
            | '卅'
    ) || c.is_ascii_digit()
}

/// 中文章节标题：`第<数字串><标记字>`，标记字为 回/章/节/節/篇/部/卷。
///
/// 结构上不会误判，靠两点：
/// 1. `split_into_chapters` 只对 `line.trim()` 调用 `is_chapter_heading`，
///    所以句中出现的「第三回」永远不可能在行首 → 不匹配。
/// 2. 数字串之后必须**紧跟**标记字，所以「第三次」「第一件事」不匹配。
///
/// 这是中文古典小说的关键：「第五回 亂蟠桃大聖偷丹」这种回目，
/// Project Gutenberg 的 EPUB 里既不在 TOC 中、也不是 `<h1>`-`<h4>`，
/// 用传统的「只认 `第…章`」规则整本书会被当成 1 章。
fn is_chinese_chapter_heading(line: &str) -> bool {
    let mut chars = line.chars().peekable();

    if chars.next() != Some('第') {
        return false;
    }

    // 数字串，允许中间夹空白（「第 12 回」）
    let mut digits = 0usize;
    while let Some(&c) = chars.peek() {
        if c.is_ascii_whitespace() || is_cjk_numeral(c) {
            if !c.is_ascii_whitespace() {
                digits += 1;
            }
            chars.next();
        } else {
            break;
        }
    }
    if digits == 0 {
        return false;
    }

    while matches!(chars.peek(), Some(&c) if c.is_ascii_whitespace()) {
        chars.next();
    }

    matches!(chars.next(), Some('回' | '章' | '节' | '節' | '篇' | '部' | '卷'))
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

    // ── 中文章节标题识别 ────────────────────────────────────────────────────

    #[test]
    fn recognizes_chinese_chapter_headings() {
        // 古典小说的回目 —— 这是本次修复的核心
        assert!(is_chapter_heading("第五回     亂蟠桃大聖偷丹　反天宮諸神捉怪"));
        assert!(is_chapter_heading("第一百零八回 三国"));
        assert!(is_chapter_heading("第一回 宴桃園豪傑三結義"));
        // 现代章节标记
        assert!(is_chapter_heading("第一章 起始"));
        assert!(is_chapter_heading("第12节 概述"));
        assert!(is_chapter_heading("第 9 章 空格分隔"));
        assert!(is_chapter_heading("第一部 上"));
        assert!(is_chapter_heading("第二卷"));
        assert!(is_chapter_heading("第三篇 附录"));
        // 裸「卷」
        assert!(is_chapter_heading("卷三"));
        assert!(is_chapter_heading("卷十二"));
    }

    #[test]
    fn rejects_non_headings() {
        // 行中出现的「第三回」：调用方传进来的是 trim 过的整行，
        // 所以这种绝不可能是行首 → 不匹配。
        assert!(!is_chapter_heading("他把第三回的信寄了出去"));
        // 数字后面的字不是章节标记
        assert!(!is_chapter_heading("第三次"));
        assert!(!is_chapter_heading("第一件事"));
        assert!(!is_chapter_heading("回龙观小区"));
        assert!(!is_chapter_heading("前言"));
        // 单独一个「卷」没有数字
        assert!(!is_chapter_heading("卷"));
        // 正文里以「卷」开头的长句不能被当成标题（长度兜底）
        assert!(!is_chapter_heading(
            "卷起了袖子就往屋里走，一边走一边喊着他娘的名字，声音大得整条巷子都听得见"
        ));
    }

    #[test]
    fn splits_a_plain_text_dump_where_newlines_are_the_only_structure() {
        // 回归：《紅樓夢》的某些 chunk 只有几个 <p>、却有三四千个换行 ——
        // 换行就是它唯一的结构。标题必须仍在行首被认出来。
        let text = "寶玉听了笑道：「正是。」\n\
                    黛玉道：「你說的是。」\n\
                    第二十回　　 王熙鳳正言彈妒意　林黛玉俏語謔嬌音\n\
                    ———————————————————————————\n\
                    話說寶玉在林黛玉房中說「耗子精」，寶釵撞來。\n\
                    三人正在房中互相譏刺取笑。\n\
                    第二十一回　 賢襲人嬌嗔箴寶玉　俏平儿軟語救賈璉\n\
                    話說史湘云跑了出來。";

        let chapters = split_into_chapters(text);
        assert_eq!(chapters.len(), 2, "两回都该切出来");
        assert_eq!(chapters[0].title, "第二十回 王熙鳳正言彈妒意 林黛玉俏語謔嬌音");
        assert_eq!(chapters[1].title, "第二十一回 賢襲人嬌嗔箴寶玉 俏平儿軟語救賈璉");
        // 正文里的折行要还原，破折号装饰行不该出现在正文开头
        assert!(chapters[0].content.starts_with("話說寶玉在林黛玉房中"));
        assert!(!chapters[0].content.contains('\n'), "整段该还原成一行");
    }

    #[test]
    fn cleans_decorative_chapter_titles() {
        assert_eq!(
            clean_chapter_title("第五回—————————————————————- 游幻境指迷十二釵　飲仙醪曲演紅樓夢"),
            "第五回 游幻境指迷十二釵 飲仙醪曲演紅樓夢"
        );
        assert_eq!(
            clean_chapter_title("第五十回　 蘆雪庵爭聯即景詩　暖香塢雅制春燈謎"),
            "第五十回 蘆雪庵爭聯即景詩 暖香塢雅制春燈謎"
        );
        assert_eq!(
            clean_chapter_title("第一回     靈根育孕源流出　心性修持大道生"),
            "第一回 靈根育孕源流出 心性修持大道生"
        );
    }

    #[test]
    fn chapter_title_is_not_repeated_in_its_content() {
        // 标题单独存了 title，正文里不该再让用户多打一遍
        let text = "第一回 靈根育孕源流出\n詩曰：混沌未分天地亂。\n話說天地初分。";
        let chapters = split_into_chapters(text);
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].title, "第一回 靈根育孕源流出");
        assert!(!chapters[0].content.contains("第一回"));
        assert!(chapters[0].content.starts_with("詩曰"));
    }

    #[test]
    fn splits_classical_novel_into_chapters() {
        let text = "第五回 亂蟠桃大聖偷丹\n\n卻說那猴王自得了金箍棒，日日操演。\n\n第六回 觀音赴會問原因\n\n菩薩領了佛旨，徑上東土。\n\n第七回 八卦爐中逃大聖\n\n那大聖被推入爐中。";
        let chapters = split_into_chapters(text);
        assert_eq!(chapters.len(), 3);
        assert!(chapters[0].title.starts_with("第五回"));
        assert!(chapters[1].title.starts_with("第六回"));
        assert!(chapters[2].title.starts_with("第七回"));
    }

    #[test]
    fn does_not_split_on_mid_sentence_chapter_reference() {
        // 「第三回」出现在句子中间 —— 整篇必须仍是一章。
        let text = "他翻開書，看到第三回 的段落時愣了一下，這才想起當年的約定。\n\n後來他又讀了幾頁，便合上了書。";
        let chapters = split_into_chapters(text);
        assert_eq!(chapters.len(), 1);
        assert_eq!(chapters[0].title, "Full Text");
    }

    #[test]
    fn recognizes_the_white_circle_numeral() {
        // 《西遊記》写成「第一○回」用的就是 U+25CB，不是 U+3007 〇
        assert!(is_chapter_heading("第一○回 黃風嶺唐僧有難"));
        assert!(is_chapter_heading("第五○回 情亂性從因愛欲"));
        // U+3007 〇 也得认
        assert!(is_chapter_heading("第一〇回 测试"));
        // 廿 / 卅
        assert!(is_chapter_heading("第廿回 测试"));
    }

    // ── Gutenberg 样板剔除 ──────────────────────────────────────────────────

    #[test]
    fn strips_plain_text_gutenberg_markers() {
        let text = "\u{FEFF}The Project Gutenberg eBook of 西遊記\n\
                    This eBook is for the use of anyone anywhere...\n\
                    \n\
                    *** START OF THE PROJECT GUTENBERG EBOOK 西遊記 ***\n\
                    \n\
                    第一回 靈根育孕源流出\n\
                    詩曰：混沌未分天地亂。\n\
                    \n\
                    *** END OF THE PROJECT GUTENBERG EBOOK 西遊記 ***\n\
                    \n\
                    Updated editions will replace the previous one...\n";

        let body = strip_gutenberg_markers(text);
        assert!(body.starts_with("第一回"));
        assert!(body.contains("詩曰"));
        // 页眉页脚都不该留下
        assert!(!body.contains("START OF THE PROJECT GUTENBERG"));
        assert!(!body.contains("END OF THE PROJECT GUTENBERG"));
        assert!(!body.contains("Updated editions"));
    }

    #[test]
    fn leaves_books_without_markers_untouched() {
        let plain = "第一章 起始\n\n这是一本普通的书。";
        assert_eq!(strip_gutenberg_markers(plain), plain);
    }

    #[test]
    fn spots_gutenberg_front_and_back_matter() {
        // 书名页
        assert!(is_gutenberg_boilerplate_text(
            "The Project Gutenberg eBook of 西遊記 Title: 西遊記 Author: Cheng'en Wu \
             Release date: December 22, 2007 [eBook #23962] Language: Chinese"
        ));
        // 许可声明
        assert!(is_gutenberg_boilerplate_text(
            "THE FULL PROJECT GUTENBERG™ LICENSE Please read this before you distribute \
             or use this work. LIMITED WARRANTY, DISCLAIMER OF DAMAGES"
        ));
        // 普通正文不该被误伤
        assert!(!is_gutenberg_boilerplate_text("第一回 靈根育孕源流出　心性修持大道生"));
        assert!(!is_gutenberg_boilerplate_text("且說他三眾在路餐風宿水，帶月披星。"));
    }

    #[test]
    fn keeps_the_novel_that_shares_a_file_with_the_front_matter() {
        // 回归：曾经按 spine id 把 `pg-header` 整个文件跳过，结果《紅樓夢》
        // 掉了一大半正文 —— 版权页和小说开头同处一个 chunk。
        // 这个用例锁住「只裁掉标记之前的部分，标记之后全保留」。
        let chunk = "The Project Gutenberg eBook of 紅樓夢\nTitle: 紅樓夢\n\
                     Language: Chinese\n\
                     *** START OF THE PROJECT GUTENBERG EBOOK 紅樓夢 ***\n\
                     第一回 甄士隱夢幻識通靈\n\
                     此開卷第一回也。作者自云：因曾歷過一番夢幻之後。";
        let body = strip_gutenberg_markers(chunk);

        assert!(body.starts_with("第一回"), "正文必须保留，实际 {:?}", &body[..body.len().min(40)]);
        assert!(body.contains("此開卷第一回也"));
        assert!(!body.contains("Project Gutenberg eBook of"));
    }

    // ── 繁 → 简 ────────────────────────────────────────────────────────────

    #[test]
    fn converts_traditional_to_simplified() {
        assert_eq!(to_simplified("西遊記"), "西游记");
        assert_eq!(to_simplified("紅樓夢"), "红楼梦");
        // 词级转换：不能把「頭髮」错转成「头發」
        assert_eq!(to_simplified("頭髮"), "头发");
        // 已是简体 / 纯拉丁 → 恒等
        assert_eq!(to_simplified("西游记"), "西游记");
        assert_eq!(to_simplified("Chapter One"), "Chapter One");
    }

    // ── 去掉 HTML 源码里的硬折行 ────────────────────────────────────────────

    #[test]
    fn unwraps_hard_wrapped_chinese_lines() {
        // Gutenberg 的正文就是这个形状：一句按 ~35 字硬折成三行
        let wrapped = "三藏道：「悟空，你看那日落\n西山藏火鏡，月升東海現冰輪。幸而道傍有一人家，我們且借宿一宵，明日再走\n。」八戒道：「說得是。」";
        let unwrapped = unwrap_wrapped_lines(wrapped);
        assert_eq!(
            unwrapped,
            "三藏道：「悟空，你看那日落西山藏火鏡，月升東海現冰輪。幸而道傍有一人家，我們且借宿一宵，明日再走。」八戒道：「說得是。」"
        );
        // 关键：换行落在句中标点前后也不能插进空格
        assert!(!unwrapped.contains(' '), "中文断行处不该出现空格: {:?}", unwrapped);
    }

    #[test]
    fn unwraps_latin_lines_to_a_space() {
        // 西文断行处本来就有空格，应该还原成一个空格而不是粘在一起
        assert_eq!(
            unwrap_wrapped_lines("The quick brown fox\njumps over the lazy dog"),
            "The quick brown fox jumps over the lazy dog"
        );
    }

    #[test]
    fn keeps_blank_lines_as_paragraph_breaks() {
        // 连续两个换行是**真正的**段落分隔，必须保留 ——
        // 否则整章会变成一个巨大的单段。
        let text = "第一段的内容。\n\n第二段的内容。\n\n\n第三段的内容。";
        let unwrapped = unwrap_wrapped_lines(text);
        assert_eq!(unwrapped, "第一段的内容。\n第二段的内容。\n第三段的内容。");
    }

    #[test]
    fn keeps_real_line_breaks_from_br_and_p() {
        // <br/> 与 <p> 产生的换行是真换行，不能被抹掉（Gutenberg 的韵文靠这个分行）
        let cleaned = clean_html("<p>法本從心生，還是從心滅。<br/>生滅盡由誰？</p><p>第二回 悟徹菩提</p>", None);
        assert_eq!(
            cleaned,
            "法本從心生，還是從心滅。\n生滅盡由誰？\n\n第二回 悟徹菩提"
        );
    }

    /// 对真实 EPUB 跑一遍分章，用环境变量门控以免默认测试碰磁盘/网络。
    /// 主要用于验证 Project Gutenberg 的中文古典小说能切出回目。
    ///
    /// ```text
    /// DAZIJI_EPUB_DIR='C:\path\to\epubs' cargo test --no-default-features --lib -- --nocapture real_epub_import
    /// ```
    #[test]
    fn real_epub_import() {
        let Ok(dir) = std::env::var("DAZIJI_EPUB_DIR") else {
            println!("DAZIJI_EPUB_DIR not set — skipping");
            return;
        };
        let mut checked = 0;
        for entry in std::fs::read_dir(&dir).unwrap().flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase())
                != Some("epub".to_string())
            {
                continue;
            }
            let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
            match parse_epub_internal(&path.to_string_lossy(), None) {
                Ok((title, author, chapters, _cover)) => {
                    let total: usize = chapters.iter().map(|c| c.content.chars().count()).sum();
                    println!(
                        "OK   {} | title={:?} author={:?} chapters={} chars={} first={:?}",
                        name,
                        title,
                        author,
                        chapters.len(),
                        total,
                        chapters.first().map(|c| c.title.clone()).unwrap_or_default(),
                    );
                }
                Err(message) => println!("ERR  {} | {}", name, message),
            }
            checked += 1;
        }
        println!("checked {} EPUB file(s) in {}", checked, dir);
    }
}



