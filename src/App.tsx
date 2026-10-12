import { HashRouter, Routes, Route } from "react-router-dom";
import { Layout } from "@/components/layout/Layout";
import { BookshelfPage } from "@/components/bookshelf/BookshelfPage";
import { ReaderPage } from "@/components/reader/ReaderPage";
import { useTheme } from "@/hooks/useTheme";

/**
 * Root application component.
 * Sets up routing and applies the active theme on mount.
 */
export function App() {
  useTheme();

  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<BookshelfPage />} />
          <Route path="/read/:bookId" element={<ReaderPage />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
