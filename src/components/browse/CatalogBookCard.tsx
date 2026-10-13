import { useState } from "react";
import { BookOpen, Check, Download, Loader2, TriangleAlert } from "lucide-react";
import type { CatalogBook } from "@/types/catalog";

/** How a card's download button is currently behaving. */
export type DownloadState =
  | { status: "idle" }
  | { status: "downloading"; percent: number | null }
  | { status: "done" }
  | { status: "error"; message: string };

interface CatalogBookCardProps {
  book: CatalogBook;
  /** True when a book with this catalog id is already on the shelf. */
  isInLibrary: boolean;
  state: DownloadState;
  onDownload: (book: CatalogBook) => void;
}

function formatDownloadCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万次下载`;
  return `${count} 次下载`;
}

/**
 * A single catalog result. Covers are remote images rendered with a plain
 * `<img>` — that is not subject to CORS, unlike a fetch, so no proxy is
 * involved; if the image fails we fall back to a plain placeholder.
 */
export function CatalogBookCard({
  book,
  isInLibrary,
  state,
  onDownload,
}: CatalogBookCardProps) {
  const [coverFailed, setCoverFailed] = useState(false);
  const showCover = book.coverUrl && !coverFailed;
  const isDownloading = state.status === "downloading";

  const buttonClass = `
    flex items-center justify-center gap-1.5 w-full py-1.5 rounded-md
    text-xs font-medium transition-colors
  `;

  return (
    <div className="flex flex-col w-full rounded-lg bg-surface border border-gray-200/60 dark:border-gray-700/40 shadow-sm overflow-hidden animate-slide-up">
      {/* Cover */}
      <div className="h-36 shrink-0 bg-gradient-to-br from-amber-100 to-orange-200 dark:from-amber-900/40 dark:to-orange-800/30 flex items-center justify-center overflow-hidden">
        {showCover ? (
          <img
            src={book.coverUrl!}
            alt=""
            loading="lazy"
            onError={() => setCoverFailed(true)}
            className="w-full h-full object-cover"
          />
        ) : (
          <BookOpen size={28} className="text-amber-700/50 dark:text-amber-300/40" />
        )}
      </div>

      {/* Meta */}
      <div className="flex flex-col flex-1 gap-1 p-3">
        <h3
          className="text-sm font-semibold text-ink leading-snug line-clamp-2"
          title={book.title}
        >
          {book.title}
        </h3>
        <p className="text-xs text-muted truncate" title={book.author}>
          {book.author}
        </p>
        <p className="text-[11px] text-muted/80 mt-auto pt-1">
          {formatDownloadCount(book.downloadCount)}
        </p>

        {/* Action */}
        <div className="pt-1.5">
          {isInLibrary || state.status === "done" ? (
            <div className={`${buttonClass} bg-surface-alt text-muted cursor-default`}>
              <Check size={13} className="text-accent-correct" />
              已加入书架
            </div>
          ) : isDownloading ? (
            <div className={`${buttonClass} bg-surface-alt text-accent cursor-default`}>
              <Loader2 size={13} className="animate-spin" />
              {state.percent === null ? "下载中…" : `下载中 ${state.percent}%`}
            </div>
          ) : (
            <button
              onClick={() => onDownload(book)}
              disabled={!book.epubUrl}
              className={`${buttonClass} bg-accent text-white hover:bg-blue-600 active:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer`}
            >
              <Download size={13} />
              下载
            </button>
          )}

          {state.status === "error" && (
            <p className="flex items-start gap-1 mt-1.5 text-[11px] text-error leading-snug">
              <TriangleAlert size={11} className="mt-0.5 shrink-0" />
              <span className="line-clamp-3">{state.message}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
