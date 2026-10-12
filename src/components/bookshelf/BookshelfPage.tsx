import { useEffect, useState, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Plus, Library, Upload } from "lucide-react";
import { useBookStore } from "@/store";
import { useBookImport } from "@/hooks/useBookImport";
import { BookCard } from "./BookCard";
import { ImportZone } from "./ImportZone";
import type { Book } from "@/types/book";

const SUPPORTED_EXTENSIONS = ["epub", "txt", "pdf"];

function isSupportedFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_EXTENSIONS.includes(ext);
}

/**
 * The main landing page — a "bookshelf" grid of imported books.
 * Drag-and-drop file import via Tauri native events.
 */
export function BookshelfPage() {
  const navigate = useNavigate();
  const { books, setBooks } = useBookStore();
  const { importBook, importFile } = useBookImport();
  const [isDragOver, setIsDragOver] = useState(false);
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
          if ("paths" in event.payload && event.payload.paths.some(isSupportedFile)) {
            setIsDragOver(true);
          }
        } else if (type === "drop") {
          setIsDragOver(false);
          for (const path of event.payload.paths) {
            if (!isSupportedFile(path)) continue;
            // Prevent duplicate imports of the same file in the same drop
            if (processedPaths.current.has(path)) continue;
            processedPaths.current.add(path);
            importFile(path);
          }
          // Clear processed paths after a short delay
          setTimeout(() => processedPaths.current.clear(), 2000);
        } else if (type === "leave") {
          setIsDragOver(false);
        }
      })
      .then((fn) => { unlisten = fn; })
      .catch(console.error);

    return () => { unlisten?.(); };
  }, [importFile]);

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
          <p className="text-lg font-semibold text-accent">Drop your file to import</p>
          <p className="text-sm text-muted">EPUB, PDF, or TXT</p>
        </div>
      )}

      <div className="max-w-6xl mx-auto px-8 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-10">
          <div>
            <h1 className="text-2xl font-bold text-ink font-serif tracking-tight">
              Library
            </h1>
            <p className="text-sm text-muted mt-1">
              {books.length === 0
                ? "Import a book to start typing"
                : `${books.length} book${books.length === 1 ? "" : "s"} in your library`}
            </p>
          </div>

          {books.length > 0 && (
            <button
              onClick={importBook}
              className="flex items-center gap-2 px-4 py-2 rounded-lg
                bg-accent text-white text-sm font-medium
                hover:bg-blue-600 active:bg-blue-700 transition-colors shadow-sm"
            >
              <Plus size={16} />
              Import Book
            </button>
          )}
        </div>

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
              onClick={importBook}
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
                Add Book
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
