import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Minus, Square, Copy, X, BookMarked, Keyboard, Library, BarChart3 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Custom frameless titlebar with window controls.
 * NOTE: Buttons use onMouseDown instead of onClick because the drag region
 * can intercept click events in Tauri v2 frameless windows.
 */
export function Titlebar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const appWindow = getCurrentWindow();
  const navigate = useNavigate();
  const { pathname } = useLocation();

  /** Left-hand page nav. 课程排在书架前面 —— 它是新用户的第一步。 */
  const navItems = [
    { to: "/lessons", label: "课程", Icon: Keyboard },
    { to: "/", label: "书架", Icon: Library },
    { to: "/browse", label: "书库", Icon: BookMarked },
    { to: "/stats", label: "统计", Icon: BarChart3 },
  ];

  const handleMinimize = async () => {
    try {
      await appWindow.minimize();
    } catch (e) {
      console.error("minimize failed:", e);
    }
  };

  const handleMaximize = async () => {
    try {
      await appWindow.toggleMaximize();
      setIsMaximized(await appWindow.isMaximized());
    } catch (e) {
      console.error("maximize failed:", e);
    }
  };

  const handleClose = async () => {
    try {
      await appWindow.close();
    } catch (e) {
      console.error("close failed:", e);
    }
  };

  return (
    <header
      className="
        fixed top-0 left-0 right-0 z-50
        flex items-center justify-between
        h-10 px-2
        bg-paper/70
        backdrop-blur-titlebar
        border-b border-gray-200/50 dark:border-gray-700/30
        select-none
      "
      style={{ pointerEvents: "auto" }}
      data-tauri-drag-region
      onMouseDown={(e) => {
        if (e.button === 0) {
          appWindow.startDragging().catch(console.error);
        }
      }}
    >
      {/* Left: App name + branding */}
      <div
        className="flex-1 flex items-center gap-2.5 pl-3 h-full"
      >
        {/* Logo mark */}
        <span className="text-base leading-none select-none">🐔</span>
        {/* Brand text */}
        <span className="text-[13px] font-bold tracking-[0.05em] text-rose-500 select-none">
          打字雞
        </span>

        {/* Page nav — onMouseDown, not onClick: the drag region eats clicks
            in frameless windows. stopPropagation keeps the window still. */}
        <nav className="flex items-center gap-1 ml-3 h-full">
          {navItems.map(({ to, label, Icon }) => {
            const isActive = pathname === to;
            return (
              <button
                key={to}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  navigate(to);
                }}
                className={`
                  flex items-center gap-1.5 h-7 px-2.5 rounded-md
                  text-xs font-medium transition-colors cursor-pointer
                  ${isActive
                    ? "text-accent bg-accent/10"
                    : "text-muted hover:text-ink hover:bg-surface-hover"}
                `}
                style={{ pointerEvents: "auto", cursor: "pointer" }}
                aria-label={label}
                aria-current={isActive ? "page" : undefined}
              >
                <Icon size={13} />
                {label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Right: Window controls — use onMouseDown to beat the drag region */}
      <div className="flex items-center shrink-0 z-10" data-tauri-drag-region="false">
        <button
          onMouseDown={(e) => { e.stopPropagation(); handleMinimize(); }}
          className="
            w-10 h-8 flex items-center justify-center
            text-muted
            hover:bg-surface-hover
            rounded transition-colors cursor-pointer
          "
          style={{ pointerEvents: "auto", cursor: "pointer" }}
          aria-label="最小化"
          title="最小化"
        >
          <Minus size={14} />
        </button>

        <button
          onMouseDown={(e) => { e.stopPropagation(); handleMaximize(); }}
          className="
            w-10 h-8 flex items-center justify-center
            text-muted
            hover:bg-surface-hover
            rounded transition-colors cursor-pointer
          "
          style={{ pointerEvents: "auto", cursor: "pointer" }}
          aria-label={isMaximized ? "还原" : "最大化"}
          title={isMaximized ? "还原" : "最大化"}
        >
          {isMaximized ? <Copy size={12} /> : <Square size={12} />}
        </button>

        <button
          onMouseDown={(e) => { e.stopPropagation(); handleClose(); }}
          className="
            w-10 h-8 flex items-center justify-center
            text-muted
            hover:bg-red-500 hover:text-white
            rounded transition-colors cursor-pointer
          "
          style={{ pointerEvents: "auto", cursor: "pointer" }}
          aria-label="关闭"
          title="关闭"
        >
          <X size={14} />
        </button>
      </div>
    </header>
  );
}
