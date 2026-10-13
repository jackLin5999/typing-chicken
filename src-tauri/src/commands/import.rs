use crate::db::{NewBook, NewChapter};
use crate::{lock_db, AppState};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::State;

/// 递归展开拖入路径时的上限，防止拖进一个巨型目录把导入卡死。
const MAX_SCAN_DEPTH: usize = 6;
const MAX_SCAN_FILES: usize = 500;

const IMPORTABLE_EXTENSIONS: [&str; 3] = ["epub", "txt", "pdf"];

/// Opens a native file dialog and returns the selected file path.
#[tauri::command]
pub async fn open_file_dialog() -> Result<Option<String>, String> {
    // The dialog plugin's open() is invoked from the frontend directly via @tauri-apps/plugin-dialog.
    // This command is a fallback for programmatic use.
    Ok(None) // Frontend uses the JS API directly for better UX
}

/// Book metadata returned to the frontend after import.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportedBook {
    pub id: String,
    pub title: String,
    pub author: String,
    pub file_path: String,
    pub file_type: String, // "epub", "txt", "pdf"
    pub chapter_count: usize,
    pub total_words: usize,
    pub cover_image: Option<String>,
    pub created_at: String,
    /// Gutendex id when imported from 书库 — lets the browser mark it as added
    /// immediately, without waiting for a `get_all_books` refresh.
    pub source_id: Option<String>,
}

/// 导入核心，`import_book` 与 `download_and_import_book` 共用。
///
/// 刻意保持**同步**：内部会持有 DB 锁，调用方不得在 `.await` 期间调用它 ——
/// 否则 `MutexGuard` 跨 await 会让整个 future 变成非 `Send`，Tauri 命令编译不过。
/// 网络 IO 一律留在 async 命令里，在调本函数之前完成。
///
/// `source_id` 为 `Some` 表示来自「书库」（Gutendex id），`None` 表示本地文件。
pub(crate) fn import_from_path(
    state: &AppState,
    file_path: &str,
    source_id: Option<&str>,
    convert_to_simplified: bool,
) -> Result<ImportedBook, String> {
    let path = PathBuf::from(file_path);
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    // Generate book_id first — needed for image extraction directory
    let db = lock_db(&state.db);
    let book_id = uuid::Uuid::new_v4().to_string();
    let book_dir = db.books_dir().join(&book_id);
    fs::create_dir_all(&book_dir).map_err(|e| e.to_string())?;

    // 解析；失败就把刚建好的目录删掉，免得在书库里留下一堆空文件夹。
    let parsed = match extension.as_str() {
        "epub" => super::parser::parse_epub_internal(file_path, Some(&book_dir)),
        "txt" => super::parser::parse_txt_internal(file_path),
        "pdf" => super::parser::parse_pdf_internal(file_path),
        _ => {
            let _ = fs::remove_dir_all(&book_dir);
            return Err(format!("Unsupported file type: .{}", extension));
        }
    };
    let (title, author, chapters, cover_image) = match parsed {
        Ok(v) => v,
        Err(e) => {
            let _ = fs::remove_dir_all(&book_dir);
            return Err(e);
        }
    };

    // 繁→简。调用方（书库下载）按用户设置决定要不要转；
    // 本地导入一律传 false，免得把用户自己那本繁体书悄悄改掉。
    let (title, chapters) = if convert_to_simplified {
        (
            super::parser::to_simplified(&title),
            chapters
                .into_iter()
                .map(|c| super::parser::ParsedChapter {
                    title: super::parser::to_simplified(&c.title),
                    content: super::parser::to_simplified(&c.content),
                    level: c.level,
                })
                .collect(),
        )
    } else {
        (title, chapters)
    };

    let chapter_count = chapters.len();
    // Count total words across all chapters
    let total_words: usize = chapters
        .iter()
        .map(|c| c.content.split_whitespace().count())
        .sum();

    // Copy the original file into app data for permanence
    let stored_path = book_dir.join(path.file_name().unwrap_or_default());
    if let Err(e) = fs::copy(&path, &stored_path) {
        let _ = fs::remove_dir_all(&book_dir);
        return Err(e.to_string());
    }

    let new_book = NewBook {
        id: &book_id,
        title: &title,
        author: &author,
        file_path: stored_path.to_str().unwrap_or(""),
        file_type: &extension,
        chapter_count: chapter_count as i32,
        total_words: total_words as i32,
        cover_image: cover_image.as_deref(),
        source_id,
    };
    let new_chapters: Vec<NewChapter> = chapters
        .iter()
        .map(|c| NewChapter {
            title: &c.title,
            content: &c.content,
            level: c.level as i32,
        })
        .collect();

    // 单事务写入：中途失败会整本回滚，不会留下「有书没章节」的残局。
    if let Err(e) = db.insert_book_with_chapters(&new_book, &new_chapters) {
        let _ = fs::remove_dir_all(&book_dir);
        return Err(e.to_string());
    }

    let now = chrono::Utc::now().to_rfc3339();

    Ok(ImportedBook {
        id: book_id,
        title,
        author,
        file_path: stored_path.to_string_lossy().to_string(),
        file_type: extension,
        chapter_count,
        total_words,
        cover_image,
        created_at: now,
        source_id: source_id.map(|s| s.to_string()),
    })
}

/// Import a book from the given file path into the app's managed storage.
/// Parses the file, extracts chapters, and persists metadata.
#[tauri::command]
pub async fn import_book(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<ImportedBook, String> {
    // 本地导入不做繁→简转换 —— 用户拖进来的书应该原样保留。
    import_from_path(&state, &file_path, None, false)
}

/// 把拖入的混合路径展开成「可以导入的文件」列表：目录递归、过滤扩展名。
///
/// 放在 Rust 而不是前端 `fs` 插件：`tauri-plugin-fs` 会拒绝授权范围之外的路径，
/// 从 `D:\Downloads` 拖进来的目录会被挡掉；`std::fs` 没有这个限制。
#[tauri::command]
pub async fn resolve_import_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    for p in paths {
        collect_importable(Path::new(&p), 0, &mut out);
    }
    out.sort();
    out.dedup();
    out.truncate(MAX_SCAN_FILES);
    Ok(out)
}

fn collect_importable(path: &Path, depth: usize, out: &mut Vec<String>) {
    if depth > MAX_SCAN_DEPTH || out.len() >= MAX_SCAN_FILES {
        return;
    }

    if path.is_dir() {
        let Ok(entries) = fs::read_dir(path) else {
            return;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // 跳过隐藏文件与 macOS 压缩包垃圾
            if name.starts_with('.') || name == "__MACOSX" {
                continue;
            }
            collect_importable(&entry.path(), depth + 1, out);
        }
    } else if is_importable(path) {
        out.push(path.to_string_lossy().to_string());
    }
}

fn is_importable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .is_some_and(|e| IMPORTABLE_EXTENSIONS.contains(&e.as_str()))
}
