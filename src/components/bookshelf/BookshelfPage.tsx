import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Plus, Library, Upload, AlertTriangle, CheckCircle2, X } from "lucide-react";
import { useBookStore } from "@/store";
import { useBookImport, fileNameOf } from "@/hooks/useBookImport";
import { BookCard } from "./BookCard";
import { ImportZone } from "./ImportZone";
import type { Book } from "@/types/book";
import type { ImportResult } from "@/types/catalog";

const SUPPORTED_EXTENSIONS = ["epub", "txt", "pdf"];

function isSupportedFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_EXTENSIONS.includes(ext);
}

/**
 * Best-effort "is this a folder?" for the drag-over highlight only.
 * Rust's `resolve_import_paths` is the source of truth for what actually gets
 * imported — this just decides whether to light up the drop overlay.
 */
function looksLikeFolder(path: string): boolean {
  const base = fileNameOf(path);
  return !base.includes(".");
}

/**
 * The main landing page — a "bookshelf" grid of imported books.
 * Drag-and-drop file import via Tauri native events.
 */
export function BookshelfPage() {
  const navigate = useNavigate();
  const { books, setBooks, importError, setImportError } = useBookStore();
  const { importBooks, importFiles } = useBookImport();
  const [isDragOver, setIsDragOver] = useState(false);
  const [summary, setSummary] = useState<ImportResult[] | null>(null);
  const processedPaths = useRef<Set<string>>(new Set());

  // Load books from the local database on mount
  useEffect(() => {
    invoke<Book[]>("get_all_books")
      .then(setBooks)
      .catch(console.error);
  }, [setBooks]);

  // Listen for file drag-and-drop events (single source — no duplicates)
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    getCurrentWindow()
      .onDragDropEvent((event) => {
        const { type } = event.payload;
        if (type === "enter") {
          if (
            "paths" in event.payload &&
            event.payload.paths.some((p) => isSupportedFile(p) || looksLikeFolder(p))
          ) {
            setIsDragOver(true);
          }
        } else if (type === "drop") {
          setIsDragOver(false);
          const dropped = event.payload.paths;

          // Dropped folders are expanded in Rust — the fs plugin would reject
          // paths outside its granted scope, so `std::fs` does the walking.
          invoke<string[]>("resolve_import_paths", { paths: dropped })
            .then((files) => {
              const fresh = files.filter((p) => !processedPaths.current.has(p));
              fresh.forEach((p) => processedPaths.current.add(p));
              if (fresh.length === 0) return;
              // Batch: collect every outcome so one bad file can't hide the rest.
              return importFiles(fresh).then((results) => {
                setSummary(results.length > 1 ? results : null);
              });
            })
            .catch(console.error);

          setTimeout(() => processedPaths.current.clear(), 3000);
        } else if (type === "leave") {
          setIsDragOver(false);
        }
      })
      .then((fn) => { unlisten = fn; })
      .catch(console.error);

    return () => { unlisten?.(); };
  }, [importFiles]);

  const handleBookClick = useCallback(
    (book: Book) => navigate(`/read/${book.id}`),
    [navigate],
  );

  const handleDeleteBook = useCallback(
    async (book: Book) => {
      try {
        await invoke("delete_book", { bookId: book.id });
        setBooks(books.filter((b) => b.id !== book.id));
      } catch (err) {
        console.error("Failed to delete book:", err);
      }
    },
    [books, setBooks],
  );

  /** Import via the native dialog (multi-select), then summarise the batch. */
  const handleImportClick = useCallback(async () => {
    const results = await importBooks();
    setSummary(results.length > 1 ? results : null);
  }, [importBooks]);

  const overallPct =
    books.length > 0
      ? Math.round(
          (books.reduce((sum, b) => sum + b.progressPct, 0) / books.length) * 100,
        )
      : 0;

  return (
    <div className="h-full overflow-y-auto relative">
      {/* Overall library progress bar */}
      {overallPct > 0 && (
        <div className="sticky top-0 left-0 right-0 h-[3px] bg-surface-hover z-50 shrink-0">
          <div
            className="h-full bg-accent transition-[width] duration-300 ease-out rounded-r-sm"
            style={{ width: `${overallPct}%` }}
          />
        </div>
      )}

      {/* Drag-over overlay */}
      {isDragOver && (
        <div
          className="
            fixed inset-0 z-50
            flex flex-col items-center justify-center gap-4
            bg-accent/10 dark:bg-accent/5
            border-[3px] border-dashed border-accent
            backdrop-blur-sm pointer-events-none
          "
        >
          <div className="w-20 h-20 rounded-full bg-accent/20 flex items-center justify-center">
            <Upload size={36} className="text-accent" />
          </div>
          <p className="text-lg font-semibold text-accent">松手即可导入</p>
          <p className="text-sm text-muted">支持 EPUB 文件或整个文件夹</p>
        </div>
      )}

      <div className="max-w-6xl mx-auto px-8 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <div>
            <h1 className="text-2xl font-bold text-ink font-serif tracking-tight">
              书架
            </h1>
            <p className="text-sm text-muted mt-1">
              {books.length === 0
                ? "导入一本书就能开始练了"
                : `共 ${books.length} 本`}
            </p>
          </div>

          {books.length > 0 && (
            <button
              onClick={handleImportClick}
              className="flex items-center gap-2 px-4 py-2 rounded-lg
                bg-accent text-white text-sm font-medium
                hover:bg-blue-600 active:bg-blue-700 transition-colors shadow-sm"
            >
              <Plus size={16} />
              导入书籍
            </button>
          )}
        </div>

        {/* Import failure — e.g. a scanned PDF that has no text layer to read */}
        {importError && (
          <div className="mb-8 flex items-start gap-3 rounded-lg border border-error/30 bg-error/[0.06] px-4 py-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-error" />
            <p className="flex-1 text-sm text-ink leading-relaxed">{importError}</p>
            <button
              onClick={() => setImportError(null)}
              aria-label="关闭"
              className="shrink-0 rounded p-0.5 text-muted hover:text-ink transition-colors cursor-pointer"
            >
              <X size={16} />
            </button>
          </div>
        )}

        {/* Batch import summary — only for multi-file imports; a lone failure
            uses the single-error banner above instead. */}
        {summary && (() => {
          const ok = summary.filter((r) => r.book).length;
          const failed = summary.filter((r) => r.error);
          return (
            <div className="mb-8 flex items-start gap-3 rounded-lg border border-gray-200/60 dark:border-gray-700/40 bg-surface px-4 py-3">
              {failed.length === 0 ? (
                <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-accent-correct" />
              ) : (
                <AlertTriangle size={18} className="mt-0.5 shrink-0 text-error" />
              )}
              <div className="flex-1 text-sm text-ink leading-relaxed">
                <p>
                  已导入 {ok} 本
                  {failed.length > 0 ? `，${failed.length} 本失败` : ""}
                </p>
                {failed.length > 0 && (
                  <details className="mt-1.5">
                    <summary className="cursor-pointer text-xs text-muted hover:text-ink transition-colors">
                      查看失败原因
                    </summary>
                    <ul className="mt-1.5 space-y-1">
                      {failed.map((r) => (
                        <li key={r.path} className="text-xs text-muted">
                          <span className="text-ink">{fileNameOf(r.path)}</span> — {r.error}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
              <button
                onClick={() => setSummary(null)}
                aria-label="Dismiss"
                className="shrink-0 rounded p-0.5 text-muted hover:text-ink transition-colors cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>
          );
        })()}

        {/* Empty state */}
        {books.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-6">
            <Library size={48} className="text-gray-300 dark:text-gray-600" strokeWidth={1.5} />
            <ImportZone />
          </div>
        )}

        {/* Bookshelf grid */}
        {books.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
            {books.map((book) => (
              <BookCard key={book.id} book={book} onClick={() => handleBookClick(book)} onDelete={handleDeleteBook} />
            ))}

            {/* Mini import card */}
            <button
              onClick={handleImportClick}
              className="group flex flex-col items-center justify-center
                w-44 h-64 rounded-lg border-2 border-dashed
                border-gray-200 dark:border-gray-700 hover:border-accent/40
                bg-transparent transition-all duration-200 hover:-translate-y-0.5 gap-2"
            >
              <Plus
                size={22}
                className="text-gray-300 dark:text-gray-600 group-hover:text-accent transition-colors"
              />
              <span className="text-xs text-muted group-hover:text-accent transition-colors">
                导入书籍
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
