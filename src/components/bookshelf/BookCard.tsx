import { BookOpen, FileText, FileType, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Book } from "@/types/book";
import { fileTypeLabel } from "@/lib/utils";

interface BookCardProps {
  book: Book;
  onClick: () => void;
  onDelete: (book: Book) => void;
}

const fileTypeIcons: Record<string, typeof BookOpen> = {
  epub: BookOpen,
  pdf: FileText,
  txt: FileType,
};

/** Cover placeholder gradient by file type. */
const coverGradient: Record<string, string> = {
  epub: "bg-gradient-to-br from-amber-100 to-orange-200 dark:from-amber-900/40 dark:to-orange-800/30",
  pdf: "bg-gradient-to-br from-red-100 to-rose-200 dark:from-red-900/40 dark:to-rose-800/30",
  txt: "bg-gradient-to-br from-blue-100 to-sky-200 dark:from-blue-900/40 dark:to-sky-800/30",
};

export function BookCard({ book, onClick, onDelete }: BookCardProps) {
  const Icon = fileTypeIcons[book.fileType] ?? BookOpen;
  const progressPct = Math.round(book.progressPct * 100);
  const [coverSrc, setCoverSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!book.coverImage) return;
    let cancelled = false;
    invoke<string>("get_image_data", { bookId: book.id, filename: book.coverImage })
      .then((dataUrl) => { if (!cancelled) setCoverSrc(dataUrl); })
      .catch(() => { /* silently use fallback */ });
    return () => { cancelled = true; };
  }, [book.id, book.coverImage]);

  return (
    <div className="group relative w-44 h-64 animate-slide-up">
      <button
        onClick={onClick}
        className="
          w-full h-full flex flex-col rounded-lg
          bg-surface
          border border-gray-200/60 dark:border-gray-700/40
          shadow-sm hover:shadow-md
          transition-all duration-200 ease-out
          hover:-translate-y-1 hover:border-accent/30
          focus:outline-none focus:ring-2 focus:ring-accent/40
          text-left overflow-hidden
        "
      >
        {/* Cover area — actual image or colored gradient fallback */}
        {coverSrc ? (
          <div className="h-36 overflow-hidden bg-white dark:bg-gray-900">
            <img
              src={coverSrc}
              alt=""
              className="w-full h-full object-contain bg-white dark:bg-gray-900"
            />
          </div>
        ) : (
          <div
            className={`flex items-center justify-center h-36 ${coverGradient[book.fileType] ?? ""}`}
          >
            <Icon
              size={40}
              className="
                text-gray-500 dark:text-gray-400
                group-hover:scale-110 transition-transform duration-300
              "
            />
          </div>
        )}

        {/* Info area */}
        <div className="flex-1 p-3 flex flex-col justify-between">
          <div>
            <h3 className="text-xs font-semibold text-ink leading-tight line-clamp-2">
              {book.title}
            </h3>
            <p className="text-[10px] text-muted mt-0.5 line-clamp-1">
              {book.author}
            </p>
          </div>

          <div className="flex items-center justify-between mt-1">
            <span className="text-[9px] uppercase tracking-wider text-muted">
              {fileTypeLabel(book.fileType)}
            </span>
            {progressPct > 0 && (
              <span className="text-[10px] font-medium text-accent tabular-nums">
                {progressPct}%
              </span>
            )}
          </div>
        </div>

        {/* Progress bar */}
        <div className="absolute bottom-0 left-0 right-0 h-[3px] bg-surface-alt">
          <div
            className="h-full bg-accent transition-all duration-500 rounded-r-sm"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </button>

      {/* Delete button — appears on hover */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDelete(book);
        }}
        className="
          absolute -top-2 -right-2
          w-6 h-6 rounded-full
          bg-surface
          border border-gray-200 dark:border-gray-600
          text-gray-400 hover:text-red-500 hover:border-red-300
          dark:hover:text-red-400 dark:hover:border-red-500
          shadow-sm
          flex items-center justify-center
          opacity-0 group-hover:opacity-100
          transition-all duration-150
          cursor-pointer
        "
        aria-label="Delete book"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}
