import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { importErrorMessage } from "@/hooks/useBookImport";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import type { CatalogBook, CatalogPage } from "@/types/catalog";

export type CatalogLanguage = "zh" | "en";

/**
 * Search state for the public-domain catalog (Gutendex / Project Gutenberg).
 *
 * The request goes through Rust rather than webview `fetch`: the EPUB download
 * has to (gutenberg.org sends no CORS headers), so both calls share one
 * proxy-aware HTTP client on that side.
 */
export function useGutendex() {
  const [language, setLanguage] = useState<CatalogLanguage>("zh");
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 350);

  const [results, setResults] = useState<CatalogBook[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Guards against a slow early request overwriting a newer one's results.
  const requestIdRef = useRef(0);

  const fetchPage = useCallback(
    async (targetPage: number, replace: boolean) => {
      const requestId = ++requestIdRef.current;
      setIsLoading(true);
      setError(null);
      try {
        const data = await invoke<CatalogPage>("search_gutendex", {
          query: debouncedQuery,
          language,
          page: targetPage,
        });
        if (requestId !== requestIdRef.current) return; // superseded

        setResults((prev) => (replace ? data.results : [...prev, ...data.results]));
        setTotal(data.count);
        setPage(data.page);
        setHasNext(data.hasNext);
      } catch (err) {
        if (requestId !== requestIdRef.current) return;
        console.error("Catalog search failed:", err);
        setError(importErrorMessage(err));
        if (replace) {
          setResults([]);
          setTotal(0);
          setHasNext(false);
        }
      } finally {
        if (requestId === requestIdRef.current) setIsLoading(false);
      }
    },
    [debouncedQuery, language],
  );

  // Re-run from page 1 whenever the language or the debounced query changes.
  useEffect(() => {
    void fetchPage(1, true);
  }, [fetchPage]);

  const loadMore = useCallback(() => {
    if (!hasNext || isLoading) return;
    void fetchPage(page + 1, false);
  }, [fetchPage, hasNext, isLoading, page]);

  return {
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
    retry: () => void fetchPage(1, true),
  };
}
