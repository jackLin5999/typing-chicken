use crate::{lock_db, AppState};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::State;

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
}

/// Import a book from the given file path into the app's managed storage.
/// Parses the file, extracts chapters, and persists metadata.
#[tauri::command]
pub async fn import_book(
    state: State<'_, AppState>,
    file_path: String,
) -> Result<ImportedBook, String> {
    let path = PathBuf::from(&file_path);
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

    let (title, author, chapters, cover_image) = match extension.as_str() {
        "epub" => super::parser::parse_epub_internal(&file_path, Some(&book_dir))?,
        "txt" => super::parser::parse_txt_internal(&file_path)?,
        "pdf" => super::parser::parse_pdf_internal(&file_path)?,
        _ => return Err(format!("Unsupported file type: .{}", extension)),
    };

    let chapter_count = chapters.len();
    // Count total words across all chapters
    let total_words: usize = chapters
        .iter()
        .map(|c| c.content.split_whitespace().count())
        .sum();

    // Copy the original file into app data for permanence
    let stored_path = book_dir.join(path.file_name().unwrap_or_default());
    fs::copy(&path, &stored_path).map_err(|e| e.to_string())?;

    db.insert_book(
        &book_id,
        &title,
        &author,
        stored_path.to_str().unwrap_or(""),
        &extension,
        chapter_count as i32,
        total_words as i32,
        cover_image.as_deref(),
    )
    .map_err(|e| e.to_string())?;

    // Insert each chapter
    for (idx, chapter) in chapters.iter().enumerate() {
        db.insert_chapter(
            &uuid::Uuid::new_v4().to_string(),
            &book_id,
            &chapter.title,
            idx as i32,
            &chapter.content,
            chapter.level as i32,
        )
        .map_err(|e| e.to_string())?;
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
    })
}
