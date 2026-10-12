import { create } from "zustand";
import type { Book, Chapter } from "@/types/book";

interface BookState {
  books: Book[];
  currentBook: Book | null;
  chapters: Chapter[];
  currentChapter: Chapter | null;
  isLoading: boolean;
  /** Message from the last failed import, shown on the bookshelf. */
  importError: string | null;

  // Actions
  setBooks: (books: Book[]) => void;
  addBook: (book: Book) => void;
  removeBook: (id: string) => void;
  setCurrentBook: (book: Book | null) => void;
  setChapters: (chapters: Chapter[]) => void;
  setCurrentChapter: (chapter: Chapter | null) => void;
  setIsLoading: (loading: boolean) => void;
  setImportError: (message: string | null) => void;
}

export const useBookStore = create<BookState>((set) => ({
  books: [],
  currentBook: null,
  chapters: [],
  currentChapter: null,
  isLoading: false,
  importError: null,

  setBooks: (books) => set({ books }),
  addBook: (book) => set((s) => ({ books: [book, ...s.books] })),
  removeBook: (id) =>
    set((s) => ({
      books: s.books.filter((b) => b.id !== id),
      currentBook: s.currentBook?.id === id ? null : s.currentBook,
    })),
  setCurrentBook: (book) => set({ currentBook: book, chapters: [], currentChapter: null }),
  setChapters: (chapters) => set({ chapters }),
  setCurrentChapter: (chapter) => set({ currentChapter: chapter }),
  setIsLoading: (loading) => set({ isLoading: loading }),
  setImportError: (message) => set({ importError: message }),
}));
