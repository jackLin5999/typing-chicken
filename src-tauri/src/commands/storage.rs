use crate::{lock_db, AppState};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::fs;
use tauri::State;

// ── Data structures ───────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BookEntry {
    pub id: String,
    pub title: String,
    pub author: String,
    pub file_path: String,
    pub file_type: String,
    pub chapter_count: i32,
    pub total_words: i32,
    pub current_chapter: i32,
    pub current_position: i32,
    pub progress_pct: f64,
    pub created_at: String,
    pub incorrect_positions: String,
    pub cover_image: Option<String>,
    /// Gutendex id when this book came from the 书库; `None` for local imports.
    pub source_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChapterEntry {
    pub id: String,
    pub book_id: String,
    pub title: String,
    pub index_order: i32,
    pub content: String,
    pub level: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProgressEntry {
    pub book_id: String,
    pub chapter_index: i32,
    pub cursor_position: i32,
    pub progress_pct: f64,
}

/// 一次练习的结果，读回给统计页。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionEntry {
    pub id: String,
    pub book_id: String,
    pub book_title: String,
    pub chapter_index: i32,
    pub chapter_title: String,
    pub wpm: f64,
    pub accuracy: f64,
    pub duration_seconds: i32,
    pub correct_keystrokes: i32,
    pub total_keystrokes: i32,
    pub incorrect_chars: i32,
    pub words_completed: f64,
    /// 错字重练产生的记录（与正常章节练习区分）
    pub is_drill: bool,
    pub created_at: String,
}

/// 前端传过来的新记录。字段与 `SessionEntry` 一致，只是没有 id 和创建时间
/// —— 那两个由数据库决定。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NewSessionInput {
    pub book_id: String,
    pub book_title: String,
    pub chapter_index: i32,
    pub chapter_title: String,
    pub wpm: f64,
    pub accuracy: f64,
    pub duration_seconds: i32,
    pub correct_keystrokes: i32,
    pub total_keystrokes: i32,
    pub incorrect_chars: i32,
    pub words_completed: f64,
    #[serde(default)]
    pub is_drill: bool,
}

/// 一节指法课的成绩。
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LessonProgress {
    pub id: String,
    pub attempts: i32,
    pub best_accuracy: f64,
    pub best_wpm: f64,
    /// 通过达标线的时间；`None` = 还没通过。
    pub completed_at: Option<String>,
}

// ── Commands ──────────────────────────────────────────────────────────────


