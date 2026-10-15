import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LessonProgress } from "@/types/lessons";

/**
 * 指法课进度。课程表在前端（`src/lib/lessons.ts`），这里只负责从数据库
 * 读回「哪几课过了、最好成绩是多少」。
 */
export function useLessonProgress() {
  const [progress, setProgress] = useState<Map<string, LessonProgress>>(new Map());
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const rows = await invoke<LessonProgress[]>("get_lesson_progress");
      setProgress(new Map(rows.map((r) => [r.id, r])));
    } catch (err) {
      console.error("读取课程进度失败:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { progress, isLoading, reload };
}
