import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  /*
   * `sepia` is our THEME class on <html>, but Tailwind also ships a `sepia`
   * FILTER utility (`filter: sepia(100%)`). The content scanner matches on
   * raw text, so it finds the string "sepia" in our theme key and generates
   * that utility — and since the theme class has the same name, the whole
   * document silently gets `filter: sepia(100%)` stacked on top of the sepia
   * palette. That washes every colour toward cream, removes all blue (the
   * current-character highlight and pinyin included) and drops text/background
   * contrast to ~1.03:1. Block the utility so it can never be generated.
   */
  blocklist: ["sepia", "sepia-0"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        // Theme-driven via CSS custom properties (see index.css).
        // Opacity modifiers work because values are space-separated RGB channels.
        paper: {
          light: "#FBF9F5",
          sepia: "#F4ECD8",
          dark: "#1E1E2E",
          DEFAULT: "rgb(var(--color-paper) / <alpha-value>)",
        },
        ink: {
          light: "#1A1A1A",
          sepia: "#5B4636",
          dark: "#D4D4D4",
          DEFAULT: "rgb(var(--color-ink) / <alpha-value>)",
        },
        muted: {
          light: "#8E8E93",
          sepia: "#756551",
          dark: "#6E6E7A",
          DEFAULT: "rgb(var(--color-muted) / <alpha-value>)",
        },
        surface: {
          DEFAULT: "rgb(var(--color-surface) / <alpha-value>)",
          alt: "rgb(var(--color-surface-alt) / <alpha-value>)",
          hover: "rgb(var(--color-surface-hover) / <alpha-value>)",
        },
        pinyin: {
          DEFAULT: "rgb(var(--color-pinyin) / <alpha-value>)",
        },
        error: {
          DEFAULT: "rgb(var(--color-error) / <alpha-value>)",
        },
        accent: {
          DEFAULT: "#3B82F6", // Correct typing
          error: "#EF4444", // Typo indicator
          correct: "#10B981", // Completed text
        },
      },
      fontFamily: {
        serif: ["Crimson Pro", "Georgia", "Times New Roman", "serif"],
        sans: ["Inter", "SF Pro Display", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "SF Mono", "Fira Code", "monospace"],
      },
      fontSize: {
        "reader-sm": ["0.938rem", { lineHeight: "1.8" }],
        "reader-base": ["1.125rem", { lineHeight: "1.75" }],
        "reader-lg": ["1.313rem", { lineHeight: "1.7" }],
        "reader-xl": ["1.5rem", { lineHeight: "1.65" }],
      },
      spacing: {
        "reader": "42rem", // Max reading column width (≈672px)
      },
      backdropBlur: {
        titlebar: "20px",
      },
      animation: {
        "cursor-blink": "blink 1s step-end infinite",
        "fade-in": "fadeIn 0.3s ease-out",
        "slide-up": "slideUp 0.4s ease-out",
      },
      keyframes: {
        blink: {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0" },
        },
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(12px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [],
} satisfies Config;
