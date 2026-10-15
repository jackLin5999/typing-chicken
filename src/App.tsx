import { useEffect } from "react";
import { HashRouter, Routes, Route } from "react-router-dom";
import { Layout } from "@/components/layout/Layout";
import { BookshelfPage } from "@/components/bookshelf/BookshelfPage";
import { BrowsePage } from "@/components/browse/BrowsePage";
import { StatsPage } from "@/components/stats/StatsPage";
import { LessonsPage } from "@/components/lessons/LessonsPage";
import { LessonRunner } from "@/components/lessons/LessonRunner";
import { ReaderPage } from "@/components/reader/ReaderPage";
import { useTheme } from "@/hooks/useTheme";
import { loadPersistedSettings } from "@/store/settingsSlice";

/**
 * Root application component.
 * Sets up routing and applies the active theme on mount.
 */
export function App() {
  useTheme();

  // 把上次保存的设置读回来（主题之外还有字号、拼音开关、转简体等）。
  // 读不到就用默认值，不拦住渲染。
  useEffect(() => {
    void loadPersistedSettings();
  }, []);

  return (
    <HashRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<BookshelfPage />} />
          <Route path="/browse" element={<BrowsePage />} />
          <Route path="/stats" element={<StatsPage />} />
          <Route path="/lessons" element={<LessonsPage />} />
          <Route path="/lessons/:lessonId" element={<LessonRunner />} />
          <Route path="/read/:bookId" element={<ReaderPage />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
