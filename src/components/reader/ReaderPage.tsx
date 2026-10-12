import { useEffect, useState, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { useBookStore, useTypingStore } from "@/store";
import { useTypingEngine } from "@/hooks/useTypingEngine";
import { useAutoSave } from "@/hooks/useAutoSave";
import { TextDisplay } from "./TextDisplay";
import { ReaderControls } from "./ReaderControls";
import { ChapterPanel } from "./ChapterPanel";
import { CompletionSummary } from "./CompletionSummary";
import { LiveStats } from "@/components/stats/LiveStats";
import type { Book, Chapter } from "@/types/book";

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

  const { startSession, isActive, isComplete, setCursorIndex, setIncorrectIndices, cursorIndex, targetText } = useTypingStore();
  // When an overlay is open, block Escape from ending the session
  const [showCompletion, setShowCompletion] = useState(false);
  const blockEscapeRef = useRef(false);
  blockEscapeRef.current = showChapterPanel || showCompletion;
  const typingEngine = useTypingEngine({ blockEscapeRef });
  useAutoSave();

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
          // Restore saved progress
          if (book.currentPosition > 0) {
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
      setCurrentChapter(chapter);
      startSession(chapter.content);
    },
    [setCurrentChapter, startSession],
  );

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

  // Show completion overlay when chapter is finished
  useEffect(() => {
    if (isComplete) {
      setShowCompletion(true);
    }
  }, [isComplete]);

  const handleRestart = useCallback(() => {
    if (currentChapter) {
      setShowCompletion(false);
      startSession(currentChapter.content);
    }
  }, [currentChapter, startSession]);

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
              onClick={() => startSession(currentChapter.content)}
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

      {/* Live stats bar */}
      {isActive && <LiveStats />}

      {/* Scrollable text area */}
      <div className="flex-1 overflow-y-auto pb-20" data-scroll-container>
        <TextDisplay
          inputRef={typingEngine.inputRef}
          onInput={typingEngine.handleInput}
          onCompositionStart={typingEngine.handleCompositionStart}
          onCompositionEnd={typingEngine.handleCompositionEnd}
          onBlur={typingEngine.handleBlur}
          onKeyDown={typingEngine.handleKeydown}
        />
      </div>

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
      {showCompletion && (
        <CompletionSummary
          hasNextChapter={currentIdx >= 0 && currentIdx < chapters.length - 1}
          onNextChapter={handleNextFromCompletion}
          onBackToLibrary={() => navigate("/")}
          onRestart={handleRestart}
        />
      )}

      {/* Floating controls */}
      <ReaderControls
        hasPrevChapter={currentIdx > 0}
        hasNextChapter={currentIdx < chapters.length - 1}
        onPrevChapter={goToPrevChapter}
        onNextChapter={goToNextChapter}
        onToggleChapterPanel={() => setShowChapterPanel((v) => !v)}
      />
    </div>
  );
}