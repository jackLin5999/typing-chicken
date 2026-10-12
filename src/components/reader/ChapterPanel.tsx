import { useEffect, useRef } from "react";
import { X, FileText } from "lucide-react";
import type { Chapter } from "@/types/book";

interface ChapterPanelProps {
  chapters: Chapter[];
  currentChapterId: string | null;
  onSelect: (chapter: Chapter) => void;
  onClose: () => void;
}

const levelLabels = ["", "  ∟", "    ·"];
const levelStyles = [
  "font-semibold text-[13px]",        // level 0: 一级标题
  "font-medium text-xs",               // level 1: 二级标题
  "font-normal text-[11px] text-muted", // level 2: 三级标题
];

/**
 * Slide-in panel listing all chapters with TOC hierarchy indentation.
 */
export function ChapterPanel({
  chapters,
  currentChapterId,
  onSelect,
  onClose,
}: ChapterPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  // Close on click outside
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-sm transition-opacity" />

      {/* Panel */}
      <div
        ref={panelRef}
        className="
          fixed top-10 bottom-0 left-0 z-50
          w-80 max-w-[85vw]
          bg-surface
          border-r border-gray-200 dark:border-gray-700/50
          shadow-2xl shadow-black/20
          flex flex-col
          animate-slide-in-left
        "
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100 dark:border-gray-800">
          <h2 className="text-sm font-semibold text-ink">
            Table of Contents
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded-md hover:bg-surface-hover transition-colors"
          >
            <X size={16} className="text-muted" />
          </button>
        </div>

        {/* Chapter list */}
        <div className="flex-1 overflow-y-auto py-2">
          {chapters.length === 0 && (
            <p className="text-xs text-muted text-center py-8">
              No chapters found
            </p>
          )}
          {chapters.map((ch) => {
            const isActive = ch.id === currentChapterId;
            const wordCount = ch.content?.split(/\s+/).filter(Boolean).length ?? 0;
            const readTime = Math.max(1, Math.ceil(wordCount / 200));
            const level = Math.min(ch.level ?? 0, 2);
            const indent = level * 16; // px indentation per level
            const levelLabel = levelLabels[level] ?? "";
            const levelStyle = levelStyles[level] ?? levelStyles[0];

            return (
              <button
                key={ch.id}
                onClick={() => {
                  onSelect(ch);
                  onClose();
                }}
                className={`
                  w-full text-left transition-colors
                  flex items-start gap-2
                  ${
                    isActive
                      ? "bg-accent/10 border-r-2 border-accent"
                      : "hover:bg-surface-hover border-r-2 border-transparent"
                  }
                `}
                style={{ paddingLeft: `${12 + indent}px`, paddingRight: "12px", paddingTop: "8px", paddingBottom: "8px" }}
              >
                <FileText
                  size={level === 0 ? 15 : 13}
                  className={`mt-0.5 shrink-0 ${
                    isActive
                      ? "text-accent"
                      : level === 2
                        ? "text-gray-300 dark:text-gray-600"
                        : "text-muted"
                  }`}
                />
                <div className="min-w-0">
                  <p
                    className={`leading-snug truncate ${levelStyle} ${
                      isActive ? "text-accent" : "text-ink"
                    }`}
                  >
                    {levelLabel && (
                      <span className="mr-1 opacity-40">{levelLabel}</span>
                    )}
                    {ch.title || `Chapter ${ch.indexOrder + 1}`}
                  </p>
                  <p className="text-[10px] text-muted mt-0.5" style={{ marginLeft: level > 0 ? "0px" : "0px" }}>
                    {wordCount.toLocaleString()} words · ~{readTime} min
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </>
  );
}
