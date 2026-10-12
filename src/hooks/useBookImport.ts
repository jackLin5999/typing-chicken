import { useCallback } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useBookStore } from "@/store";
import type { Book } from "@/types/book";

/**
 * Tauri rejects with the raw string the Rust command returned, which the
 * parser prefixes with a stable code (`PDF_SCANNED: …`). Drop the code — it
 * exists for branching, not for the reader — and fall back to something
 * printable for non-string failures.
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

/**
 * Hook to trigger a native file dialog and import a book,
 * or import a file from a given path (e.g., drag & drop).
 */
export function useBookImport() {
  const addBook = useBookStore((s) => s.addBook);
  const setIsLoading = useBookStore((s) => s.setIsLoading);
  const setImportError = useBookStore((s) => s.setImportError);

  /** Import a book from a file path — shared by dialog picker and drag-drop. */
  const importFile = useCallback(
    async (filePath: string) => {
      setIsLoading(true);
      setImportError(null);
      try {
        const book = await invoke<Book>("import_book", { filePath });
        addBook(book);
        return book;
      } catch (err) {
        console.error("Failed to import book:", err);
        setImportError(importErrorMessage(err));
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [addBook, setIsLoading, setImportError],
  );

  /** Open a native file dialog and import the selected book. */
  const importBook = useCallback(async () => {
    try {
      const selected = await open({
        title: "Import a Book",
        multiple: false,
        filters: [
          {
            name: "E-Books",
            extensions: ["epub", "txt", "pdf"],
          },
        ],
      });

      if (!selected) return null;

      const filePath = selected as string;
      return importFile(filePath);
    } catch (err) {
      console.error("Failed to open file dialog:", err);
      return null;
    }
  }, [importFile]);

  return { importBook, importFile };
}
