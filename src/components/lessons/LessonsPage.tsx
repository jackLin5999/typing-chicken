import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Check, ChevronRight, Keyboard, Loader2 } from "lucide-react";
import { LESSONS, UNITS } from "@/lib/lessons";
import { useLessonProgress } from "@/hooks/useLessonProgress";
import type { Lesson } from "@/lib/lessons";

/**
 * 指法入门 —— 课程总览。
 *
 * 所有课都可以直接点进去（**不卡关**）：达标只是「通关标记」，
 * 卡在第 5 课是打字软件最常见的劝退方式。
 */
export function LessonsPage() {
  const navigate = useNavigate();
  const { progress, isLoading } = useLessonProgress();

  const { passed, nextLesson } = useMemo(() => {
    const passedIds = new Set(
      [...progress.values()].filter((p) => p.completedAt).map((p) => p.id),
    );
    return {
      passed: passedIds.size,
      nextLesson: LESSONS.find((l) => !passedIds.has(l.id)) ?? null,
    };
  }, [progress]);

  // 课程按单元分组，但 LESSONS 是平铺的 —— 按 unitTitle 归拢一下
  const grouped = useMemo(
    () =>
      UNITS.map((unit) => ({
        unit,
        lessons: LESSONS.filter((l) => l.unitTitle === unit.title),
      })),
    [],
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-8 py-10">
        <header className="mb-6">
          <div className="flex items-center gap-3">
            <Keyboard size={22} className="text-accent" />
            <h1 className="text-2xl font-bold text-ink font-serif">指法入门</h1>
          </div>
          <p className="mt-1 text-sm text-muted">
            从零开始学盲打。每节课只教几个键，练完再往下走
          </p>
        </header>

        {/* 总进度 + 继续入口 */}
        <div className="mb-6 p-4 rounded-xl bg-surface border border-gray-200/60 dark:border-gray-700/40">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm text-ink">
              已通过 <span className="font-semibold text-accent">{passed}</span> / {LESSONS.length} 课
            </span>
            {nextLesson && (
              <button
                onClick={() => navigate(`/lessons/${nextLesson.id}`)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-blue-600 transition-colors cursor-pointer"
              >
                {passed === 0 ? "开始第一课" : "继续下一课"}
              </button>
            )}
          </div>
          <div className="h-1.5 rounded-full bg-surface-hover overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-[width] duration-300"
              style={{ width: `${(passed / LESSONS.length) * 100}%` }}
            />
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={20} className="animate-spin text-accent" />
          </div>
        ) : (
          grouped.map(({ unit, lessons }) => (
            <section key={unit.title} className="mb-6">
              <h2 className="text-sm font-semibold text-ink">{unit.title}</h2>
              <p className="text-xs text-muted mt-0.5 mb-2">{unit.subtitle}</p>

              <div className="rounded-xl bg-surface border border-gray-200/60 dark:border-gray-700/40 overflow-hidden">
                {lessons.map((lesson) => (
                  <LessonRow
                    key={lesson.id}
                    lesson={lesson}
                    done={!!progress.get(lesson.id)?.completedAt}
                    bestAccuracy={progress.get(lesson.id)?.bestAccuracy}
                    onClick={() => navigate(`/lessons/${lesson.id}`)}
                  />
                ))}
              </div>
            </section>
          ))
        )}

        <p className="mt-8 text-xs text-muted leading-relaxed">
          课程只练英文字母 —— 盲打练的是手指对物理键盘的记忆，拼音打字完全复用它。
          练完之后再去书架挑一本书，就是真实的中文练习了。
        </p>
      </div>
    </div>
  );
}

interface LessonRowProps {
  lesson: Lesson;
  done: boolean;
  bestAccuracy: number | undefined;
  onClick: () => void;
}

function LessonRow({ lesson, done, bestAccuracy, onClick }: LessonRowProps) {
  const keys = lesson.newKeys
    .filter((k) => k.length === 1)
    .map((k) => (k === " " ? "空格" : k.toUpperCase()))
    .join(" ");

  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-4 py-2.5 text-left border-b last:border-b-0 border-gray-200/50 dark:border-gray-700/30 hover:bg-surface-hover transition-colors cursor-pointer"
    >
      <span
        className={`shrink-0 w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-semibold tabular-nums ${
          done ? "bg-accent-correct/15 text-accent-correct" : "bg-surface-alt text-muted"
        }`}
      >
        {done ? <Check size={14} /> : lesson.index}
      </span>

      <span className="flex-1 min-w-0">
        <span className="block text-sm text-ink truncate">{lesson.title}</span>
        <span className="block text-[11px] text-muted mt-0.5">
          {keys ? `新键：${keys}` : "复习"}
        </span>
      </span>

      {bestAccuracy !== undefined && bestAccuracy > 0 && (
        <span className="shrink-0 text-[11px] text-muted tabular-nums">
          {Math.round(bestAccuracy)}%
        </span>
      )}
      <ChevronRight size={14} className="shrink-0 text-muted/40" />
    </button>
  );
}
