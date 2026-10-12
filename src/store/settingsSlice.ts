import { create } from "zustand";
import type { UserSettings, Theme, FontFamily, FontSize } from "@/types/settings";

interface SettingsState extends UserSettings {
  setTheme: (theme: Theme) => void;
  setFontFamily: (font: FontFamily) => void;
  setFontSize: (size: FontSize) => void;
  setLineHeight: (lh: number) => void;
  setShowPinyin: (show: boolean) => void;
  setShowLiveStats: (show: boolean) => void;
  loadFromDisk: (settings: Partial<UserSettings>) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  theme: "light",
  fontFamily: "serif",
  fontSize: "base",
  lineHeight: 1.75,
  showLiveStats: true,
  showPinyin: true,

  setTheme: (theme) => {
    set({ theme });
    persistTheme(theme);
  },
  setFontFamily: (fontFamily) => set({ fontFamily }),
  setFontSize: (fontSize) => set({ fontSize }),
  setLineHeight: (lineHeight) => set({ lineHeight }),
  setShowPinyin: (showPinyin) => set({ showPinyin }),
  setShowLiveStats: (showLiveStats) => set({ showLiveStats }),
  loadFromDisk: (settings) => set(settings),
}));

function persistTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.remove("light", "sepia", "dark");
  root.classList.add(theme);
  if (theme === "dark") {
    root.classList.add("dark"); // Tailwind dark mode
  } else {
    root.classList.remove("dark");
  }
}
