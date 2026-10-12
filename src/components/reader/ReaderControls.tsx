import { ArrowLeft, ChevronLeft, ChevronRight, List, Type, Sun, Moon, BookOpen, Minus, Plus, Pause, Play, Languages } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useSettingsStore, useTypingStore } from "@/store";
import type { Theme, FontFamily, FontSize } from "@/types/settings";

const themes: { key: Theme; label: string; icon: typeof Sun }[] = [
  { key: "light", label: "Light", icon: Sun },
  { key: "sepia", label: "Sepia", icon: BookOpen },
  { key: "dark", label: "Dark", icon: Moon },
];

const fonts: { key: FontFamily; label: string }[] = [
  { key: "serif", label: "Serif" },
  { key: "sans", label: "Sans" },
  { key: "mono", label: "Mono" },
];

const sizes: { key: FontSize; label: string }[] = [
  { key: "sm", label: "S" },
  { key: "base", label: "M" },
  { key: "lg", label: "L" },
  { key: "xl", label: "XL" },
];

interface ReaderControlsProps {
  hasPrevChapter: boolean;
  hasNextChapter: boolean;
  onPrevChapter: () => void;
  onNextChapter: () => void;
  onToggleChapterPanel: () => void;
}

/**
 * Floating control bar for the reader/typing view:
 * - Back to library, chapter navigation
 * - Theme toggle (Light / Sepia / Dark)
 * - Font family & size
 */
export function ReaderControls({
  hasPrevChapter,
  hasNextChapter,
  onPrevChapter,
  onNextChapter,
  onToggleChapterPanel,
}: ReaderControlsProps) {
  const navigate = useNavigate();
  const theme = useSettingsStore((s) => s.theme);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const setFontFamily = useSettingsStore((s) => s.setFontFamily);
  const setFontSize = useSettingsStore((s) => s.setFontSize);
  const isActive = useTypingStore((s) => s.isActive);
  const isPaused = useTypingStore((s) => s.isPaused);
  const pauseSession = useTypingStore((s) => s.pauseSession);
  const resumeSession = useTypingStore((s) => s.resumeSession);
  const showPinyin = useSettingsStore((s) => s.showPinyin);
  const setShowPinyin = useSettingsStore((s) => s.setShowPinyin);

  return (
    <div
      className="
        fixed bottom-6 left-1/2 -translate-x-1/2
        flex items-center gap-0.5
        px-2 py-1.5 rounded-xl
        bg-surface/80
        backdrop-blur-xl
        border border-gray-200/40 dark:border-gray-700/30
        shadow-lg shadow-black/5
        z-40
      "
    >
      {/* Back */}
      <button
        onClick={() => navigate("/")}
        className="p-2 rounded-lg hover:bg-surface-hover transition-colors"
        aria-label="Back to Library"
      >
        <ArrowLeft size={16} className="text-muted" />
      </button>

      <div className="w-px h-5 bg-surface-hover mx-1" />

      {/* Chapter navigation */}
      <button
        onClick={onPrevChapter}
        disabled={!hasPrevChapter}
        className="p-2 rounded-lg hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-default"
        aria-label="Previous Chapter"
      >
        <ChevronLeft size={16} className="text-muted" />
      </button>

      <button
        onClick={onToggleChapterPanel}
        className="p-2 rounded-lg hover:bg-surface-hover transition-colors"
        aria-label="Chapter List"
      >
        <List size={15} className="text-muted" />
      </button>

      <button
        onClick={onNextChapter}
        disabled={!hasNextChapter}
        className="p-2 rounded-lg hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-default"
        aria-label="Next Chapter"
      >
        <ChevronRight size={16} className="text-muted" />
      </button>

      <div className="w-px h-5 bg-surface-hover mx-1" />

      {/* Pause / Resume */}
      {isActive && (
        <button
          onClick={() => (isPaused ? resumeSession() : pauseSession())}
          className="p-2 rounded-lg hover:bg-surface-hover transition-colors"
          aria-label={isPaused ? "Resume" : "Pause"}
        >
          {isPaused ? <Play size={15} className="text-accent" /> : <Pause size={15} className="text-muted" />}
        </button>
      )}

      {/* Pinyin toggle */}
      <button
        onClick={() => setShowPinyin(!showPinyin)}
        className={`p-2 rounded-lg transition-colors ${
          showPinyin
            ? "bg-accent/10 text-accent"
            : "text-muted hover:bg-surface-hover"
        }`}
        aria-label="Toggle Pinyin"
        title="Toggle Pinyin"
      >
        <Languages size={15} />
      </button>

      <div className="w-px h-5 bg-surface-hover mx-1" />

      {/* Theme */}
      {themes.map((t) => (
        <button
          key={t.key}
          onClick={() => setTheme(t.key)}
          className={`
            p-2 rounded-lg transition-colors
            ${theme === t.key
              ? "bg-accent/10 text-accent"
              : "text-muted hover:bg-surface-hover"
            }
          `}
          aria-label={t.label}
        >
          <t.icon size={15} />
        </button>
      ))}

      <div className="w-px h-5 bg-surface-hover mx-1" />

      {/* Font family */}
      <div className="flex items-center gap-0.5">
        <Type size={14} className="text-muted ml-1 mr-1" />
        {fonts.map((f) => (
          <button
            key={f.key}
            onClick={() => setFontFamily(f.key)}
            className={`
              px-2 py-1 rounded-md text-xs font-medium transition-colors
              ${fontFamily === f.key
                ? "bg-accent/10 text-accent"
                : "text-muted hover:bg-surface-hover"
              }
            `}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="w-px h-5 bg-surface-hover mx-1" />

      {/* Font size */}
      <div className="flex items-center gap-0.5">
        <button
          onClick={() => {
            const idx = sizes.findIndex((s) => s.key === fontSize);
            if (idx > 0) setFontSize(sizes[idx - 1].key);
          }}
          className="p-1.5 rounded-md text-muted hover:bg-surface-hover transition-colors"
          aria-label="Decrease font size"
        >
          <Minus size={13} />
        </button>
        <span className="text-xs font-medium text-ink w-5 text-center tabular-nums">
          {sizes.find((s) => s.key === fontSize)?.label ?? "M"}
        </span>
        <button
          onClick={() => {
            const idx = sizes.findIndex((s) => s.key === fontSize);
            if (idx < sizes.length - 1) setFontSize(sizes[idx + 1].key);
          }}
          className="p-1.5 rounded-md text-muted hover:bg-surface-hover transition-colors"
          aria-label="Increase font size"
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}
