import { create } from "zustand";
import type { TypingStats } from "@/types/typing";
import { getImageMarkerLength, isAutoSkipped, isPunctuation } from "@/lib/utils";
import { useSettingsStore } from "./settingsSlice";

interface TypingState {
  isActive: boolean;
  isPaused: boolean;
  isComplete: boolean;
  /**
   * True once the user has actually pressed a key in this session.
   *
   * The WPM clock stays at 0 until then, so the time spent getting oriented
   * after opening a book is not counted as typing time. Only real keystrokes
   * set this — the automatic whitespace skip does not.
   */
  hasStarted: boolean;
  stats: TypingStats;
  targetText: string;
  cursorIndex: number;
  /** Positions (indices) where the user typed the wrong character. */
  incorrectIndices: number[];

  // Actions
  startSession: (text: string) => void;
  pauseSession: () => void;
  resumeSession: () => void;
  endSession: () => void;
  advanceCursor: (correct: boolean) => void;
  /**
   * Move the cursor one position forward without counting a keystroke — the
   * shared step used by every auto-skip loop (whitespace, 跳过标点, IME
   * newlines). Image markers are consumed by the step as well.
   */
  skipUncounted: () => void;
  updateStats: (partial: Partial<TypingStats>) => void;
  /** Backspace — move cursor back & revert stats for the undone character. */
  backspace: () => void;
  setCursorIndex: (index: number) => void;
  setIncorrectIndices: (indices: number[]) => void;
}

/**
 * Word-count contribution of a single character.
 *   CJK ideograph  → 1 word    (each character is a word)
 *   Latin letter   → 0.2 words (standard 5-char-per-word convention)
 *   Everything else → 0
 */
function charWordWeight(ch: string): number {
  if (/[一-鿿㐀-䶿]/.test(ch)) return 1;
  if (/[a-zA-Z]/.test(ch)) return 0.2;
  return 0;
}

/** Skip past any [IMG:...] markers at the given position. */
function skipMarkersAt(text: string, index: number): number {
  let idx = index;
  while (idx < text.length && getImageMarkerLength(text, idx) > 0) {
    idx += getImageMarkerLength(text, idx);
  }
  return idx;
}

/** Read the 跳过标点 flag at call time, so a mid-session toggle applies at once. */
function skipPunctuation(): boolean {
  return useSettingsStore.getState().skipPunctuation;
}

/**
 * Where the cursor lands when it moves forward from `index`: past image
 * markers, and past punctuation too while 跳过标点 is on.
 *
 * Whitespace is deliberately NOT in this set. The cursor has always been
 * allowed to rest on it — the engine's skip loop clears it on the next
 * keystroke, and pressing Enter jumps a whole paragraph break at once.
 */
function landingIndex(text: string, index: number, skipPunct: boolean): number {
  let idx = skipMarkersAt(text, index);
  if (skipPunct) {
    while (idx < text.length && isPunctuation(text[idx])) {
      idx = skipMarkersAt(text, idx + 1);
    }
  }
  return idx;
}

const defaultStats: TypingStats = {
  wpm: 0,
  accuracy: 100,
  elapsedSeconds: 0,
  totalKeystrokes: 0,
  correctKeystrokes: 0,
  incorrectKeystrokes: 0,
  wordsCompleted: 0,
};

const INITIAL = {
  isActive: false,
  isPaused: false,
  isComplete: false,
  hasStarted: false,
  stats: { ...defaultStats },
  targetText: "",
  cursorIndex: 0,
  incorrectIndices: [] as number[],
};

