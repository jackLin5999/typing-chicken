import { useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * Custom frameless titlebar with window controls.
 * NOTE: Buttons use onMouseDown instead of onClick because the drag region
 * can intercept click events in Tauri v2 frameless windows.
 */
export function Titlebar() {
  const [isMaximized, setIsMaximized] = useState(false);
  const appWindow = getCurrentWindow();

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
          aria-label="Minimize"
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
          aria-label={isMaximized ? "Restore" : "Maximize"}
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
          aria-label="Close"
        >
          <X size={14} />
        </button>
      </div>
    </header>
  );
}
