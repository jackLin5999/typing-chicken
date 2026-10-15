/** A finished practice session, as stored in SQLite and shown on the 统计 page. */
export interface PracticeSession {
  id: string;
  bookId: string;
  bookTitle: string;
  chapterIndex: number;
  chapterTitle: string;
  wpm: number;
  accuracy: number;
  durationSeconds: number;
  correctKeystrokes: number;
  totalKeystrokes: number;
  incorrectChars: number;
  wordsCompleted: number;
  /** True when this came from 错字重练 rather than a normal chapter run. */
  isDrill: boolean;
  /** SQLite `datetime('now')` — UTC, `YYYY-MM-DD HH:MM:SS`. */
  createdAt: string;
}
