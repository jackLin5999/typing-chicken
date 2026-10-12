import { useMemo, useState, useEffect, useLayoutEffect, useRef, useCallback, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTypingStore, useSettingsStore, useBookStore } from "@/store";
import { segmentText, getRangePinyin, clearPinyinCache, detectHeadingRanges } from "@/lib/utils";
import { Cursor } from "./Cursor";

const fontSizeMap = {
  sm: "text-reader-sm",
  base: "text-reader-base",
  lg: "text-reader-lg",
  xl: "text-reader-xl",
};

const fontFamilyMap = {
  serif: "font-serif",
  sans: "font-sans",
  mono: "font-mono",
};

interface TextDisplayProps {
  inputRef: React.RefCallback<HTMLTextAreaElement>;
  onInput: () => void;
  onCompositionStart: () => void;
  onCompositionEnd: () => void;
  onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}

// ── Memoized character span ──────────────────────────────────────────────────

interface CharSpanProps {
  char: string;
  index: number;
  state: "untyped" | "correct" | "incorrect" | "current";
  charPinyin: string | undefined;
  isHeading: boolean;
}

const CharSpan = memo(function CharSpan({
  char,
  index,
  state,
  charPinyin,
  isHeading,
}: CharSpanProps) {
  if (char === "\n") {
    return (
      <span>
        <br />
        {state === "current" && <Cursor />}
      </span>
    );
  }

  return (
    <span
      data-char-index={index}
      className={`inline-block relative align-baseline
        ${isHeading ? "font-bold text-[1.08em] tracking-[0.04em]" : ""}
        ${state === "correct" ? "text-ink" : ""}
        ${state === "incorrect" ? "text-error" : ""}
        ${state === "untyped" ? "text-muted" : ""}
        ${state === "current" ? "bg-accent/30 text-ink rounded-sm ring-1 ring-accent/25" : ""}
      `}
    >
      {charPinyin && (
        <span
          className="
            absolute left-1/2 -translate-x-1/2
            bottom-full mb-0
            text-[0.46em] font-sans font-medium
            text-pinyin
            whitespace-nowrap
            pointer-events-none
            leading-none
            tracking-normal
          "
          aria-hidden="true"
        >
          {charPinyin}
        </span>
      )}
      {char === " " ? " " : char}
      {state === "current" && <Cursor />}
    </span>
  );
});

// ── Image placeholder ────────────────────────────────────────────────────────

const IMAGE_MARKER_RE = /\[IMG:([^\]]+)\]/g;

