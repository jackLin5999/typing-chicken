import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTypingStore, useBookStore } from "@/store";

interface AutoSaveOptions {
  /**
   * 关掉存盘。错字重练时必须关 —— 那时 targetText 是临时生成的练习文本，
   * 写到 books.current_position 会把这一章的阅读进度覆盖掉。
   */
  enabled?: boolean;
}

/**
 * Periodic auto-save — persists cursor position to SQLite every 2 seconds
 * while a typing session is active, plus a final save on unmount so no
 * progress is lost when navigating away or closing the app.
 */
export function useAutoSave({ enabled = true }: AutoSaveOptions = {}) {
  const isActive = useTypingStore((s) => s.isActive);
  const currentBook = useBookStore((s) => s.currentBook);
  const currentChapter = useBookStore((s) => s.currentChapter);

  // Refs so the interval callback always reads the latest values without
  // needing to re-create the interval on every keystroke.
  const lastSavedRef = useRef(-1);
  // The unmount handler runs with the mount-time closure, so it must read
  // `enabled` through a ref or it would keep saving after a drill starts.
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  // ── Periodic save (every 2 s) ────────────────────────────────────────────
  useEffect(() => {
    if (!enabled || !isActive || !currentBook || !currentChapter) return;

    const interval = setInterval(async () => {
      const cursor = useTypingStore.getState().cursorIndex;
      if (cursor === lastSavedRef.current) return; // nothing new to save
      const chapterIdx = useBookStore.getState().currentChapter?.indexOrder;
      const book = useBookStore.getState().currentBook;
      if (chapterIdx == null || !book) return;

      try {
        const incorrect = useTypingStore.getState().incorrectIndices;
        await invoke("update_progress", {
          bookId: book.id,
          chapterIndex: chapterIdx,
          cursorPosition: cursor,
          incorrectPositions: JSON.stringify(incorrect),
        });
        lastSavedRef.current = cursor;
      } catch (err) {
        console.error("Auto-save failed:", err);
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [enabled, isActive, currentBook, currentChapter]);

  // ── Save on unmount (navigate away / close app) ──────────────────────────
  useEffect(() => {
    return () => {
      const state = useTypingStore.getState();
      if (!enabledRef.current || !state.isActive) return;
      const book = useBookStore.getState().currentBook;
      const chapter = useBookStore.getState().currentChapter;
      if (!book || !chapter) return;
      const cursor = state.cursorIndex;
      if (cursor === lastSavedRef.current) return;

      // Fire-and-forget — the app may close before the IPC completes,
      // but the backend will still process it.
      const incorrect = state.incorrectIndices;
      invoke("update_progress", {
        bookId: book.id,
        chapterIndex: chapter.indexOrder,
        cursorPosition: cursor,
        incorrectPositions: JSON.stringify(incorrect),
      }).catch((err) => console.error("Final auto-save failed:", err));
    };
  }, []);
}
