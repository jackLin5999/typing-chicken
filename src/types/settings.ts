export type Theme = "light" | "sepia" | "dark";
export type FontFamily = "serif" | "sans" | "mono";
export type FontSize = "sm" | "base" | "lg" | "xl";

export interface UserSettings {
  theme: Theme;
  fontFamily: FontFamily;
  fontSize: FontSize;
  lineHeight: number; // multiplier, e.g. 1.75
  showLiveStats: boolean;
  showPinyin: boolean;
  /**
   * Skip punctuation instead of asking the user to type it — the cursor
   * travels over ，。！？… on its own. For practising prose where the
   * punctuation is just noise between the characters that matter.
   */
  skipPunctuation: boolean;
  /**
   * Convert books downloaded from 书库 from traditional to simplified Chinese.
   * Project Gutenberg's Chinese collection is essentially all traditional
   * (measured: ~38 traditional characters per simplified one), so this
   * defaults to on. Local file imports are never converted.
   */
  convertToSimplified: boolean;
  /**
   * 阅读练习时在下方显示键盘指法提示。
   * 默认开 —— 它是这个软件唯一教「用哪根手指」的地方，藏起来就没人发现了；
   * 会盲打的人关一次，设置会记住。
   */
  showKeyboardHint: boolean;
}
