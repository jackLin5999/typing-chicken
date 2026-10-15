use rusqlite::{Connection, Result};
use std::path::{Path, PathBuf};

pub struct Database {
    conn: Connection,
    books_dir: PathBuf,
}

/// Borrowed input for a book row — avoids cloning every chapter's text twice.
pub struct NewBook<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub author: &'a str,
    pub file_path: &'a str,
    pub file_type: &'a str,
    pub chapter_count: i32,
    pub total_words: i32,
    pub cover_image: Option<&'a str>,
    /// Gutendex id when imported from 书库; `None` for local files.
    pub source_id: Option<&'a str>,
}

pub struct NewChapter<'a> {
    pub title: &'a str,
    pub content: &'a str,
    pub level: i32,
}

/// 一次练习的结果。书名和章节名冗余存一份 —— 书删了历史也还读得懂。
pub struct NewSession<'a> {
    pub book_id: &'a str,
    pub book_title: &'a str,
    pub chapter_index: i32,
    pub chapter_title: &'a str,
    pub wpm: f64,
    pub accuracy: f64,
    pub duration_seconds: i32,
    pub correct_keystrokes: i32,
    pub total_keystrokes: i32,
    pub incorrect_chars: i32,
    pub words_completed: f64,
    /// 错字重练产生的记录，与正常章节练习区分开
    pub is_drill: bool,
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

            -- 每次练完一章记一行，用来画进步曲线。
            -- 刻意**不加外键**：书被删掉之后历史仍然该留着，
            -- 所以书名/章节名都冗余存一份，统计页不依赖 books 表。
            CREATE TABLE IF NOT EXISTS sessions (
                id                 TEXT PRIMARY KEY,
                book_id            TEXT NOT NULL,
                book_title         TEXT NOT NULL DEFAULT '',
                chapter_index      INTEGER NOT NULL DEFAULT 0,
                chapter_title      TEXT NOT NULL DEFAULT '',
                wpm                REAL NOT NULL DEFAULT 0,
                accuracy           REAL NOT NULL DEFAULT 0,
                duration_seconds   INTEGER NOT NULL DEFAULT 0,
                correct_keystrokes INTEGER NOT NULL DEFAULT 0,
                total_keystrokes   INTEGER NOT NULL DEFAULT 0,
                incorrect_chars    INTEGER NOT NULL DEFAULT 0,
                words_completed    REAL NOT NULL DEFAULT 0,
                is_drill           INTEGER NOT NULL DEFAULT 0,
                created_at         TEXT NOT NULL DEFAULT (datetime('now'))
            );

            CREATE INDEX IF NOT EXISTS idx_sessions_created
                ON sessions(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_sessions_book
                ON sessions(book_id, created_at DESC);

            -- 指法课程的进度。`completed_at` 非空 = 这一课通过了达标线。
            -- 课程编号与目标线都在前端（src/lib/lessons.ts），这边只存结果。
            CREATE TABLE IF NOT EXISTS lessons (
                id            TEXT PRIMARY KEY,
                attempts      INTEGER NOT NULL DEFAULT 0,
                best_accuracy REAL NOT NULL DEFAULT 0,
                best_wpm      REAL NOT NULL DEFAULT 0,
                completed_at  TEXT
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

        // Migration: add source_id for books imported from the 书库 (Gutendex id).
        // NULL means a locally-imported file. 可空列，旧数据自动是 NULL。
        let has_source_col: bool = conn
            .prepare("SELECT COUNT(*) FROM pragma_table_info('books') WHERE name='source_id'")
            .and_then(|mut stmt| stmt.query_row([], |row| row.get::<_, i32>(0)))
            .map(|count| count > 0)
            .unwrap_or(false);
        if !has_source_col {
            conn.execute_batch("ALTER TABLE books ADD COLUMN source_id TEXT;")?;
        }

        Ok(Self { conn, books_dir })
    }

    pub fn books_dir(&self) -> &PathBuf {
        &self.books_dir
    }

    // ── Book CRUD ─────────────────────────────────────────────────────

    /// Write a book and all of its chapters in a single transaction, so a
    /// failure part-way through cannot leave a half-imported book behind.
    ///
    /// Uses `unchecked_transaction` (takes `&self`) rather than `transaction`
    /// (which needs `&mut self`); the app has one connection behind one mutex
    /// and never nests transactions, so this is safe.
    pub fn insert_book_with_chapters(
        &self,
        book: &NewBook<'_>,
        chapters: &[NewChapter<'_>],
    ) -> Result<()> {
        let tx = self.conn.unchecked_transaction()?;

        tx.execute(
            "INSERT INTO books (id, title, author, file_path, file_type, chapter_count,
                                total_words, cover_image, source_id)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            rusqlite::params![
                book.id,
                book.title,
                book.author,
                book.file_path,
                book.file_type,
                book.chapter_count,
                book.total_words,
                book.cover_image,
                book.source_id,
            ],
        )?;

        {
            let mut stmt = tx.prepare(
                "INSERT INTO chapters (id, book_id, title, index_order, content, level)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            )?;
            for (idx, chapter) in chapters.iter().enumerate() {
                stmt.execute(rusqlite::params![
                    uuid::Uuid::new_v4().to_string(),
                    book.id,
                    chapter.title,
                    idx as i32,
                    chapter.content,
                    chapter.level,
                ])?;
            }
        }

        tx.commit()
    }

    pub fn get_all_books(&self) -> Result<Vec<super::commands::storage::BookEntry>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, author, file_path, file_type, chapter_count,
                    total_words, current_chapter, current_position, progress_pct,
                    cover_image, created_at, incorrect_positions, source_id
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
                source_id: row.get(13)?,
            })
        })?;

        rows.collect()
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

    // ── Settings ──────────────────────────────────────────────────────

    /// Read every stored setting. Missing keys are simply absent — callers
    /// keep their own defaults for anything not returned.
    pub fn get_settings(&self) -> Result<Vec<(String, String)>> {
        let mut stmt = self.conn.prepare("SELECT key, value FROM settings")?;
        let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
        rows.collect()
    }

    /// Upsert one setting.
    pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            rusqlite::params![key, value],
        )?;
        Ok(())
    }

    // ── Practice sessions ─────────────────────────────────────────────

    /// Append one finished practice session. Returns the new row's id.
    pub fn insert_session(&self, s: &NewSession<'_>) -> Result<String> {
        let id = uuid::Uuid::new_v4().to_string();
        self.conn.execute(
            "INSERT INTO sessions (id, book_id, book_title, chapter_index, chapter_title,
                                   wpm, accuracy, duration_seconds, correct_keystrokes,
                                   total_keystrokes, incorrect_chars, words_completed, is_drill)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            rusqlite::params![
                id,
                s.book_id,
                s.book_title,
                s.chapter_index,
                s.chapter_title,
                s.wpm,
                s.accuracy,
                s.duration_seconds,
                s.correct_keystrokes,
                s.total_keystrokes,
                s.incorrect_chars,
                s.words_completed,
                s.is_drill as i32,
            ],
        )?;
        Ok(id)
    }

    /// Most recent sessions first. `book_id` narrows it to one book.
    pub fn get_sessions(
        &self,
        limit: i32,
        book_id: Option<&str>,
    ) -> Result<Vec<super::commands::storage::SessionEntry>> {
        let map_row = |row: &rusqlite::Row<'_>| {
            Ok(super::commands::storage::SessionEntry {
                id: row.get(0)?,
                book_id: row.get(1)?,
                book_title: row.get(2)?,
                chapter_index: row.get(3)?,
                chapter_title: row.get(4)?,
                wpm: row.get(5)?,
                accuracy: row.get(6)?,
                duration_seconds: row.get(7)?,
                correct_keystrokes: row.get(8)?,
                total_keystrokes: row.get(9)?,
                incorrect_chars: row.get(10)?,
                words_completed: row.get(11)?,
                is_drill: row.get::<_, i32>(12)? != 0,
                created_at: row.get(13)?,
            })
        };

        const COLUMNS: &str = "id, book_id, book_title, chapter_index, chapter_title,
                               wpm, accuracy, duration_seconds, correct_keystrokes,
                               total_keystrokes, incorrect_chars, words_completed,
                               is_drill, created_at";
        let limit = limit.clamp(1, 2000);

        match book_id {
            Some(book) => {
                let mut stmt = self.conn.prepare(&format!(
                    "SELECT {COLUMNS} FROM sessions WHERE book_id = ?1
                     ORDER BY created_at DESC LIMIT ?2"
                ))?;
                let rows = stmt.query_map(rusqlite::params![book, limit], map_row)?;
                rows.collect()
            }
            None => {
                let mut stmt = self.conn.prepare(&format!(
                    "SELECT {COLUMNS} FROM sessions ORDER BY created_at DESC LIMIT ?1"
                ))?;
                let rows = stmt.query_map(rusqlite::params![limit], map_row)?;
                rows.collect()
            }
        }
    }

    /// Wipe the practice history (the 统计页 的「清空」按钮）。
    pub fn clear_sessions(&self) -> Result<()> {
        self.conn.execute("DELETE FROM sessions", [])?;
        Ok(())
    }

    // ── 指法课程进度 ────────────────────────────────────────────────────

    pub fn get_lesson_progress(
        &self,
    ) -> Result<Vec<super::commands::storage::LessonProgress>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, attempts, best_accuracy, best_wpm, completed_at FROM lessons",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(super::commands::storage::LessonProgress {
                id: row.get(0)?,
                attempts: row.get(1)?,
                best_accuracy: row.get(2)?,
                best_wpm: row.get(3)?,
                completed_at: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// 记一次上课结果。
    ///
    /// 最佳成绩只增不减；`completed_at` 一旦写上就不再改动 ——
    /// 重练一次没达标，不该把「已通过」的标记抹掉。
    pub fn record_lesson_result(
        &self,
        id: &str,
        accuracy: f64,
        wpm: f64,
        passed: bool,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO lessons (id, attempts, best_accuracy, best_wpm, completed_at)
             VALUES (?1, 1, ?2, ?3, CASE WHEN ?4 THEN datetime('now') ELSE NULL END)
             ON CONFLICT(id) DO UPDATE SET
                 attempts      = attempts + 1,
                 best_accuracy = MAX(best_accuracy, excluded.best_accuracy),
                 best_wpm      = MAX(best_wpm, excluded.best_wpm),
                 completed_at  = COALESCE(lessons.completed_at, excluded.completed_at)",
            rusqlite::params![id, accuracy, wpm, passed as i32],
        )?;
        Ok(())
    }

    /// 「重新开始课程」用。
    pub fn clear_lesson_progress(&self) -> Result<()> {
        self.conn.execute("DELETE FROM lessons", [])?;
        Ok(())
    }

    pub fn delete_book(&self, book_id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM chapters WHERE book_id = ?1", rusqlite::params![book_id])?;
        self.conn
            .execute("DELETE FROM books WHERE id = ?1", rusqlite::params![book_id])?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 「持久化」的定义就是关掉再打开还在 —— 所以这个用例**真的重开一次数据库**，
    /// 而不是只验证同一个连接里读得回来。
    #[test]
    fn settings_survive_reopening_the_database() {
        let dir = std::env::temp_dir().join(format!("daziji-settings-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("test.db");

        {
            let db = Database::new(&db_path).unwrap();
            // 全新的库应该是空的 —— 前端靠这一点来判断「用默认值」
            assert!(db.get_settings().unwrap().is_empty());

            db.set_setting("theme", "\"dark\"").unwrap();
            db.set_setting("convertToSimplified", "false").unwrap();
            // 同一个 key 写第二次应该是覆盖，不是插两条
            db.set_setting("theme", "\"sepia\"").unwrap();
        }

        let reopened = Database::new(&db_path).unwrap();
        let settings: std::collections::HashMap<String, String> =
            reopened.get_settings().unwrap().into_iter().collect();

        assert_eq!(settings.len(), 2, "覆盖写不该留下第二条记录");
        assert_eq!(settings.get("theme").map(String::as_str), Some("\"sepia\""));
        assert_eq!(
            settings.get("convertToSimplified").map(String::as_str),
            Some("false")
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    fn sample_session<'a>(book_id: &'a str, title: &'a str, wpm: f64) -> NewSession<'a> {
        NewSession {
            book_id,
            book_title: "测试书",
            chapter_index: 0,
            chapter_title: title,
            wpm,
            accuracy: 96.5,
            duration_seconds: 61,
            correct_keystrokes: 200,
            total_keystrokes: 210,
            incorrect_chars: 7,
            words_completed: 40.0,
            is_drill: false,
        }
    }

    #[test]
    fn sessions_round_trip_and_survive_reopening() {
        let dir = std::env::temp_dir().join(format!("daziji-sessions-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("test.db");

        {
            let db = Database::new(&db_path).unwrap();
            assert!(db.get_sessions(500, None).unwrap().is_empty());

            db.insert_session(&sample_session("book-a", "第一章", 42.0)).unwrap();
            db.insert_session(&sample_session("book-a", "第二章", 55.0)).unwrap();
            db.insert_session(&sample_session("book-b", "别的一章", 30.0)).unwrap();

            // 最近的在最前 —— created_at 精度只到秒，同一秒内插入时靠这层保证顺序
            // 不强求，所以这里只断言**集合**而不是顺序。
            let all = db.get_sessions(500, None).unwrap();
            assert_eq!(all.len(), 3);

            // 按书过滤
            let book_a = db.get_sessions(500, Some("book-a")).unwrap();
            assert_eq!(book_a.len(), 2);
            assert!(book_a.iter().all(|s| s.book_id == "book-a"));

            // limit 生效；再断言读回来的字段没串位
            let one = db.get_sessions(1, Some("book-a")).unwrap();
            assert_eq!(one.len(), 1);
            assert_eq!(one[0].chapter_title, "第一章");
            assert_eq!(one[0].accuracy, 96.5);
            assert_eq!(one[0].total_keystrokes, 210);
            assert!(!one[0].is_drill);
        }

        // 「练过的都还在」= 关掉再打开仍然读得到
        let reopened = Database::new(&db_path).unwrap();
        assert_eq!(reopened.get_sessions(500, None).unwrap().len(), 3);

        reopened.clear_sessions().unwrap();
        assert!(reopened.get_sessions(500, None).unwrap().is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn lesson_progress_keeps_the_best_and_never_unpasses() {
        let dir = std::env::temp_dir().join(format!("daziji-lessons-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::new(&dir.join("test.db")).unwrap();

        assert!(db.get_lesson_progress().unwrap().is_empty());

        // 第一次：没过
        db.record_lesson_result("1-1", 80.0, 12.0, false).unwrap();
        let first = db.get_lesson_progress().unwrap();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].attempts, 1);
        assert!(first[0].completed_at.is_none(), "没达标不该标成通过");

        // 第二次：过了
        db.record_lesson_result("1-1", 97.5, 25.0, true).unwrap();
        let second = db.get_lesson_progress().unwrap();
        assert_eq!(second[0].attempts, 2);
        assert_eq!(second[0].best_accuracy, 97.5);
        assert_eq!(second[0].best_wpm, 25.0);
        assert!(second[0].completed_at.is_some());

        // 第三次：发挥失常 —— 最佳成绩只增不减，通过标记也不能被抹掉
        db.record_lesson_result("1-1", 70.0, 9.0, false).unwrap();
        let third = db.get_lesson_progress().unwrap();
        assert_eq!(third[0].attempts, 3);
        assert_eq!(third[0].best_accuracy, 97.5, "最佳成绩不该被更差的一次拉低");
        assert_eq!(third[0].best_wpm, 25.0);
        assert!(
            third[0].completed_at.is_some(),
            "重练没达标不该把「已通过」抹掉"
        );

        db.clear_lesson_progress().unwrap();
        assert!(db.get_lesson_progress().unwrap().is_empty());

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn deleting_a_book_keeps_its_practice_history() {
        // 历史刻意不做外键级联：删掉书不该顺手抹掉「我练过多少次」。
        let dir = std::env::temp_dir().join(format!("daziji-keep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let db = Database::new(&dir.join("test.db")).unwrap();

        db.insert_book_with_chapters(
            &NewBook {
                id: "book-a",
                title: "会被删掉的书",
                author: "某人",
                file_path: "/tmp/x.epub",
                file_type: "epub",
                chapter_count: 0,
                total_words: 0,
                cover_image: None,
                source_id: None,
            },
            &[],
        )
        .unwrap();

        db.insert_session(&sample_session("book-a", "第一章", 42.0)).unwrap();
        db.delete_book("book-a").unwrap();

        assert!(db.get_all_books().unwrap().is_empty(), "书应该没了");
        let history = db.get_sessions(500, None).unwrap();
        assert_eq!(history.len(), 1, "练习历史应该留着");
        assert_eq!(history[0].book_title, "测试书");

        std::fs::remove_dir_all(&dir).ok();
    }
}
