import { Plus, Loader2 } from "lucide-react";
import { useBookImport } from "@/hooks/useBookImport";
import { useBookStore } from "@/store";

/**
 * A prominent card inviting the user to import their first book,
 * or a compact button when books already exist.
 */
export function ImportZone() {
  const { importBooks } = useBookImport();
  const books = useBookStore((s) => s.books);
  const isLoading = useBookStore((s) => s.isLoading);

  const isEmpty = books.length === 0;

  if (!isEmpty) return null;

  return (
    <button
      onClick={() => void importBooks()}
      disabled={isLoading}
      className="
        group flex flex-col items-center justify-center gap-4
        w-72 h-64 rounded-xl
        border-2 border-dashed
        border-gray-300 dark:border-gray-600
        hover:border-accent/50 dark:hover:border-accent/40
        bg-surface-alt/50
        hover:bg-accent/[0.03]
        transition-all duration-200
        focus:outline-none focus:ring-2 focus:ring-accent/40
        animate-fade-in
      "
    >
      {isLoading ? (
        <Loader2 size={36} className="text-accent animate-spin" />
      ) : (
        <div
          className="
            w-14 h-14 rounded-full
            bg-surface-alt
            flex items-center justify-center
            group-hover:bg-accent/10
            transition-colors duration-200
          "
        >
          <Plus
            size={24}
            className="text-muted group-hover:text-accent transition-colors"
          />
        </div>
      )}

      <div className="text-center space-y-1">
        <p className="text-sm font-medium text-ink">
          Import your first book
        </p>
        <p className="text-xs text-muted">
          EPUB
        </p>
      </div>
    </button>
  );
}
