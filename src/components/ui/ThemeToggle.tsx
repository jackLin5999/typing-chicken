import { Sun, Moon, BookOpen } from "lucide-react";
import { useSettingsStore } from "@/store";
import type { Theme } from "@/types/settings";

const options: { key: Theme; icon: typeof Sun; label: string }[] = [
  { key: "light", icon: Sun, label: "Light" },
  { key: "sepia", icon: BookOpen, label: "Sepia" },
  { key: "dark", icon: Moon, label: "Dark" },
];

/**
 * A compact 3-way theme toggle: Light → Sepia → Dark.
 */
export function ThemeToggle() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);

  return (
    <div className="flex items-center rounded-lg bg-surface-alt p-0.5 gap-0.5">
      {options.map((opt) => {
        const isActive = theme === opt.key;
        return (
          <button
            key={opt.key}
            onClick={() => setTheme(opt.key)}
            className={`
              p-1.5 rounded-md transition-colors
              ${isActive
                ? "bg-surface text-accent shadow-sm"
                : "text-muted hover:text-ink"
              }
            `}
            aria-label={opt.label}
            title={opt.label}
          >
            <opt.icon size={15} />
          </button>
        );
      })}
    </div>
  );
}
