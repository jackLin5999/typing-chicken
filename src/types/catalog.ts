import type { Book } from "./book";

/** A public-domain book as listed by the Gutendex catalog. */
export interface CatalogBook {
  id: number;
  title: string;
  author: string;
  /** Remote cover image URL (null if the catalog has none). */
  coverUrl: string | null;
  /** EPUB download URL — null for catalog entries with no EPUB edition. */
  epubUrl: string | null;
  languages: string[];
  downloadCount: number;
}

/** One page of catalog search results. */
export interface CatalogPage {
  count: number;
  page: number;
  hasNext: boolean;
  results: CatalogBook[];
}

/** Byte-level download progress reported from the Rust side. */
export interface DownloadProgress {
  received: number;
  /** Null when the server omitted Content-Length — show an indeterminate bar. */
  total: number | null;
}

/** Outcome of importing a single file within a batch. */
export interface ImportResult {
  path: string;
  book: Book | null;
  /** Human-readable reason, already stripped of its stable error code. */
  error: string | null;
}