export const useTypingStore = create<TypingState>((set) => ({
  ...INITIAL,

  startSession: (text) =>
    set({
      ...INITIAL,
      isActive: true,
      targetText: text,
      cursorIndex: landingIndex(text, 0, skipPunctuation()),
    }),

  pauseSession: () => set({ isPaused: true }),
  resumeSession: () => set({ isPaused: false }),
  endSession: () => set({ ...INITIAL }),

  advanceCursor: (correct) =>
    set((s) => {
      const rawIndex = s.cursorIndex + 1;
      // Auto-skip past image markers, and past punctuation while 跳过标点 is on.
      // Skipping punctuation here (rather than waiting for the next keystroke)
      // is what lets a chapter that ends in 「。」 still complete on its last
      // real character.
      const newIndex = landingIndex(s.targetText, rawIndex, skipPunctuation());
      const total = s.stats.totalKeystrokes + 1;
      const correctTotal = s.stats.correctKeystrokes + (correct ? 1 : 0);
      const ch = s.targetText[s.cursorIndex];
      const wordDelta = correct ? charWordWeight(ch) : 0;
      return {
        cursorIndex: newIndex,
        isComplete: newIndex >= s.targetText.length,
        hasStarted: true,
        incorrectIndices: correct
          ? s.incorrectIndices
          : [...s.incorrectIndices, s.cursorIndex],
        stats: {
          ...s.stats,
          totalKeystrokes: total,
          correctKeystrokes: correctTotal,
          incorrectKeystrokes: s.stats.incorrectKeystrokes + (correct ? 0 : 1),
          accuracy: total > 0
            ? Math.round((correctTotal / total) * 10000) / 100
            : correct
              ? 100
              : 0,
          wordsCompleted: s.stats.wordsCompleted + wordDelta,
        },
      };
    }),

  skipUncounted: () =>
    set((s) => {
      const rawIndex = s.cursorIndex + 1;
      const newIndex = skipMarkersAt(s.targetText, rawIndex);
      return {
        cursorIndex: newIndex,
        isComplete: newIndex >= s.targetText.length,
      };
    }),

  updateStats: (partial) =>
    set((s) => ({
      stats: { ...s.stats, ...partial },
    })),

  /** Backspace: move cursor back one position and revert stats if the undone
   *  character was a real keystroke (not auto-skipped whitespace/punctuation). */
  backspace: () =>
    set((s) => {
      if (s.cursorIndex <= 0) return {};
      const prevIdx = s.cursorIndex - 1;
      const charAtPrev = s.targetText[prevIdx];

      // Auto-skipped characters were never a keystroke — nothing to revert
      if (isAutoSkipped(charAtPrev, skipPunctuation())) {
        return {
          cursorIndex: prevIdx,
          incorrectIndices: s.incorrectIndices.filter((i) => i < prevIdx),
        };
      }

      // A real keystroke — revert it
      const wasIncorrect = s.incorrectIndices.includes(prevIdx);
      const newTotal = Math.max(0, s.stats.totalKeystrokes - 1);
      const newCorrect = wasIncorrect
        ? s.stats.correctKeystrokes
        : Math.max(0, s.stats.correctKeystrokes - 1);
      const newIncorrect = wasIncorrect
        ? Math.max(0, s.stats.incorrectKeystrokes - 1)
        : s.stats.incorrectKeystrokes;
      // Reverse the word-count contribution (only for correct chars)
      const wordDelta = wasIncorrect ? 0 : charWordWeight(charAtPrev);

      return {
        cursorIndex: prevIdx,
        incorrectIndices: s.incorrectIndices.filter((i) => i < prevIdx),
        stats: {
          ...s.stats,
          totalKeystrokes: newTotal,
          correctKeystrokes: newCorrect,
          incorrectKeystrokes: newIncorrect,
          accuracy:
            newTotal > 0
              ? Math.round((newCorrect / newTotal) * 10000) / 100
              : 100,
          wordsCompleted: Math.max(0, s.stats.wordsCompleted - wordDelta),
        },
      };
    }),

  setCursorIndex: (index) =>
    set((s) => {
      // Restored progress can land on punctuation that 跳过标点 now travels
      // over — step to the first character the user actually has to type.
      const cursorIndex = landingIndex(s.targetText, index, skipPunctuation());
      return {
        cursorIndex,
        incorrectIndices: s.incorrectIndices.filter((i) => i < cursorIndex),
      };
    }),

  setIncorrectIndices: (indices) =>
    set({ incorrectIndices: indices }),
}));
