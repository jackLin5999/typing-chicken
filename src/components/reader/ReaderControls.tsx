import { ArrowLeft, ChevronLeft, ChevronRight, List, Type, Sun, Moon, BookOpen, Minus, Plus, Pause, Play, RotateCcw, Languages, PilcrowSquare, Target, Keyboard } from "lucide-react";
import { useSettingsStore, useTypingStore } from "@/store";
import type { Theme, FontFamily, FontSize } from "@/types/settings";

const themes: { key: Theme; label: string; icon: typeof Sun }[] = [
  { key: "light", label: "白天", icon: Sun },
  { key: "sepia", label: "书本", icon: BookOpen },
  { key: "dark", label: "夜间", icon: Moon },
];

const fonts: { key: FontFamily; label: string }[] = [
  { key: "serif", label: "衬线" },
  { key: "sans", label: "黑体" },
  { key: "mono", label: "等宽" },
];

const sizes: { key: FontSize; label: string }[] = [
  { key: "sm", label: "S" },
  { key: "base", label: "M" },
  { key: "lg", label: "L" },
  { key: "xl", label: "XL" },
];

interface ReaderControlsProps {
  /** 返回按钮的去向。不传就不渲染返回键。 */
  onBack?: () => void;
  /** Restart the current chapter from the top — progress and stats reset. */
  onRestart: () => void;
  /**
   * 章节导航（阅读模式专有）。
   * 课程没有章节，不传这一组，那一排按钮就不渲染。
   */
  chapters?: {
    hasPrev: boolean;
    hasNext: boolean;
    onPrev: () => void;
    onNext: () => void;
    onTogglePanel: () => void;
  };
  /** 错字重练。count 为 0 或不传时，按钮不出现。 */
  mistakes?: {
    count: number;
    onRetry: () => void;
  };
  /** 拼音开关（阅读模式专有）—— 英文课程里它是空操作，不传即可。 */
  pinyin?: {
    value: boolean;
    onChange: (value: boolean) => void;
  };
  /**
   * 「跳过标点」开关。不传就不渲染 ——
   * 课程会把它强制关掉（标点课不能被全局设置跳过），
   * 这时显示一个点了没反应的按钮比不显示更糟。
   */
  punctuation?: {
    value: boolean;
    onChange: (value: boolean) => void;
  };
}

/**
 * 浮动工具栏从窗口底部往上吃掉的高度。
 *
 * bottom-6（24px）+ 工具栏本体（p-2 的按钮 + py-1.5 的容器 ≈ 46px）+ 一点余量。
 * 凡是可能被它盖住的东西 —— 打字区最后一行、下方的键盘指法提示 ——
 * 都要按这个值让位。改工具栏的尺寸时记得同步这里。
 */
export const CONTROLS_CLEARANCE = "pb-20";

/**
 * Floating control bar for the reader/typing view.
 *
 * 阅读和课程共用同一条工具栏，靠**传不传某一组**来决定渲染哪些按钮 ——
 * 而不是复制一份。少一套 UI 就少一处会走样的地方。
 */