#[tauri::command]
pub async fn get_all_books(state: State<'_, AppState>) -> Result<Vec<BookEntry>, String> {
    let db = lock_db(&state.db);
    db.get_all_books().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_book_chapters(
    state: State<'_, AppState>,
    book_id: String,
) -> Result<Vec<ChapterEntry>, String> {
    let db = lock_db(&state.db);
    db.get_chapters(&book_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_chapter_content(
    state: State<'_, AppState>,
    chapter_id: String,
) -> Result<String, String> {
    let db = lock_db(&state.db);
    db.get_chapter_content(&chapter_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_progress(
    state: State<'_, AppState>,
    book_id: String,
    chapter_index: i32,
    cursor_position: i32,
    incorrect_positions: String,
) -> Result<(), String> {
    let db = lock_db(&state.db);
    db.update_progress(&book_id, chapter_index, cursor_position, &incorrect_positions)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_progress(
    state: State<'_, AppState>,
    book_id: String,
) -> Result<ProgressEntry, String> {
    let db = lock_db(&state.db);
    db.get_progress(&book_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_book(
    state: State<'_, AppState>,
    book_id: String,
) -> Result<(), String> {
    let db = lock_db(&state.db);
    // Remove stored file
    let book_dir = db.books_dir().join(&book_id);
    if book_dir.exists() {
        std::fs::remove_dir_all(&book_dir).map_err(|e| e.to_string())?;
    }
    db.delete_book(&book_id).map_err(|e| e.to_string())
}

/// Read the persisted user settings (key → JSON-encoded value).
#[tauri::command]
pub async fn get_settings(
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let db = lock_db(&state.db);
    Ok(db
        .get_settings()
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect())
}

/// Persist one setting. Values are JSON-encoded on the frontend so this side
/// stays agnostic about their types.
#[tauri::command]
pub async fn set_setting(
    state: State<'_, AppState>,
    key: String,
    value: String,
) -> Result<(), String> {
    let db = lock_db(&state.db);
    db.set_setting(&key, &value).map_err(|e| e.to_string())
}

/// 记一次练完的练习。返回新记录的 id。
#[tauri::command]
pub async fn record_session(
    state: State<'_, AppState>,
    session: NewSessionInput,
) -> Result<String, String> {
    let db = lock_db(&state.db);
    db.insert_session(&crate::db::NewSession {
        book_id: &session.book_id,
        book_title: &session.book_title,
        chapter_index: session.chapter_index,
        chapter_title: &session.chapter_title,
        wpm: session.wpm,
        accuracy: session.accuracy,
        duration_seconds: session.duration_seconds,
        correct_keystrokes: session.correct_keystrokes,
        total_keystrokes: session.total_keystrokes,
        incorrect_chars: session.incorrect_chars,
        words_completed: session.words_completed,
        is_drill: session.is_drill,
    })
    .map_err(|e| e.to_string())
}

/// 练习历史，最近的在前。`bookId` 传了就只取那本书的。
#[tauri::command]
pub async fn get_sessions(
    state: State<'_, AppState>,
    limit: Option<i32>,
    book_id: Option<String>,
) -> Result<Vec<SessionEntry>, String> {
    let db = lock_db(&state.db);
    db.get_sessions(limit.unwrap_or(500), book_id.as_deref())
        .map_err(|e| e.to_string())
}

/// 清空练习历史（统计页的「清空」）。不可撤销 —— 前端要先确认。
#[tauri::command]
pub async fn clear_sessions(state: State<'_, AppState>) -> Result<(), String> {
    let db = lock_db(&state.db);
    db.clear_sessions().map_err(|e| e.to_string())
}

/// 全部指法课的进度（课程表本身在前端）。
#[tauri::command]
pub async fn get_lesson_progress(
    state: State<'_, AppState>,
) -> Result<Vec<LessonProgress>, String> {
    let db = lock_db(&state.db);
    db.get_lesson_progress().map_err(|e| e.to_string())
}

/// 记一次上课结果。是否达标由前端按各自的目标线判定后传进来。
#[tauri::command]
pub async fn record_lesson_result(
    state: State<'_, AppState>,
    lesson_id: String,
    accuracy: f64,
    wpm: f64,
    passed: bool,
) -> Result<(), String> {
    let db = lock_db(&state.db);
    db.record_lesson_result(&lesson_id, accuracy, wpm, passed)
        .map_err(|e| e.to_string())
}

/// 清空课程进度（「重新开始」）。
#[tauri::command]
pub async fn clear_lesson_progress(state: State<'_, AppState>) -> Result<(), String> {
    let db = lock_db(&state.db);
    db.clear_lesson_progress().map_err(|e| e.to_string())
}

/// Return a base64 data URL for an extracted image file.
#[tauri::command]
pub async fn get_image_data(
    state: State<'_, AppState>,
    book_id: String,
    filename: String,
) -> Result<String, String> {
    let db = lock_db(&state.db);
    let image_path = db.books_dir().join(&book_id).join("images").join(&filename);

    // Prevent path traversal
    let canonical_images = db
        .books_dir()
        .join(&book_id)
        .join("images")
        .canonicalize()
        .map_err(|e| format!("Cannot resolve images dir: {}", e))?;

    let canonical_path = image_path
        .canonicalize()
        .map_err(|e| format!("File not found: {}", e))?;

    if !canonical_path.starts_with(&canonical_images) {
        return Err("Path traversal denied".to_string());
    }

    let bytes = fs::read(&canonical_path).map_err(|e| format!("Read failed: {}", e))?;

    let ext = canonical_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png")
        .to_lowercase();

    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        _ => "image/png",
    };

    let b64 = STANDARD.encode(&bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}
