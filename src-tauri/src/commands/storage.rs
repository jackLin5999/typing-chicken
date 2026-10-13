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
