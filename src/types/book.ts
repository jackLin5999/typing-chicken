/** A book imported into the user's library. */
export interface Book {
  id: string;
  title: string;
  author: string;
  filePath: string;
  fileType: "epub" | "txt" | "pdf";
  chapterCount: number;
  totalWords: number;
  currentChapter: number;
  currentPosition: number;
  progressPct: number;
  createdAt: string;
  /** JSON-serialized array of wrong-char indices, e.g. "[3, 7, 12]" */
  incorrectPositions: string;
  /** Filename of the extracted cover image (null if none). */
  coverImage: string | null;
}

/** A single chapter within a book. */
export interface Chapter {
  id: string;
  bookId: string;
  title: string;
  indexOrder: number;
  content: string;
  /** TOC hierarchy level: 0 = top-level, 1 = second-level, 2 = third-level */
  level: number;
}

/** Progress snapshot persisted across sessions. */
export interface Progress {
  bookId: string;
  chapterIndex: number;
  cursorPosition: number;
  progressPct: number;
}