export function ReaderControls({
  onBack,
  onRestart,
  chapters,
  mistakes,
  pinyin,
  punctuation,
}: ReaderControlsProps) {
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
  const showKeyboardHint = useSettingsStore((s) => s.showKeyboardHint);
  const setShowKeyboardHint = useSettingsStore((s) => s.setShowKeyboardHint);

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
      {onBack && (
        <>
          <button
            onClick={onBack}
            className="p-2 rounded-lg hover:bg-surface-hover transition-colors cursor-pointer"
            aria-label="返回"
            title="返回"
          >
            <ArrowLeft size={16} className="text-muted" />
          </button>
          <div className="w-px h-5 bg-surface-hover mx-1" />
        </>
      )}

      {/* Chapter navigation —— 只有阅读模式才有 */}
      {chapters && (
        <>
          <button
            onClick={chapters.onPrev}
            disabled={!chapters.hasPrev}
            className="p-2 rounded-lg hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-default cursor-pointer"
            aria-label="上一章"
            title="上一章（Alt + ←）"
          >
            <ChevronLeft size={16} className="text-muted" />
          </button>

          <button
            onClick={chapters.onTogglePanel}
            className="p-2 rounded-lg hover:bg-surface-hover transition-colors cursor-pointer"
            aria-label="章节目录"
            title="章节目录（Alt + T）"
          >
            <List size={15} className="text-muted" />
          </button>

          <button
            onClick={chapters.onNext}
            disabled={!chapters.hasNext}
            className="p-2 rounded-lg hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-default cursor-pointer"
            aria-label="下一章"
            title="下一章（Alt + →）"
          >
            <ChevronRight size={16} className="text-muted" />
          </button>

          <div className="w-px h-5 bg-surface-hover mx-1" />
        </>
      )}

      {/* Play / Pause toggle — one button, both states.
          The clock starts itself on the first keystroke, so before that the
          button simply reads as "running" and clicking it pauses. */}
      {isActive && (
        <button
          onClick={() => (isPaused ? resumeSession() : pauseSession())}
          className="p-2 rounded-lg hover:bg-surface-hover transition-colors cursor-pointer"
          aria-label={isPaused ? "继续" : "暂停"}
          title={isPaused ? "继续（从当前进度接着打）" : "暂停"}
        >
          {isPaused
            ? <Play size={15} className="text-accent" />
            : <Pause size={15} className="text-muted" />}
        </button>
      )}

      {/* Restart this chapter from the beginning */}
      <button
        onClick={onRestart}
        className="p-2 rounded-lg hover:bg-surface-hover transition-colors cursor-pointer"
        aria-label="重来"
        title="重来（本章从头开始，进度和统计清零）"
      >
        <RotateCcw size={15} className="text-muted" />
      </button>

      {/* 错字重练 —— 只在真的打错过字之后出现 */}
      {mistakes && mistakes.count > 0 && (
        <button
          onClick={mistakes.onRetry}
          className="p-2 rounded-lg text-accent bg-accent/10 hover:bg-accent/15 transition-colors cursor-pointer"
          aria-label="重练错字"
          title={`重练错字（本章打错了 ${mistakes.count} 处）`}
        >
          <Target size={15} />
        </button>
      )}

      {/* Pinyin toggle */}
      {pinyin && (
        <button
          onClick={() => pinyin.onChange(!pinyin.value)}
          className={`p-2 rounded-lg transition-colors cursor-pointer ${
            pinyin.value
              ? "bg-accent/10 text-accent"
              : "text-muted hover:bg-surface-hover"
          }`}
          aria-label="拼音"
          title={pinyin.value ? "拼音：已开启" : "拼音：显示每个字的读音"}
        >
          <Languages size={15} />
        </button>
      )}

      {/* Skip-punctuation toggle — the cursor travels over ，。！？ by itself */}
      {punctuation && (
        <button
          onClick={() => punctuation.onChange(!punctuation.value)}
          className={`p-2 rounded-lg transition-colors cursor-pointer ${
            punctuation.value
              ? "bg-accent/10 text-accent"
              : "text-muted hover:bg-surface-hover"
          }`}
          aria-label="跳过标点"
          title={punctuation.value ? "跳过标点：已开启（标点自动跳过）" : "跳过标点：打开后不用打标点符号"}
        >
          <PilcrowSquare size={15} />
        </button>
      )}

      {/* Keyboard finger hint toggle */}
      <button
        onClick={() => setShowKeyboardHint(!showKeyboardHint)}
        className={`p-2 rounded-lg transition-colors cursor-pointer ${
          showKeyboardHint
            ? "bg-accent/10 text-accent"
            : "text-muted hover:bg-surface-hover"
        }`}
        aria-label="键盘指法提示"
        title={showKeyboardHint ? "键盘提示：已开启（显示该用哪根手指）" : "键盘提示：显示键位和该用哪根手指"}
      >
        <Keyboard size={15} />
      </button>

      <div className="w-px h-5 bg-surface-hover mx-1" />

      {/* Theme */}
      {themes.map((t) => (
        <button
          key={t.key}
          onClick={() => setTheme(t.key)}
          className={`
            p-2 rounded-lg transition-colors cursor-pointer
            ${theme === t.key
              ? "bg-accent/10 text-accent"
              : "text-muted hover:bg-surface-hover"
            }
          `}
          aria-label={t.label}
          title={t.label}
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
              px-2 py-1 rounded-md text-xs font-medium transition-colors cursor-pointer
              ${fontFamily === f.key
                ? "bg-accent/10 text-accent"
                : "text-muted hover:bg-surface-hover"
              }
            `}
            title={f.label}
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
          className="p-1.5 rounded-md text-muted hover:bg-surface-hover transition-colors cursor-pointer"
          aria-label="缩小字号"
          title="缩小字号"
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
          className="p-1.5 rounded-md text-muted hover:bg-surface-hover transition-colors cursor-pointer"
          aria-label="放大字号"
          title="放大字号"
        >
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}
