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
}
