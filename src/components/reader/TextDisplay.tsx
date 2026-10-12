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

/**
 * Windowing.
 *
 * Only characters within this many indices of the cursor are rendered as
 * individual `<span>` elements. Everything outside the window is collapsed
 * into a single plain text node instead, so the mounted node count stays
 * ~constant (~BACK + FORWARD) no matter how long the chapter is.
 *
 * Rendering every character of a whole book as its own span overflows
 * WebView2's renderer and crashes the page (STATUS_BREAKPOINT). That is
 * exactly what happens for a TXT/PDF imported as one "Full Text" chapter,
 * or an EPUB without a usable TOC — the parser has no maximum chapter
 * length, so `targetText` can be the entire book.
 */
const WINDOW_BACK = 1500;
const WINDOW_FORWARD = 1500;

/**
 * Quantise the window start to a multiple of this many characters, so the
 * collapsed prefix text node changes — and therefore re-lays out — only once
 * every WINDOW_STEP keystrokes rather than on every single one.
 */
const WINDOW_STEP = 256;

/**
 * Auto-scroll. Fractions of the reading column's visible height.
 *
 * The cursor is allowed to drift freely inside the safe band; only when it
 * pushes past an edge do we re-anchor it to CARET_ANCHOR. Scrolling on every
 * keystroke would twitch the column constantly, and re-anchoring every line
 * would creep — this re-anchors once every ~6 lines by roughly 3 lines.
 */
const CARET_BAND_TOP = 0.35;
const CARET_BAND_BOTTOM = 0.65;
const CARET_ANCHOR = 0.5;

/**
 * Render a collapsed (non-interactive) text run: newlines become `<br/>` so
 * the surrounding flow matches the per-character rendering.
 */
function renderPlainRun(text: string, keyBase: string): React.ReactNode {
  const lines = text.split("\n");
  if (lines.length === 1) return text;
  const nodes: React.ReactNode[] = [];
  lines.forEach((line, idx) => {
    if (idx > 0) nodes.push(<br key={`${keyBase}-br-${idx}`} />);
    if (line) nodes.push(line);
  });
  return nodes;
}

// ── TextDisplay ──────────────────────────────────────────────────────────────

/**
 * Renders the book text with per-character visual feedback + a hidden
 * `<textarea>` that captures keyboard input including IME composition.
 *
 * Only the characters inside a window around the cursor are rendered via
 * memoized `<CharSpan>`; the rest of the chapter is one plain text node. This
 * keeps the DOM bounded regardless of chapter length (see WINDOW_BACK).
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

  // The mount window: characters in [windowStart, windowEnd) get their own
  // <CharSpan>. It is always wide enough to contain the cursor, so the IME
  // textarea anchor (querySelector('[data-char-index=...]')) always resolves.
  const windowStart = Math.max(
    0,
    Math.floor((cursorIndex - WINDOW_BACK) / WINDOW_STEP) * WINDOW_STEP,
  );
  const windowEnd = Math.min(
    chars.length,
    windowStart + WINDOW_BACK + WINDOW_FORWARD,
  );

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

  // ── Follow the cursor: scroll the column, then anchor the IME textarea ──────
  //
  // Two jobs, one DOM lookup, in this order on purpose:
  //   1. Scroll the reading column if the cursor has left the safe band.
  //   2. Pin the hidden textarea under the current character so the IME
  //      candidate window opens there instead of at the top-left corner.
  //
  // Scrolling MUST come first: getBoundingClientRect() is viewport-relative,
  // so the textarea coordinates read before a scroll are stale by exactly the
  // amount we just scrolled.
  //
  // Everything is written straight to the DOM in a layout effect (before paint,
  // no extra render) so the textarea never flickers between an old and a new
  // position mid-composition — that flicker is what made the candidate box blink.
  useLayoutEffect(() => {
    const charEl = document.querySelector<HTMLElement>(
      `[data-char-index="${cursorIndex}"]`,
    );
    if (!charEl) return;

    // ── 1. Keep the cursor in view ──
    const scroller = charEl.closest<HTMLElement>("[data-scroll-container]");
    if (scroller) {
      const before = charEl.getBoundingClientRect();
      const box = scroller.getBoundingClientRect();
      const centre = before.top + before.height / 2;
      const upper = box.top + box.height * CARET_BAND_TOP;
      const lower = box.top + box.height * CARET_BAND_BOTTOM;

      if (centre < upper || centre > lower) {
        const anchorY = box.top + box.height * CARET_ANCHOR;
        // Instant, not smooth: a smooth scroll is still animating when the
        // next keystroke reads the rect, so the offsets would compound.
        scroller.scrollTop += centre - anchorY;
      }
    }

    // ── 2. Pin the IME textarea (post-scroll coordinates) ──
    const el = textareaEl.current;
    if (!el) return;
    const rect = charEl.getBoundingClientRect();
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.bottom + 2}px`;
  }, [cursorIndex, targetText]);

  return (
    <div
      className={`
        max-w-reader mx-auto px-6 py-12
        ${fontSizeMap[fontSize]}
        ${fontFamilyMap[fontFamily]}
        select-none
        break-all
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

            // ── Inside the window → one interactive <CharSpan> per character ──
            if (i >= windowStart && i < windowEnd) {
              let j = i;
              while (j < windowEnd && !imageMarkers.has(j)) j++;
              for (let k = i; k < j; k++) {
                const state: CharSpanProps["state"] =
                  k < cursorIndex
                    ? incorrectSet.has(k)
                      ? "incorrect"
                      : "correct"
                    : k === cursorIndex
                      ? "current"
                      : "untyped";
                const charPinyin =
                  showPinyin && k >= cursorIndex && k < cursorIndex + LOOKAHEAD
                    ? pinyinMap.get(k)
                    : undefined;
                elements.push(
                  <CharSpan
                    key={k}
                    char={chars[k]}
                    index={k}
                    state={state}
                    charPinyin={charPinyin}
                    isHeading={headingChars.has(k)}
                  />,
                );
              }
              i = j;
              continue;
            }

            // ── Outside the window → collapse into a single plain text node ──
            // Runs are split at heading boundaries so headings keep their bold
            // styling even when they are far from the cursor.
            const runIsHeading = headingChars.has(i);
            let j = i;
            while (
              j < chars.length &&
              !imageMarkers.has(j) &&
              (j < windowStart || j >= windowEnd) &&
              headingChars.has(j) === runIsHeading
            ) {
              j++;
            }
            const runClass = [
              i < cursorIndex ? "text-ink" : "text-muted",
              runIsHeading ? "font-bold text-[1.08em] tracking-[0.04em]" : "",
            ]
              .filter(Boolean)
              .join(" ");
            elements.push(
              <span key={`run-${i}`} className={runClass}>
                {renderPlainRun(targetText.slice(i, j), `run-${i}`)}
              </span>,
            );
            i = j;
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
