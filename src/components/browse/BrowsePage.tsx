import { useCallback, useMemo, useState } from "react";
import { BookMarked, Languages, Loader2, Search, TriangleAlert, X } from "lucide-react";
import { useBookStore, useSettingsStore } from "@/store";
import { useBookImport } from "@/hooks/useBookImport";
import { useGutendex } from "@/hooks/useGutendex";
import type { CatalogBook } from "@/types/catalog";
import { CatalogBookCard, type DownloadState } from "./CatalogBookCard";

const LANGUAGES: { value: "zh" | "en"; label: string }[] = [
  { value: "zh", label: "中文" },
  { value: "en", label: "English" },
];

/**
 * 书库 — browse and download public-domain books from Project Gutenberg.
 *
 * Everything here is public domain, so nothing needs licensing: the catalog is
 * the official Gutendex API and the files come from gutenberg.org.
 */
export function BrowsePage() {
  const {
    language,
    setLanguage,
    query,
    setQuery,
    results,
    total,
    hasNext,
    isLoading,
    error,
    loadMore,
    retry,
  } = useGutendex();
  const { downloadAndImport } = useBookImport();
  const books = useBookStore((s) => s.books);
  const convertToSimplified = useSettingsStore((s) => s.convertToSimplified);
  const setConvertToSimplified = useSettingsStore((s) => s.setConvertToSimplified);
  const [downloads, setDownloads] = useState<Record<number, DownloadState>>({});

  // Catalog ids already on the shelf, so we can mark them as 已加入书架.
  const librarySourceIds = useMemo(
    () => new Set(books.map((b) => b.sourceId).filter((id): id is string => id !== null)),
    [books],
  );

  const handleDownload = useCallback(
    async (book: CatalogBook) => {
      setDownloads((prev) => ({ ...prev, [book.id]: { status: "downloading", percent: null } }));

      const { book: imported, error } = await downloadAndImport(book, (progress) => {
        const percent =
          progress.total && progress.total > 0
            ? Math.min(100, Math.round((progress.received / progress.total) * 100))
            : null;
        setDownloads((prev) => ({
          ...prev,
          [book.id]: { status: "downloading", percent },
        }));
      });

      // 原样显示真实原因（URL 被拒/超时/连不上/文件损坏…），
      // 不要笼统的「下载或导入失败」—— 那样会把整类失败都藏起来。
      setDownloads((prev) => ({
        ...prev,
        [book.id]: imported
          ? { status: "done" }
          : { status: "error", message: error ?? "下载或导入失败，请重试" },
      }));
    },
    [downloadAndImport],
  );

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-6xl mx-auto px-8 py-10">
        {/* Header */}
        <header className="mb-6">
          <div className="flex items-center gap-3">
            <BookMarked size={22} className="text-accent" />
            <h1 className="text-2xl font-bold text-ink font-serif">书库</h1>
          </div>
          <p className="mt-1 text-sm text-muted">
            来自 Project Gutenberg 的公版书，可直接下载并加入书架
          </p>
        </header>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3 mb-6">
          <div className="relative flex-1 min-w-[240px]">
            <Search
              size={15}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="搜索书名或作者…"
              className="
                w-full h-9 pl-9 pr-9 rounded-lg
                bg-surface border border-gray-200/60 dark:border-gray-700/40
                text-sm text-ink placeholder:text-muted
                outline-none focus:border-accent/50 focus:ring-2 focus:ring-accent/20
                transition-colors
              "
            />
            {query && (
              <button
                onClick={() => setQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-muted hover:text-ink hover:bg-surface-hover transition-colors cursor-pointer"
                aria-label="清除搜索"
              >
                <X size={13} />
              </button>
            )}
          </div>

          {/* Language toggle */}
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-surface-alt">
            {LANGUAGES.map(({ value, label }) => (
              <button
                key={value}
                onClick={() => setLanguage(value)}
                className={`
                  h-8 px-3 rounded-md text-xs font-medium transition-colors cursor-pointer
                  ${language === value
                    ? "bg-surface text-accent shadow-sm"
                    : "text-muted hover:text-ink"}
                `}
                aria-pressed={language === value}
              >
                {label}
              </button>
            ))}
          </div>

          {/* 繁→简：书库里的中文书几乎全是繁体，默认转换 */}
          <button
            onClick={() => setConvertToSimplified(!convertToSimplified)}
            className={`
              flex items-center gap-1.5 h-8 px-3 rounded-lg
              text-xs font-medium transition-colors cursor-pointer
              ${convertToSimplified
                ? "bg-accent/10 text-accent"
                : "bg-surface-alt text-muted hover:text-ink"}
            `}
            aria-pressed={convertToSimplified}
            title="下载后自动把繁体转成简体（本地导入的书不受影响）"
          >
            <Languages size={13} />
            转简体
          </button>
        </div>

        {/* Result count */}
        {!isLoading && !error && results.length > 0 && (
          <p className="mb-4 text-xs text-muted">共 {total} 本公版书</p>
        )}

        {/* Error */}
        {error && (
          <div className="flex items-start gap-3 rounded-lg border border-error/30 bg-error/[0.06] px-4 py-3 mb-6">
            <TriangleAlert size={16} className="mt-0.5 shrink-0 text-error" />
            <p className="flex-1 text-sm text-ink">{error}</p>
            <button
              onClick={retry}
              className="shrink-0 px-3 py-1 rounded-md bg-surface-alt text-xs font-medium text-ink hover:bg-surface-hover transition-colors cursor-pointer"
            >
              重试
            </button>
          </div>
        )}

        {/* Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-5">
          {results.map((book) => (
            <CatalogBookCard
              key={book.id}
              book={book}
              isInLibrary={librarySourceIds.has(String(book.id))}
              state={downloads[book.id] ?? { status: "idle" }}
              onDownload={handleDownload}
            />
          ))}
        </div>

        {/* Loading / empty / more */}
        {/* Full-page loading only on a cold search — once results are on screen
            the grid stays put and the bottom button carries the spinner. */}
        {isLoading && results.length === 0 && (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <Loader2 size={22} className="animate-spin text-accent" />
            <p className="text-sm text-muted">正在获取书库…</p>
          </div>
        )}

        {!isLoading && !error && results.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <BookMarked size={38} className="text-muted/40" />
            <p className="text-sm text-muted">没有找到符合条件的书</p>
          </div>
        )}

        {results.length > 0 && (hasNext || isLoading) && (
          <div className="flex justify-center mt-8">
            <button
              onClick={loadMore}
              disabled={isLoading}
              className="flex items-center gap-2 px-5 py-2 rounded-lg bg-surface-alt text-ink text-sm font-medium hover:bg-surface-hover transition-colors disabled:opacity-60 cursor-pointer disabled:cursor-default"
            >
              {isLoading && <Loader2 size={14} className="animate-spin text-accent" />}
              加载更多
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
