/** The state of a single character in the typing display. */
export type CharState = "untyped" | "correct" | "incorrect" | "current";

/** Live metrics for an active typing session. */
export interface TypingStats {
  wpm: number;
  accuracy: number; // 0–100
  elapsedSeconds: number;
  totalKeystrokes: number;
  correctKeystrokes: number;
  incorrectKeystrokes: number;
  wordsCompleted: number;
}

/** Snapshot saved at the end of a session. */
export interface SessionResult {
  bookId: string;
  chapterIndex: number;
  wpm: number;
  accuracy: number;
  durationSeconds: number;
  wordsTyped: number;
  completedAt: string;
}
