import { useTypingStore } from "@/store";
import { formatTime } from "@/lib/utils";

/**
 * A subtle, non-distracting live metrics bar displayed at the top
 * of the reader while a typing session is active.
 */
export function LiveStats() {
  const stats = useTypingStore((s) => s.stats);
  const cursorIndex = useTypingStore((s) => s.cursorIndex);
  const targetText = useTypingStore((s) => s.targetText);

  const progressPct =
    targetText.length > 0 ? Math.round((cursorIndex / targetText.length) * 100) : 0;

  return (
    <div
      className="
        sticky top-12 z-30
        flex items-center justify-center gap-6
        mx-auto px-6 py-2
        w-fit max-w-[90%]
        rounded-2xl
        glass-stats
        animate-fade-in
      "
    >
      {/* 速度 */}
      <StatItem label="速度" value={stats.wpm.toString()} />

      <Divider />

      {/* 准确率 */}
      <StatItem label="准确" value={`${stats.accuracy}%`} />

      <Divider />

      {/* 用时 */}
      <StatItem label="用时" value={formatTime(stats.elapsedSeconds)} />

      <Divider />

      {/* 进度 */}
      <StatItem label="进度" value={`${progressPct}%`} />
    </div>
  );
}

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5 font-sans">
      <span className="text-[10px] tracking-[0.08em] text-ink/50 dark:text-white/40 font-medium">
        {label}
      </span>
      <span className="text-sm font-semibold text-ink/90 tabular-nums">
        {value}
      </span>
    </div>
  );
}

function Divider() {
  return (
    <div className="w-px h-3 bg-black/10 dark:bg-white/10" />
  );
}
