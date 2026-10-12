import { useEffect, useRef, useCallback } from "react";
import type { MutableRefObject } from "react";
import { useTypingStore } from "@/store";

export interface TypingEngineOptions {
  /**
   * When this ref holds `true`, the Escape key will NOT end the session.
   * Use this to let overlays (chapter panel, settings, etc.) consume Escape first.
   */
  blockEscapeRef?: MutableRefObject<boolean>;
}

/**
 * Core typing engine hook.
 *
 * Uses a hidden <textarea> to capture all keyboard input, including IME
 * composition (Chinese Pinyin, etc.). The textarea is auto-focused while
 * a session is active and re-focused if the user clicks away.
 *
 * Text processing happens on the `input` event so that both direct English
 * keystrokes and IME-committed characters flow through a single code path.
 */
export function useTypingEngine(options: TypingEngineOptions = {}) {
  const { blockEscapeRef } = options;
  const {
    isActive,
    isPaused,
    targetText,
    cursorIndex,
    updateStats,
  } = useTypingStore();

  const startTimeRef = useRef<number>(0);
  const pauseStartRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** Callback ref for the hidden textarea — compatible with React 18 ref types. */
  const setInputRef = useCallback((el: HTMLTextAreaElement | null) => {
    inputRef.current = el;
  }, []);
  /** True while an IME is composing (e.g. Pinyin input in progress). */
  const isComposingRef = useRef(false);

  // ── WPM update timer ──────────────────────────────────────────────────

  useEffect(() => {
    if (isActive && !isPaused) {
      // First keystroke: initialise the clock
      if (startTimeRef.current === 0) {
        startTimeRef.current = Date.now();
      }

      // Coming back from a pause — shift startTime forward by the
      // paused duration so elapsed time doesn't include the pause.
      if (pauseStartRef.current > 0) {
        startTimeRef.current += Date.now() - pauseStartRef.current;
        pauseStartRef.current = 0;
      }

      timerRef.current = setInterval(() => {
        const elapsed = (Date.now() - startTimeRef.current) / 1000;
        const { wordsCompleted } = useTypingStore.getState().stats;
        const minutes = elapsed / 60;
        const wpm = minutes > 0 ? Math.round(wordsCompleted / minutes) : 0;

        updateStats({
          wpm,
          elapsedSeconds: Math.round(elapsed),
        });
      }, 250);
    } else if (isActive && isPaused) {
      // Record when the pause started so we can compensate on resume
      if (pauseStartRef.current === 0) {
        pauseStartRef.current = Date.now();
      }
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isActive, isPaused, updateStats]);

  // Reset timer when session ends
  useEffect(() => {
    if (!isActive) {
      startTimeRef.current = 0;
      pauseStartRef.current = 0;
    }
  }, [isActive]);

  // ── Focus management ──────────────────────────────────────────────────

  // Auto-focus the hidden textarea when the session becomes active.
  useEffect(() => {
    if (isActive && !isPaused && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isActive, isPaused]);

  // Re-focus if the user accidentally clicks away.
  const handleBlur = useCallback(() => {
    const state = useTypingStore.getState();
    if (state.isActive && !state.isPaused) {
      requestAnimationFrame(() => {
        const s = useTypingStore.getState();
        if (s.isActive && !s.isPaused && inputRef.current) {
          inputRef.current.focus();
        }
      });
    }
  }, []);

  // ── Text input processing ─────────────────────────────────────────────

  /**
   * Process committed characters from the hidden textarea.
   * This is the single code path for both English keystrokes and IME input.
   */
  const handleInput = useCallback(() => {
    const textarea = inputRef.current;
    if (!textarea) return;

    // Don't process while IME composition is still in progress
    if (isComposingRef.current) return;

    const value = textarea.value;
    if (!value) return;

    // Process each committed character against the target text.
    // Newlines (\n from Enter key) trigger a whitespace-skip only.
    for (const char of value) {
      let state = useTypingStore.getState();
      if (!state.isActive || state.isPaused) break;

      let expected = state.targetText[state.cursorIndex];
      if (expected === undefined) break; // reached end of text

      // Auto-skip all consecutive whitespace before processing input
      while (expected === " " || expected === "\n" || expected === "\t" || expected === "\r") {
        state.skipWhitespace();
        state = useTypingStore.getState();
        expected = state.targetText[state.cursorIndex];
        if (expected === undefined) break;
      }

      // Enter / newline / space: whitespace triggers are only for skipping,
      // not for comparing against the next visible character
      if (char === "\n" || char === " ") continue;

      if (expected === undefined) break;

      // Compare the input character to the expected character
      if (char.length === 1) {
        state.advanceCursor(char === expected);
      }
    }

    // Clear the textarea so the next input is fresh
    textarea.value = "";
  }, []);

  // ── IME composition tracking ──────────────────────────────────────────

  const handleCompositionStart = useCallback(() => {
    isComposingRef.current = true;
  }, []);

  const handleCompositionEnd = useCallback(() => {
    isComposingRef.current = false;
    // After composition ends, the browser fires an `input` event next.
    // We process in a microtask to ensure the textarea value is updated first.
    queueMicrotask(() => handleInput());
  }, [handleInput]);

  // ── Special key handling ──────────────────────────────────────────────

  /**
   * Handle special keys directly on the textarea (reliable capture).
   * - Escape: end the session
   * - Backspace: move cursor back one position
   * - Space: auto-input the current character as correct (skip)
   * - Enter: auto-skip whitespace to jump to next paragraph
   */
  const handleKeydown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Backspace") {
        e.preventDefault();
        const state = useTypingStore.getState();
        if (state.isActive && !state.isPaused && state.cursorIndex > 0) {
          state.backspace();
        }
        return;
      }

      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        // Don't interfere with IME composition (space confirms candidate)
        if (isComposingRef.current) return;

        let state = useTypingStore.getState();
        if (!state.isActive || state.isPaused) return;

        // Skip current character as correct (auto-input)
        state.advanceCursor(true);

        // Auto-skip any following whitespace until we hit visible text
        state = useTypingStore.getState();
        let expected = state.targetText[state.cursorIndex];
        while (
          expected !== undefined &&
          (expected === " " || expected === "\n" || expected === "\t" || expected === "\r")
        ) {
          state.skipWhitespace();
          state = useTypingStore.getState();
          expected = state.targetText[state.cursorIndex];
        }
        return;
      }

      if (e.key === "Enter") {
        e.preventDefault();
        // Don't interfere with IME composition (Enter confirms candidate)
        if (isComposingRef.current) return;

        const state = useTypingStore.getState();
        if (!state.isActive || state.isPaused) return;

        // Auto-skip ALL consecutive whitespace until we hit visible text
        let expected = state.targetText[state.cursorIndex];
        while (
          expected !== undefined &&
          (expected === " " || expected === "\n" || expected === "\t" || expected === "\r")
        ) {
          state.skipWhitespace();
          const next = useTypingStore.getState();
          expected = next.targetText[next.cursorIndex];
        }
        return;
      }
    },
    [],
  );

  // Window-level keydown — safety net for Escape and focus recovery.
  // If the hidden textarea loses focus, the next keypress refocuses it.
  useEffect(() => {
    const onWindowKeydown = (e: KeyboardEvent) => {
      const state = useTypingStore.getState();
      if (!state.isActive || state.isPaused) return;

      // Escape always ends the session, unless an overlay is open
      if (e.key === "Escape") {
        if (blockEscapeRef?.current) return; // let the overlay handle it
        e.preventDefault();
        state.endSession();
        return;
      }

      // If the textarea lost focus, refocus it so it can capture input
      if (inputRef.current && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current.focus();
        // Re-dispatch the key to the now-focused textarea
        // (the textarea will receive it as a new keypress → input event)
      }
    };
    window.addEventListener("keydown", onWindowKeydown);
    return () => window.removeEventListener("keydown", onWindowKeydown);
  }, []);

  // ── Session completion ────────────────────────────────────────────────
  // Completion is now detected in advanceCursor (typingSlice) → sets isComplete: true.
  // The ReaderPage shows a completion summary; session stays active until the
  // user presses Escape or manually exits.

  // Derived from store for convenience
  const isComplete = cursorIndex >= targetText.length && targetText.length > 0;

  return { inputRef: setInputRef, handleInput, handleCompositionStart, handleCompositionEnd, handleBlur, handleKeydown, isComplete };
}
