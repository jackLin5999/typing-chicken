import { useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useBookStore, useTypingStore } from "@/store";

interface SessionRecorderOptions {
  /** 这次练习是错字重练，而不是正常过一遍章节。 */
  isDrill?: boolean;
  /** 章节标题的覆盖值（重练时用它标明来源）。 */
  chapterTitleOverride?: string;
}

/**
 * 练完一章时往 sessions 表写一行，供统计页画进步曲线。
 *
 * 只在**真正练完**（`isComplete` 由 false 翻成 true）时记录，中途按 ESC
 * 跑掉的半截练习不记 —— 否则「练了三秒就退出」会把曲线拖成一团噪声。
 *
 * `endSession()` 会把 stats 清空，所以必须在它之前读；这里直接读 store 里
 * 当时的快照，不依赖任何卸载顺序。
 */
export function useSessionRecorder(options: SessionRecorderOptions = {}) {
  const { isDrill = false, chapterTitleOverride } = options;

  const isComplete = useTypingStore((s) => s.isComplete);
  const currentBook = useBookStore((s) => s.currentBook);
  const currentChapter = useBookStore((s) => s.currentChapter);

  // 一次完成只记一行：isComplete 变 true 之后会一直保持 true，
  // 而这个 effect 会因为 stats 每 250ms 更新而反复触发。
  const recordedRef = useRef(false);

  useEffect(() => {
    if (!isComplete) {
      recordedRef.current = false;
      return;
    }
    if (recordedRef.current) return;

    const { stats, incorrectIndices, hasStarted } = useTypingStore.getState();

    // 一个字没打就「完成」的情况（空章节）不记
    if (!hasStarted || stats.totalKeystrokes === 0) return;
    if (!currentBook || !currentChapter) return;

    recordedRef.current = true;

    invoke("record_session", {
      session: {
        bookId: currentBook.id,
        bookTitle: currentBook.title,
        chapterIndex: currentChapter.indexOrder,
        chapterTitle: chapterTitleOverride ?? currentChapter.title,
        wpm: stats.wpm,
        accuracy: stats.accuracy,
        durationSeconds: stats.elapsedSeconds,
        correctKeystrokes: stats.correctKeystrokes,
        totalKeystrokes: stats.totalKeystrokes,
        // 打错的**不同**字符数，比 incorrectKeystrokes 更能说明这一遍的质量
        incorrectChars: new Set(incorrectIndices).size,
        wordsCompleted: stats.wordsCompleted,
        isDrill,
      },
    }).catch((err) => console.error("记录练习失败:", err));
  }, [isComplete, currentBook, currentChapter, isDrill, chapterTitleOverride]);
}
