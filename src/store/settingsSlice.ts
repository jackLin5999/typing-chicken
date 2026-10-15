import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { UserSettings, Theme, FontFamily, FontSize } from "@/types/settings";

/**
 * Settings that survive a restart, stored in the SQLite `settings` table
 * (same database file as the bookshelf).
 *
 * Adding a field to `UserSettings` means adding it here too — anything left
 * out simply isn't remembered.
 */
const PERSISTED_KEYS = [
  "theme",
  "fontFamily",
  "fontSize",
  "lineHeight",
  "showLiveStats",
  "showPinyin",
  "skipPunctuation",
  "convertToSimplified",
  "showKeyboardHint",
] as const satisfies readonly (keyof UserSettings)[];

interface SettingsState extends UserSettings {
  setTheme: (theme: Theme) => void;
  setFontFamily: (family: FontFamily) => void;
  setFontSize: (size: FontSize) => void;
  setLineHeight: (lh: number) => void;
  setShowPinyin: (show: boolean) => void;
  setShowLiveStats: (show: boolean) => void;
  setSkipPunctuation: (skip: boolean) => void;
  setConvertToSimplified: (convert: boolean) => void;
  setShowKeyboardHint: (show: boolean) => void;
  loadFromDisk: (settings: Partial<UserSettings>) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  theme: "light",
  fontFamily: "serif",
  fontSize: "base",
  lineHeight: 1.75,
  showLiveStats: true,
  showPinyin: true,
  // 默认要打标点 —— 这是「练习打字」，跳过标点是可选的省事模式
  skipPunctuation: false,
  // 书库里的中文书几乎全是繁体，默认转成简体 —— 大陆用户拿来练打字才有意义
  convertToSimplified: true,
  // 阅读时默认显示键盘指法提示：这是唯一教「用哪根手指」的地方，藏起来没人发现
  showKeyboardHint: true,

  // 每个 setter 都顺手写回数据库。存不上不影响使用（只记日志），
  // 所以不用 await，也不回滚内存里的值。
  setTheme: (theme) => {
    set({ theme });
    persistSetting("theme", theme);
  },
  setFontFamily: (fontFamily) => {
    set({ fontFamily });
    persistSetting("fontFamily", fontFamily);
  },
  setFontSize: (fontSize) => {
    set({ fontSize });
    persistSetting("fontSize", fontSize);
  },
  setLineHeight: (lineHeight) => {
    set({ lineHeight });
    persistSetting("lineHeight", lineHeight);
  },
  setShowPinyin: (showPinyin) => {
    set({ showPinyin });
    persistSetting("showPinyin", showPinyin);
  },
  setShowLiveStats: (showLiveStats) => {
    set({ showLiveStats });
    persistSetting("showLiveStats", showLiveStats);
  },
  setSkipPunctuation: (skipPunctuation) => {
    set({ skipPunctuation });
    persistSetting("skipPunctuation", skipPunctuation);
  },
  setConvertToSimplified: (convertToSimplified) => {
    set({ convertToSimplified });
    persistSetting("convertToSimplified", convertToSimplified);
  },
  setShowKeyboardHint: (showKeyboardHint) => {
    set({ showKeyboardHint });
    persistSetting("showKeyboardHint", showKeyboardHint);
  },

  // 直接 set，不走上面的 setter —— 否则刚从库里读出来又会立刻写回去
  loadFromDisk: (settings) => set({ ...settings }),
}));

/** 把一项设置写回 SQLite。值是 JSON 编码的，Rust 侧不关心具体类型。 */
function persistSetting<K extends keyof UserSettings>(
  key: K,
  value: UserSettings[K],
): void {
  invoke("set_setting", { key, value: JSON.stringify(value) }).catch((err) =>
    console.error("保存设置失败:", key, err),
  );
}

/**
 * 启动时把上次保存的设置读回来。
 *
 * 库里没有的项一律保持默认值，所以第一次运行、或者以后新增了设置项，
 * 都不会因为「读不到」而变成 undefined。
 */
export async function loadPersistedSettings(): Promise<void> {
  try {
    const stored = await invoke<Record<string, string>>("get_settings");
    const loaded: Record<string, unknown> = {};

    for (const key of PERSISTED_KEYS) {
      const encoded = stored[key];
      if (encoded === undefined) continue;
      try {
        loaded[key] = JSON.parse(encoded);
      } catch {
        // 存坏了就当作没存过，继续用默认值
        console.warn("设置项解析失败，用默认值:", key, encoded);
      }
    }

    useSettingsStore.getState().loadFromDisk(loaded as Partial<UserSettings>);
  } catch (err) {
    // 读不到设置只是回到默认值，不该拦住应用启动
    console.error("读取设置失败，使用默认值:", err);
  }
}
