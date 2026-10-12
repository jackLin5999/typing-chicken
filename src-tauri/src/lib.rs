mod commands;
mod db;

use commands::{import, parser, storage};
use db::Database;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    pub db: Mutex<Database>,
}

/// Helper to lock the mutex, recovering from a poisoned state if a previous
/// handler panicked while holding the lock.
pub fn lock_db(db: &Mutex<Database>) -> std::sync::MutexGuard<'_, Database> {
    db.lock().unwrap_or_else(|poison| {
        eprintln!("[WARN] Database mutex was poisoned — recovering");
        poison.into_inner()
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Set a panic hook that logs the panic instead of silently crashing.
    // This won't prevent the panic, but gives us a useful log for debugging.
    std::panic::set_hook(Box::new(|info| {
        let msg = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "unknown panic".to_string()
        };
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "unknown location".to_string());
        eprintln!("[PANIC] {} at {}", msg, loc);
    }));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir().map_err(|e| {
                eprintln!("Failed to resolve app data directory: {}", e);
                Box::<dyn std::error::Error>::from(format!(
                    "Failed to resolve app data directory: {}",
                    e
                ))
            })?;

            std::fs::create_dir_all(&data_dir).map_err(|e| {
                eprintln!("Failed to create app data directory: {}", e);
                Box::<dyn std::error::Error>::from(format!(
                    "Failed to create app data directory: {}",
                    e
                ))
            })?;

            let db_path = data_dir.join("da_zi_ji.db");
            let database = Database::new(&db_path).map_err(|e| {
                eprintln!("Failed to open database: {}", e);
                Box::<dyn std::error::Error>::from(format!("Failed to open database: {}", e))
            })?;

            app.manage(AppState {
                db: Mutex::new(database),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            import::open_file_dialog,
            import::import_book,
            storage::get_all_books,
            storage::get_book_chapters,
            storage::get_chapter_content,
            storage::update_progress,
            storage::get_progress,
            storage::delete_book,
            storage::get_image_data,
            parser::parse_epub,
            parser::parse_txt,
            parser::parse_pdf,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|_app_handle, _event| {});
}
