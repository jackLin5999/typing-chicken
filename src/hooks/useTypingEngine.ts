import { useEffect, useRef, useCallback } from "react";
import type { MutableRefObject } from "react";
import { useTypingStore } from "@/store";
import { isWhitespace } from "@/lib/utils";

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
    hasStarted,
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
    // The clock only runs once the user has actually typed something.
    // Opening a book no longer starts the timer — see `hasStarted`.
    if (isActive && !isPaused && hasStarted) {
      if (startTimeRef.current === 0) {
        // First keystroke: start the clock. Any pause taken before the first
        // keystroke must not be compensated for, so drop it here.
        startTimeRef.current = Date.now();
        pauseStartRef.current = 0;
      } else if (pauseStartRef.current > 0) {
        // Coming back from a pause — shift startTime forward by the
        // paused duration so elapsed time doesn't include the pause.
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
  }, [isActive, isPaused, hasStarted, updateStats]);

  // Reset the clock whenever the session ends or is restarted.
  // Keyed on `hasStarted` rather than `isActive` so that restarting an
  // already-active session ("重来") also resets it — startSession clears
  // hasStarted but leaves isActive true, so an isActive-keyed effect would
  // silently keep the old start time.
  useEffect(() => {
    if (!hasStarted) {
      startTimeRef.current = 0;
      pauseStartRef.current = 0;
    }
  }, [hasStarted]);

  // ── Focus management ──────────────────────────────────────────────────

  // Auto-focus the hidden textarea when the session becomes active.
  useEffect(() => {
    if (isActive && !isPaused && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isActive, isPaused]);

  // Re-focus if the user accidentally clicks away.
  //
  // Guarded on IME composition: restoring focus while a composition is in
  // flight desyncs WebView2's text-input state and kills the renderer
  // (msedge.dll, STATUS_BREAKPOINT 0x80000003 — the crash documented in
  // MicrosoftEdge/WebView2Feedback#5475). Better to lose a focus restoration
  // than the whole page.
  const handleBlur = useCallback(() => {
    if (isComposingRef.current) return;
    const state = useTypingStore.getState();
    if (state.isActive && !state.isPaused) {
      requestAnimationFrame(() => {
        if (isComposingRef.current) return;
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
      while (isWhitespace(expected)) {
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

    // Clear the textarea so the next input is fresh. Never do this while a
    // composition is still being processed — mutating the value underneath
    // the IME is what desyncs WebView2's text-input state.
    if (!isComposingRef.current) textarea.value = "";
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
        while (isWhitespace(expected)) {
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
        while (isWhitespace(expected)) {
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

      // If the textarea lost focus, refocus it so it can capture input.
      // Never do this mid-composition — it races the IME and crashes the
      // WebView2 renderer (see the note on handleBlur).
      if (isComposingRef.current) return;
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

  // While an IME composition is in flight, stop mouse presses from moving
  // focus off the hidden textarea. This is the only workaround that reliably
  // prevents the WebView2 renderer crash documented in
  // MicrosoftEdge/WebView2Feedback#5475 — `preventDefault()` on mousedown
  // suppresses the focus change but the subsequent `click` still fires, so
  // every control keeps working.
  useEffect(() => {
    const suppressFocusSteal = (e: MouseEvent) => {
      if (isComposingRef.current) e.preventDefault();
    };
    document.addEventListener("mousedown", suppressFocusSteal, true);
    return () =>
      document.removeEventListener("mousedown", suppressFocusSteal, true);
  }, []);

  // ── Session completion ────────────────────────────────────────────────
  // Completion is now detected in advanceCursor (typingSlice) → sets isComplete: true.
  // The ReaderPage shows a completion summary; session stays active until the
  // user presses Escape or manually exits.

  // Derived from store for convenience
  const isComplete = cursorIndex >= targetText.length && targetText.length > 0;

  return { inputRef: setInputRef, handleInput, handleCompositionStart, handleCompositionEnd, handleBlur, handleKeydown, isComplete };
}
