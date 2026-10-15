/** 一节指法课在数据库里的成绩。课程表本身在 `src/lib/lessons.ts`。 */
export interface LessonProgress {
  id: string;
  attempts: number;
  bestAccuracy: number;
  bestWpm: number;
  /** 通过达标线的时间；null = 还没通过。 */
  completedAt: string | null;
}