/** Renders an extracted EPUB image loaded via the get_image_data Tauri command. */
function ImageBlock({ filename, bookId }: { filename: string; bookId: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_image_data", { bookId, filename })
      .then((dataUrl) => {
        if (!cancelled) setSrc(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => { cancelled = true; };
  }, [bookId, filename]);

  if (error) {
    return (
      <div className="block my-4 p-4 border border-dashed border-muted rounded-lg text-center">
        <span className="text-xs text-muted">[图片: {filename}]</span>
      </div>
    );
  }

  if (!src) {
    return (
      <div className="block my-4 py-8 bg-surface-alt/50 rounded-lg text-center">
        <span className="text-xs text-muted animate-pulse">加载图片…</span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt=""
      className="block max-w-full max-h-[60vh] mx-auto my-4 rounded-lg shadow-sm bg-white dark:bg-gray-900"
      loading="lazy"
    />
  );
}

// ── Constants ────────────────────────────────────────────────────────────────

const LOOKAHEAD = 6;

// ── TextDisplay ──────────────────────────────────────────────────────────────

/**
 * Renders the book text with per-character visual feedback + a hidden
 * `<textarea>` that captures keyboard input including IME composition.
 *
 * Characters are rendered via memoized `<CharSpan>` so that only the
 * characters whose state actually changed (cursor move, error) touch the DOM.
 * No CSS transitions on individual spans — 50K transition listeners would
 * overwhelm the GPU compositor and crash WebView2.
 */
export function TextDisplay({
  inputRef,
  onInput,
  onCompositionStart,
  onCompositionEnd,
  onBlur,
  onKeyDown,
}: TextDisplayProps) {
  const targetText = useTypingStore((s) => s.targetText);
  const cursorIndex = useTypingStore((s) => s.cursorIndex);
  const incorrectIndices = useTypingStore((s) => s.incorrectIndices);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);
  const lineHeight = useSettingsStore((s) => s.lineHeight);
  const showPinyin = useSettingsStore((s) => s.showPinyin);

  const chars = useMemo(() => segmentText(targetText), [targetText]);

  const incorrectSet = useMemo(
    () => new Set(incorrectIndices),
    [incorrectIndices],
  );

  // Pre-compute character states in one pass so CharSpan can be pure-memo.
  const charStates = useMemo(() => {
    const states: CharSpanProps["state"][] = new Array(chars.length);
    for (let i = 0; i < chars.length; i++) {
      if (i < cursorIndex) {
        states[i] = incorrectSet.has(i) ? "incorrect" : "correct";
      } else if (i === cursorIndex) {
        states[i] = "current";
      } else {
        states[i] = "untyped";
      }
    }
    return states;
  }, [chars.length, cursorIndex, incorrectSet]);

  // Detect heading lines → bold + slightly larger font
  const headingChars = useMemo(() => {
    const ranges = detectHeadingRanges(targetText);
    const set = new Set<number>();
    for (const [start, end] of ranges) {
      for (let i = start; i < end; i++) set.add(i);
    }
    return set;
  }, [targetText]);

  // Detect [IMG:filename] markers → render as actual images
  const bookId = useBookStore((s) => s.currentBook?.id ?? "");

  const imageMarkers = useMemo(() => {
    const map = new Map<number, { filename: string; length: number }>();
    IMAGE_MARKER_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMAGE_MARKER_RE.exec(targetText)) !== null) {
      map.set(match.index, {
        filename: match[1],
        length: match[0].length,
      });
    }
    return map;
  }, [targetText]);

  // Pre-scan: which indices are "consumed" by image markers (skip in render)
  const imageConsumed = useMemo(() => {
    const set = new Set<number>();
    for (const [start, { length }] of imageMarkers) {
      for (let i = start; i < start + length; i++) {
        set.add(i);
      }
    }
    return set;
  }, [imageMarkers]);

  // Pinyin
  const [pinyinMap, setPinyinMap] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    clearPinyinCache();
    setPinyinMap(new Map());
  }, [targetText]);

  useEffect(() => {
    if (!showPinyin || targetText.length === 0) {
      setPinyinMap(new Map());
      return;
    }
    const start = Math.max(0, cursorIndex);
    const end = Math.min(targetText.length, cursorIndex + LOOKAHEAD);
    if (start >= end) {
      setPinyinMap(new Map());
      return;
    }
    let cancelled = false;
    getRangePinyin(targetText, start, end).then((r) => {
      if (!cancelled) setPinyinMap(r);
    });
    return () => {
      cancelled = true;
    };
  }, [targetText, cursorIndex, showPinyin]);

  const effectiveLineHeight = showPinyin
    ? Math.max(lineHeight, 2.0)
    : lineHeight;

  // ── Position the hidden textarea near the current cursor ────────────────────
  // The IME candidate window anchors to the focused textarea. Keeping the
  // textarea at the current character (instead of top-left) makes the pinyin
  // candidate box appear right under the character being typed.
  const textareaEl = useRef<HTMLTextAreaElement | null>(null);
  const handleTextareaRef = useCallback(
    (el: HTMLTextAreaElement | null) => {
      textareaEl.current = el;
      inputRef(el);
    },
    [inputRef],
  );

  // ── Position the hidden textarea near the current cursor ────────────────────
  // The IME candidate window anchors to the focused textarea. We set its
  // position synchronously in a layout effect (before the browser paints) and
  // write directly to the DOM node — no React state / extra re-render — so the
  // textarea never flickers between an old and new position while the IME is
  // composing, which is what made the candidate box blink.
  useLayoutEffect(() => {
    const el = textareaEl.current;
    if (!el) return;
    const charEl = document.querySelector<HTMLElement>(
      `[data-char-index="${cursorIndex}"]`,
    );
    if (charEl) {
      const rect = charEl.getBoundingClientRect();
      el.style.left = `${rect.left}px`;
      el.style.top = `${rect.bottom + 2}px`;
    }
  }, [cursorIndex, targetText]);

  return (
    <div
      className={`
        max-w-reader mx-auto px-6 py-12
        ${fontSizeMap[fontSize]}
        ${fontFamilyMap[fontFamily]}
        select-none
      `}
      style={{
        lineHeight: effectiveLineHeight,
        letterSpacing: showPinyin ? "0.28em" : undefined,
      }}
    >
      {/* Hidden textarea — captures all keyboard input including IME */}
      <textarea
        ref={handleTextareaRef}
        onInput={onInput}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="
          fixed
          w-20 h-[1.2em]
          p-0 m-0
          resize-none
          border-0 outline-none
          bg-transparent
          text-transparent
          overflow-hidden
          whitespace-nowrap
        "
        style={{
          caretColor: "transparent",
        }}
      />

      <div className="relative">
        {(() => {
          const elements: React.ReactNode[] = [];
          for (let i = 0; i < chars.length; ) {
            // ── Image marker → render ImageBlock, skip marker chars ──
            const imgInfo = imageMarkers.get(i);
            if (imgInfo) {
              if (bookId) {
                elements.push(
                  <ImageBlock
                    key={`img-${i}`}
                    filename={imgInfo.filename}
                    bookId={bookId}
                  />,
                );
              }
              i += imgInfo.length;
              continue;
            }

            // ── Skip chars already consumed by an image marker ──
            if (imageConsumed.has(i)) {
              i++;
              continue;
            }

            // ── Regular character ──
            const charPinyin =
              showPinyin && i >= cursorIndex && i < cursorIndex + LOOKAHEAD
                ? pinyinMap.get(i)
                : undefined;

            elements.push(
              <CharSpan
                key={i}
                char={chars[i]}
                index={i}
                state={charStates[i]}
                charPinyin={charPinyin}
                isHeading={headingChars.has(i)}
              />,
            );
            i++;
          }

          // End-of-text marker
          if (cursorIndex >= chars.length && chars.length > 0) {
            elements.push(
              <span key="end-marker" className="text-accent animate-pulse">
                ▌
              </span>,
            );
          }

          return elements;
        })()}
      </div>
    </div>
  );
}
