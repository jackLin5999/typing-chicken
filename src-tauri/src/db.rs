use rusqlite::{Connection, Result};
use std::path::{Path, PathBuf};

pub struct Database {
    conn: Connection,
    books_dir: PathBuf,
}

impl Database {
    /// Open (or create) the SQLite database and run migrations.
    pub fn new(db_path: &Path) -> Result<Self> {
        let books_dir = db_path
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("books");

        std::fs::create_dir_all(&books_dir).ok();

        let conn = Connection::open(db_path)?;

        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")?;

        // ── Schema ────────────────────────────────────────────────────
        conn.execute_batch(
            "
            CREATE TABLE IF NOT EXISTS books (
                id              TEXT PRIMARY KEY,
                title           TEXT NOT NULL,
                author          TEXT NOT NULL DEFAULT 'Unknown Author',
                file_path       TEXT NOT NULL,
                file_type       TEXT NOT NULL,
                chapter_count   INTEGER NOT NULL DEFAULT 0,
                total_words     INTEGER NOT NULL DEFAULT 0,
                current_chapter INTEGER NOT NULL DEFAULT 0,
                current_position INTEGER NOT NULL DEFAULT 0,
                progress_pct    REAL NOT NULL DEFAULT 0.0,
                cover_image     TEXT,
                created_at      TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE TABLE IF NOT EXISTS chapters (
                id              TEXT PRIMARY KEY,
                book_id         TEXT NOT NULL,
                title           TEXT NOT NULL DEFAULT '',
                index_order     INTEGER NOT NULL DEFAULT 0,
                content         TEXT NOT NULL DEFAULT '',
                level           INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_chapters_book
                ON chapters(book_id, index_order);

            CREATE TABLE IF NOT EXISTS settings (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            ",
        )?;

        // Migration: add level column for older databases, only if it doesn't exist
        let has_level_column: bool = conn
            .prepare("SELECT COUNT(*) FROM pragma_table_info('chapters') WHERE name='level'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, i32>(0)))
            .map(|count| count > 0)
            .unwrap_or(false);
        if !has_level_column {
            conn.execute_batch(
                "ALTER TABLE chapters ADD COLUMN level INTEGER NOT NULL DEFAULT 0;",
            )?;
        }

        // Migration: add cover_image column for existing databases
        let has_cover_col: bool = conn
            .prepare("SELECT COUNT(*) FROM pragma_table_info('books') WHERE name='cover_image'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, i32>(0)))
            .map(|count| count > 0)
            .unwrap_or(false);
        if !has_cover_col {
            conn.execute_batch(
                "ALTER TABLE books ADD COLUMN cover_image TEXT;",
            )?;
        }

        // Migration: add incorrect_positions column for persisting wrong-char indices
        let has_incorrect_col: bool = conn
            .prepare("SELECT COUNT(*) FROM pragma_table_info('books') WHERE name='incorrect_positions'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, i32>(0)))
            .map(|count| count > 0)
            .unwrap_or(false);
        if !has_incorrect_col {
            conn.execute_batch(
                "ALTER TABLE books ADD COLUMN incorrect_positions TEXT NOT NULL DEFAULT '[]';",
            )?;
        }

        Ok(Self { conn, books_dir })
    }

    pub fn books_dir(&self) -> &PathBuf {
        &self.books_dir
    }

    // ── Book CRUD ─────────────────────────────────────────────────────

    pub fn insert_book(
        &self,
        id: &str,
        title: &str,
        author: &str,
        file_path: &str,
        file_type: &str,
        chapter_count: i32,
        total_words: i32,
        cover_image: Option<&str>,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO books (id, title, author, file_path, file_type, chapter_count, total_words, cover_image)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![id, title, author, file_path, file_type, chapter_count, total_words, cover_image],
        )?;
        Ok(())
    }

    pub fn get_all_books(&self) -> Result<Vec<super::commands::storage::BookEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, author, file_path, file_type, chapter_count,
                    total_words, current_chapter, current_position, progress_pct,
                    cover_image, created_at, incorrect_positions
             FROM books ORDER BY created_at DESC",
        )?;

        let rows = stmt.query_map([], |row| {
            Ok(super::commands::storage::BookEntry {
                id: row.get(0)?,
                title: row.get(1)?,
                author: row.get(2)?,
                file_path: row.get(3)?,
                file_type: row.get(4)?,
                chapter_count: row.get(5)?,
                total_words: row.get(6)?,
                current_chapter: row.get(7)?,
                current_position: row.get(8)?,
                progress_pct: row.get(9)?,
                cover_image: row.get(10)?,
                created_at: row.get(11)?,
                incorrect_positions: row.get(12)?,
            })
        })?;

        rows.collect()
    }

    pub fn insert_chapter(
        &self,
        id: &str,
        book_id: &str,
        title: &str,
        index_order: i32,
        content: &str,
        level: i32,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO chapters (id, book_id, title, index_order, content, level)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            rusqlite::params![id, book_id, title, index_order, content, level],
        )?;
        Ok(())
    }

    pub fn get_chapters(
        &self,
        book_id: &str,
    ) -> Result<Vec<super::commands::storage::ChapterEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, book_id, title, index_order, content, level
             FROM chapters WHERE book_id = ?1 ORDER BY index_order",
        )?;

        let rows = stmt.query_map(rusqlite::params![book_id], |row| {
            Ok(super::commands::storage::ChapterEntry {
                id: row.get(0)?,
                book_id: row.get(1)?,
                title: row.get(2)?,
                index_order: row.get(3)?,
                content: row.get(4)?,
                level: row.get(5)?,
            })
        })?;

        rows.collect()
    }

    pub fn get_chapter_content(&self, chapter_id: &str) -> Result<String> {
        self.conn.query_row(
            "SELECT content FROM chapters WHERE id = ?1",
            rusqlite::params![chapter_id],
            |row| row.get(0),
        )
    }

    pub fn update_progress(
        &self,
        book_id: &str,
        chapter_index: i32,
        cursor_position: i32,
        incorrect_positions: &str,
    ) -> Result<()> {
        self.conn.execute(
            "UPDATE books SET current_chapter = ?1, current_position = ?2, incorrect_positions = ?3 WHERE id = ?4",
            rusqlite::params![chapter_index, cursor_position, incorrect_positions, book_id],
        )?;
        Ok(())
    }

    pub fn get_progress(
        &self,
        book_id: &str,
    ) -> Result<super::commands::storage::ProgressEntry> {
        self.conn.query_row(
            "SELECT id, current_chapter, current_position, progress_pct
             FROM books WHERE id = ?1",
            rusqlite::params![book_id],
            |row| {
                Ok(super::commands::storage::ProgressEntry {
                    book_id: row.get(0)?,
                    chapter_index: row.get(1)?,
                    cursor_position: row.get(2)?,
                    progress_pct: row.get(3)?,
                })
            },
        )
    }

    pub fn delete_book(&self, book_id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM chapters WHERE book_id = ?1", rusqlite::params![book_id])?;
        self.conn
            .execute("DELETE FROM books WHERE id = ?1", rusqlite::params![book_id])?;
        Ok(())
    }
}
