import { useEffect } from "react";
import { useSettingsStore } from "@/store";

/**
 * Apply the active theme to the document root on mount and on change.
 */
export function useTheme() {
  const theme = useSettingsStore((s) => s.theme);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove("light", "sepia", "dark");

    switch (theme) {
      case "sepia":
        root.classList.add("sepia");
        root.classList.remove("dark");
        break;
      case "dark":
        root.classList.add("dark");
        break;
      case "light":
      default:
        root.classList.remove("dark");
        break;
    }
  }, [theme]);
}
