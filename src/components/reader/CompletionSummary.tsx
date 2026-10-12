import { Trophy, ArrowRight, Home, RotateCcw } from "lucide-react";
import { useTypingStore } from "@/store";
import { formatTime } from "@/lib/utils";

interface CompletionSummaryProps {
  hasNextChapter: boolean;
  onNextChapter: () => void;
  onBackToLibrary: () => void;
  onRestart: () => void;
}

/**
 * Full-screen overlay shown when the user completes typing a chapter.
 * Displays session stats — WPM, accuracy, time, keystrokes.
 */
export function CompletionSummary({
  hasNextChapter,
  onNextChapter,
  onBackToLibrary,
  onRestart,
}: CompletionSummaryProps) {
  const stats = useTypingStore((s) => s.stats);

  const rows: { label: string; value: string }[] = [
    { label: "WPM", value: stats.wpm.toString() },
    { label: "Accuracy", value: `${stats.accuracy}%` },
    { label: "Time", value: formatTime(stats.elapsedSeconds) },
    { label: "Keystrokes", value: `${stats.correctKeystrokes} / ${stats.totalKeystrokes}` },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm animate-fade-in">
      <div className="w-full max-w-sm mx-4 bg-surface rounded-2xl shadow-2xl animate-slide-up overflow-hidden">
        {/* Header */}
        <div className="flex flex-col items-center gap-2 pt-8 pb-4 bg-gradient-to-b from-accent/10 to-transparent">
          <div className="w-14 h-14 rounded-full bg-accent/20 flex items-center justify-center">
            <Trophy size={28} className="text-accent" />
          </div>
          <h2 className="text-lg font-bold text-ink font-serif">
            Chapter Complete!
          </h2>
          <p className="text-xs text-muted">
            Great work — here are your results
          </p>
        </div>

        {/* Stats */}
        <div className="px-6 py-4 grid grid-cols-2 gap-3">
          {rows.map((row) => (
            <div
              key={row.label}
              className="flex flex-col items-center gap-0.5 p-3 rounded-xl bg-surface-alt"
            >
              <span className="text-[10px] tracking-[0.15em] uppercase text-muted font-medium">
                {row.label}
              </span>
              <span className="text-xl font-bold text-ink tabular-nums">
                {row.value}
              </span>
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="px-6 pb-6 pt-2 flex flex-col gap-2">
          {hasNextChapter && (
            <button
              onClick={onNextChapter}
              className="flex items-center justify-center gap-2 w-full py-2.5 rounded-xl
                bg-accent text-white text-sm font-semibold
                hover:bg-blue-600 active:bg-blue-700 transition-colors shadow-sm"
            >
              <ArrowRight size={16} />
              Next Chapter
            </button>
          )}
          <div className="flex gap-2">
            <button
              onClick={onRestart}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl
                bg-surface-alt text-ink text-sm font-medium
                hover:bg-surface-hover transition-colors"
            >
              <RotateCcw size={14} />
              Restart
            </button>
            <button
              onClick={onBackToLibrary}
              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl
                bg-surface-alt text-ink text-sm font-medium
                hover:bg-surface-hover transition-colors"
            >
              <Home size={14} />
              Library
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
