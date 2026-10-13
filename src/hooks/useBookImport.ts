import { useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke, Channel } from "@tauri-apps/api/core";
import { useBookStore, useSettingsStore } from "@/store";
import type { Book } from "@/types/book";
import type { CatalogBook, DownloadProgress, ImportResult } from "@/types/catalog";

/**
 * Tauri rejects with the raw string the Rust command returned, which the
 * parser prefixes with a stable code (`PDF_SCANNED: …`, `NET_TIMEOUT: …`).
 * Drop the code — it exists for branching, not for the reader — and fall back
 * to something printable for non-string failures.
 */
export function importErrorMessage(err: unknown): string {
  const raw =
    typeof err === "string"
      ? err
      : err instanceof Error
        ? err.message
        : String(err);
  const message = raw.replace(/^[A-Z][A-Z_]*:\s*/, "").trim();
  return message || "Could not import this file.";
}

/** Basename of a path that may use either separator. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/**
 * Hook to trigger a native file dialog and import books,
 * or import files from given paths (e.g., drag & drop).
 */
export function useBookImport() {
  const addBook = useBookStore((s) => s.addBook);
  const setIsLoading = useBookStore((s) => s.setIsLoading);
  const setImportError = useBookStore((s) => s.setImportError);

  /**
   * Import several files in sequence, reporting each outcome.
   *
   * Sequential rather than parallel: each import parses a whole book and
   * writes to SQLite behind one mutex, so overlapping them buys nothing and
   * makes the loading state meaningless. It also keeps the per-file results
   * in the same order the user dropped them.
   */
  const importFiles = useCallback(
    async (paths: string[]): Promise<ImportResult[]> => {
      if (paths.length === 0) return [];

      setIsLoading(true);
      setImportError(null);
      // Single-file imports keep the existing inline error banner; batch
      // imports get a summary from the caller instead, so a failure in file 3
      // of 20 is no longer silently overwritten by file 4.
      if (paths.length === 1) setImportError(null);

      const results: ImportResult[] = [];
      for (const path of paths) {
        try {
          const book = await invoke<Book>("import_book", { filePath: path });
          addBook(book);
          results.push({ path, book, error: null });
        } catch (err) {
          console.error("Failed to import book:", path, err);
          const message = importErrorMessage(err);
          if (paths.length === 1) setImportError(message);
          results.push({ path, book: null, error: message });
        }
      }

      setIsLoading(false);
      return results;
    },
    [addBook, setIsLoading, setImportError],
  );

  /** Import a single book from a file path — keeps the original contract. */
  const importFile = useCallback(
    async (filePath: string): Promise<Book | null> => {
      const [result] = await importFiles([filePath]);
      return result?.book ?? null;
    },
    [importFiles],
  );

  /** Open a native file dialog (multi-select) and import everything chosen. */
  const importBooks = useCallback(async (): Promise<ImportResult[]> => {
    try {
      const selected = await open({
        title: "Import Books",
        multiple: true,
        filters: [
          {
            name: "E-Books",
            extensions: ["epub", "txt", "pdf"],
          },
        ],
      });

      if (!selected) return [];

      const paths = Array.isArray(selected) ? selected : [selected];
      return await importFiles(paths);
    } catch (err) {
      console.error("Failed to open file dialog:", err);
      return [];
    }
  }, [importFiles]);

  /**
   * Download a public-domain book from the catalog and import it in one step.
   * Progress arrives over a Tauri channel from the Rust download loop.
   *
   * Returns the reason on failure rather than only logging it — the catalog
   * card shows it inline, and a swallowed message is how a whole class of
   * download failures stayed invisible before.
   */
  const downloadAndImport = useCallback(
    async (
      catalogBook: CatalogBook,
      onProgress?: (progress: DownloadProgress) => void,
    ): Promise<{ book: Book | null; error: string | null }> => {
      if (!catalogBook.epubUrl) {
        return { book: null, error: "这本书没有 EPUB 版本" };
      }

      setImportError(null);
      try {
        const channel = new Channel<DownloadProgress>();
        if (onProgress) channel.onmessage = onProgress;

        const book = await invoke<Book>("download_and_import_book", {
          gutenbergId: catalogBook.id,
          url: catalogBook.epubUrl,
          onProgress: channel,
          // 书库里的中文书几乎全是繁体，按用户设置决定要不要转简体
          convertToSimplified: useSettingsStore.getState().convertToSimplified,
        });
        addBook(book);
        return { book, error: null };
      } catch (err) {
        console.error("Failed to download book:", err);
        const message = importErrorMessage(err);
        setImportError(message);
        return { book: null, error: message };
      }
    },
    [addBook, setImportError],
  );

  return { importBooks, importFile, importFiles, downloadAndImport };
}
