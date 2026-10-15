import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { useBookStore, useSettingsStore, useTypingStore } from "@/store";
import { KeyboardHint } from "@/components/keyboard/KeyboardHint";
import { useTypingEngine } from "@/hooks/useTypingEngine";
import { useAutoSave } from "@/hooks/useAutoSave";
import { useSessionRecorder } from "@/hooks/useSessionRecorder";
import { buildMistakeDrill, countMistakes } from "@/lib/drill";
import { TextDisplay } from "./TextDisplay";
import { ReaderControls, CONTROLS_CLEARANCE } from "./ReaderControls";
import { ChapterPanel } from "./ChapterPanel";
import { CompletionSummary } from "./CompletionSummary";
import { LiveStats } from "@/components/stats/LiveStats";
import type { Book, Chapter } from "@/types/book";
import type { TypingStats } from "@/types/typing";

/**
 * The immersive reading/typing view for a selected book.
 */
export function ReaderPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [showChapterPanel, setShowChapterPanel] = useState(false);

  const {
    currentBook,
    setCurrentBook,
    chapters,
    setChapters,
    currentChapter,
    setCurrentChapter,
  } = useBookStore();

  const { startSession, isActive, isComplete, setCursorIndex, setIncorrectIndices, cursorIndex, targetText, incorrectIndices } = useTypingStore();

  /**
   * 错字重练：非 null 时，正在练的是一段临时生成的文本而不是章节正文。
   *
   * 这一段**不写回数据库**（useAutoSave 会因此关掉），否则重练时的光标位置
   * 会被当成阅读进度覆盖掉这一章的正常进度。退出时把进入前的光标和错字
   * 标记原样还回去，用户不会因为点了一下重练就丢失位置。
   */
  const [drill, setDrill] = useState<{
    text: string;
    returnCursor: number;
    returnIncorrect: number[];
  } | null>(null);
  const isDrill = drill !== null;

  // When an overlay is open, block Escape from ending the session
  const [showCompletion, setShowCompletion] = useState(false);
  const blockEscapeRef = useRef(false);
  blockEscapeRef.current = showChapterPanel || showCompletion;
  const typingEngine = useTypingEngine({ blockEscapeRef });
  useAutoSave({ enabled: !isDrill });
  // 练完一章记一笔；重练也记，但标记成 isDrill 以免混进正常曲线的语义里
  useSessionRecorder({ isDrill });

  // Load book + chapters
  useEffect(() => {
    if (!bookId) return;
    setIsLoading(true);

    Promise.all([
      invoke<Book[]>("get_all_books"),
      invoke<Chapter[]>("get_book_chapters", { bookId }),
    ])
      .then(([books, chaps]) => {
        const book = books.find((b) => b.id === bookId);
        if (!book) {
          navigate("/");
          return;
        }

        setCurrentBook(book);
        setChapters(chaps);

        const startChapterIdx = book.currentChapter || 0;
        const startChapter = chaps[startChapterIdx] ?? chaps[0];
        setCurrentChapter(startChapter ?? null);

        if (startChapter) {
          startSession(startChapter.content);
          // Restore saved progress.
          //
          // 只在**没打完**时才恢复光标：如果上次已经把这一章打到底，
          // currentPosition 就落在正文末尾，恢复过去等于把光标放在死胡同里 ——
          // 此时「跳过标点」的自动跳过会一路走到末尾并把 isComplete 置为 true，
          // **一个键都没敲却弹出结算界面**（击键 0 / 0、速度 0）。
          // 这种情况下干脆从头开始。
          if (book.currentPosition > 0 && book.currentPosition < startChapter.content.length) {
            setCursorIndex(book.currentPosition);
            // Restore incorrect positions (red marks)
            try {
              const parsed = JSON.parse(book.incorrectPositions || "[]");
              if (Array.isArray(parsed) && parsed.length > 0) {
                setIncorrectIndices(parsed.filter((i: number) => i < book.currentPosition));
              }
            } catch { /* ignore malformed JSON */ }
          }
        }
      })
      .catch(console.error)
      .finally(() => setIsLoading(false));
  }, [bookId]);

  // Load a specific chapter into the typing session
  const loadChapter = useCallback(
    (chapter: Chapter) => {
      setDrill(null); // 换章 = 离开重练
      setCurrentChapter(chapter);
      startSession(chapter.content);
    },
    [setCurrentChapter, startSession],
  );

  /** 进入错字重练：把这一章打过错的句子抽出来单独练。 */
  const handleStartDrill = useCallback(() => {
    const { targetText: text, incorrectIndices, cursorIndex: cursor } =
      useTypingStore.getState();
    const drillText = buildMistakeDrill(text, incorrectIndices);
    if (!drillText) return; // 没有错字，或错字都不在正文范围内

    setShowCompletion(false);
    setDrill({ text: drillText, returnCursor: cursor, returnIncorrect: incorrectIndices });
    startSession(drillText);
  }, [startSession]);

  /** 退出重练，回到本章正文并还原进入前的位置与红色标记。 */
  const handleExitDrill = useCallback(() => {
    if (!drill || !currentChapter) return;
    setDrill(null);
    setShowCompletion(false);
    startSession(currentChapter.content);
    if (drill.returnCursor > 0) {
      setCursorIndex(drill.returnCursor);
      setIncorrectIndices(drill.returnIncorrect.filter((i) => i < drill.returnCursor));
    }
  }, [drill, currentChapter, startSession, setCursorIndex, setIncorrectIndices]);

  // Navigate to prev/next chapter
  const currentIdx = chapters.findIndex((ch) => ch.id === currentChapter?.id);

  const goToPrevChapter = useCallback(() => {
    if (currentIdx > 0) {
      loadChapter(chapters[currentIdx - 1]);
    }
  }, [currentIdx, chapters, loadChapter]);

  const goToNextChapter = useCallback(() => {
    if (currentIdx < chapters.length - 1) {
      loadChapter(chapters[currentIdx + 1]);
    }
  }, [currentIdx, chapters, loadChapter]);

  // Keyboard shortcuts for chapter navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Alt+Left / Alt+Right for chapter navigation
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        goToPrevChapter();
      } else if (e.altKey && e.key === "ArrowRight") {
        e.preventDefault();
        goToNextChapter();
      } else if (e.altKey && e.key === "t") {
        e.preventDefault();
        setShowChapterPanel((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [goToPrevChapter, goToNextChapter]);

  /**
   * 结算界面显示的是**完成那一刻**的成绩快照。
   *
   * 为什么不直接读 store 的实时 stats：
   * 1. 会话在结算界面期间仍然是 active 的（要按 ESC 才真正结束），
   *    任何后续写入都会改动屏幕上的数字 —— 时钟继续跑会让 WPM 越看越低；
   * 2. 恢复进度时是 `startSession`（把 stats 清零）之后紧跟 `setCursorIndex`
   *    把光标放回原位 —— 如果这一章之前就打完过，会弹出一个
   *    「击键 0 / 0、速度 0」的假结算。
   */
  const showKeyboardHint = useSettingsStore((s) => s.showKeyboardHint);
  const showPinyin = useSettingsStore((s) => s.showPinyin);
  const setShowPinyin = useSettingsStore((s) => s.setShowPinyin);
  const skipPunctuation = useSettingsStore((s) => s.skipPunctuation);
  const setSkipPunctuation = useSettingsStore((s) => s.setSkipPunctuation);
  /** 光标停在哪个字符上，就提示哪个键。 */
  const nextChar = targetText[cursorIndex];
  /** 键盘提示此刻是否真画在屏幕上 —— 它在流内占位，让位空间要跟着它开关。 */
  const showKeyboard = isActive && showKeyboardHint;

  const [finalStats, setFinalStats] = useState<TypingStats | null>(null);

  useEffect(() => {
    if (!isComplete) {
      setFinalStats(null);
      return;
    }

    const snapshot = useTypingStore.getState().stats;

    // 一个字都没打的「完成」不是真的完成（整章都是空白，或光标被恢复到了末尾）
    if (snapshot.totalKeystrokes === 0) {
      setShowCompletion(false);
      return;
    }

    setFinalStats(snapshot);
    setShowCompletion(true);
  }, [isComplete]);

  const handleRestart = useCallback(() => {
    setShowCompletion(false);
    // 重练中按「重来」应该重来这一段重练，而不是跳回章节正文
    if (drill) {
      startSession(drill.text);
      return;
    }
    if (currentChapter) startSession(currentChapter.content);
  }, [drill, currentChapter, startSession]);

  const handleNextFromCompletion = useCallback(() => {
    setShowCompletion(false);
    goToNextChapter();
  }, [goToNextChapter]);

  const progressPct =
    targetText.length > 0 ? Math.round((cursorIndex / targetText.length) * 100) : 0;

  const bgClass = "bg-paper";

  if (isLoading) {
    return (
      <div className={`h-full ${bgClass} flex items-center justify-center`}>
        <div className="flex flex-col items-center gap-3 animate-fade-in">
          <div className="w-8 h-8 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-muted font-sans">
            Opening {currentBook?.title ?? "book"}…
          </p>
        </div>
      </div>
    );
  }

  if (!currentChapter || chapters.length === 0) {
    return (
      <div className={`h-full ${bgClass} flex items-center justify-center`}>
        <div className="text-center space-y-3">
          <p className="text-muted">
            {chapters.length === 0 ? "No chapters found." : "No chapter selected."}
          </p>
          <button
            onClick={() => navigate("/")}
            className="text-sm text-accent hover:underline"
          >
            Back to Library
          </button>
        </div>
      </div>
    );
  }

  // User ended session (ESC) — show prompt instead of blank white screen
  if (!isActive && !isComplete) {
    return (
      <div className={`h-full ${bgClass} flex items-center justify-center`}>
        <div className="text-center space-y-4 animate-fade-in">
          <p className="text-muted text-sm">练习已结束</p>
          <div className="flex items-center gap-3 justify-center">
            <button
              onClick={handleRestart}
              className="px-3 py-1.5 text-sm rounded-md bg-accent text-white hover:bg-accent/90 transition-colors"
            >
              重新开始
            </button>
            <button
              onClick={() => navigate("/")}
              className="text-sm text-muted hover:text-ink transition-colors"
            >
              返回书架
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`h-full ${bgClass} flex flex-col`}>
      {/* Chapter progress bar */}
      {isActive && (
        <div className="h-[3px] bg-surface-hover shrink-0">
          <div
            className="h-full bg-accent transition-[width] duration-300 ease-out rounded-r-sm"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      )}

      {/* 错字重练提示条 —— 否则用户会以为自己在练正文 */}
      {isDrill && (
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 bg-accent/[0.07] border-b border-accent/20">
          <p className="text-xs text-ink">
            <span className="font-semibold text-accent">错字重练</span>
            <span className="ml-2 text-muted">
              正在练本章你打错过的句子
            </span>
          </p>
          <button
            onClick={handleExitDrill}
            className="shrink-0 px-2.5 py-1 rounded-md bg-surface-alt text-ink text-xs font-medium hover:bg-surface-hover transition-colors cursor-pointer"
          >
            返回本章
          </button>
        </div>
      )}

      {/* Live stats bar */}
      {isActive && <LiveStats />}

      {/* Scrollable text area —— 底部的让位空间只在下方的工具栏真的会盖过来时才要。
          键盘提示在流内、并且自己已经让过位，这里就只留一点呼吸空间。 */}
      <div
        className={`flex-1 overflow-y-auto ${showKeyboard ? "pb-4" : CONTROLS_CLEARANCE}`}
        data-scroll-container
      >
        <TextDisplay
          inputRef={typingEngine.inputRef}
          onInput={typingEngine.handleInput}
          onCompositionStart={typingEngine.handleCompositionStart}
          onCompositionEnd={typingEngine.handleCompositionEnd}
          onBlur={typingEngine.handleBlur}
          onKeyDown={typingEngine.handleKeydown}
        />
      </div>

      {/* 指法提示 —— 在打字区正下方，视线不用来回跑。
          CONTROLS_CLEARANCE 把它整体抬到浮动工具栏之上，否则手掌和提示文字会被盖住。 */}
      {showKeyboard && (
        <div
          className={`shrink-0 max-w-2xl w-full mx-auto px-4 ${CONTROLS_CLEARANCE}`}
        >
          <KeyboardHint nextChar={nextChar} />
        </div>
      )}

      {/* Chapter title hint */}
      <div className="fixed top-12 left-0 right-0 text-center py-2 pointer-events-none z-30">
        <span className="text-[11px] tracking-wider uppercase text-muted font-sans">
          {currentChapter.title}
        </span>
      </div>

      {/* Chapter panel sidebar */}
      {showChapterPanel && (
        <ChapterPanel
          chapters={chapters}
          currentChapterId={currentChapter?.id ?? null}
          onSelect={loadChapter}
          onClose={() => setShowChapterPanel(false)}
        />
      )}

      {/* Chapter completion overlay */}
      {showCompletion && finalStats && (
        <CompletionSummary
          stats={finalStats}
          hasNextChapter={currentIdx >= 0 && currentIdx < chapters.length - 1}
          onNextChapter={handleNextFromCompletion}
          onBackToLibrary={() => navigate("/")}
          onRestart={handleRestart}
          isDrill={isDrill}
          mistakeCount={countMistakes(targetText, incorrectIndices)}
          onRetryMistakes={handleStartDrill}
        />
      )}

      {/* Floating controls */}
      <ReaderControls
        onBack={() => navigate("/")}
        onRestart={handleRestart}
        chapters={{
          hasPrev: currentIdx > 0,
          hasNext: currentIdx < chapters.length - 1,
          onPrev: goToPrevChapter,
          onNext: goToNextChapter,
          onTogglePanel: () => setShowChapterPanel((v) => !v),
        }}
        mistakes={{
          count: isDrill ? 0 : countMistakes(targetText, incorrectIndices),
          onRetry: handleStartDrill,
        }}
        pinyin={{ value: showPinyin, onChange: setShowPinyin }}
        punctuation={{ value: skipPunctuation, onChange: setSkipPunctuation }}
      />
    </div>
  );
}