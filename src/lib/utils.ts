/**
 * Format seconds into a MM:SS string.
 */
export function formatTime(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Segment text into an array of characters for rendering, preserving newlines.
 */
export function segmentText(text: string): string[] {
  return text.split("");
}

/**
 * Return the CSS class for a given character state.
 */
export function charStateClass(state: "untyped" | "correct" | "incorrect" | "current"): string {
  switch (state) {
    case "correct":
      return "text-accent-correct";
    case "incorrect":
      return "text-accent-error bg-red-500/10 rounded-sm";
    case "current":
      return "text-ink border-l-2 border-accent animate-cursor-blink";
    case "untyped":
    default:
      return "text-muted";
  }
}

/**
 * Truncate a string with ellipsis.
 */
export function truncate(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 1) + "…";
}

/**
 * Return a human-readable file type label.
 */
export function fileTypeLabel(ft: string): string {
  switch (ft) {
    case "epub":
      return "EPUB";
    case "pdf":
      return "PDF";
    case "txt":
      return "TXT";
    default:
      return ft.toUpperCase();
  }
}

/**
 * Lazy-load and cache the raw `pinyin` function from pinyin-pro.
 * Returns the library's pinyin() directly — callers can decide format options.
 */
let pinyinRaw: any = null;
let pinyinRawLoadPromise: Promise<any> | null = null;

async function ensurePinyinRaw(): Promise<any> {
  if (pinyinRaw) return pinyinRaw;
  // Prevent concurrent duplicate imports
  if (pinyinRawLoadPromise) return pinyinRawLoadPromise;

  pinyinRawLoadPromise = (async () => {
    try {
      const { pinyin } = await import("pinyin-pro");
      pinyinRaw = pinyin;
      return pinyinRaw;
    } catch (e) {
      console.warn("[pinyin] Failed to load pinyin-pro:", e);
      pinyinRaw = () => "";
      return pinyinRaw;
    } finally {
      pinyinRawLoadPromise = null;
    }
  })();

  return pinyinRawLoadPromise;
}

/**
 * Get pinyin for a Chinese character string.
 * Returns a space-joined string of pinyin, one per character.
 */
let pinyinFn: ((text: string) => string) | null = null;

async function ensurePinyin(): Promise<(text: string) => string> {
  if (pinyinFn) return pinyinFn;

  const raw = await ensurePinyinRaw();
  pinyinFn = (text: string) => {
    try {
      return raw(text, { toneType: "none", type: "array" }).join(" ");
    } catch (e) {
      console.warn("[pinyin] pinyin() threw:", e);
      return "";
    }
  };
  return pinyinFn;
}

/** Cache for computed pinyin strings, keyed by character index. */
const pinyinCache = new Map<number, string>();

/**
 * Get the pinyin for the character at the given index in the text.
 * Results are cached. Returns empty string for non-CJK chars.
 */
export async function getCharPinyin(
  text: string,
  index: number,
): Promise<string> {
  if (index < 0 || index >= text.length) return "";

  const cached = pinyinCache.get(index);
  if (cached !== undefined) return cached;

  const char = text[index];
  // Only convert CJK characters
  if (!/[一-鿿㐀-䶿]/.test(char)) {
    pinyinCache.set(index, "");
    return "";
  }

  try {
    const pinyin = await ensurePinyinRaw();

    // Include context before and after so pinyin-pro can resolve polyphonic
    // (多音字) characters based on surrounding words.
    const CONTEXT = 10;
    const segmentStart = Math.max(0, index - CONTEXT);
    const segmentEnd = Math.min(text.length, index + CONTEXT + 1);
    const segment = text.slice(segmentStart, segmentEnd);

    const pinyinArray: string[] = pinyin(segment, {
      toneType: "none",
      type: "array",
    });

    const offset = index - segmentStart;
    const result = pinyinArray[offset] || "";
    pinyinCache.set(index, result);

    // Cache all CJK chars in the segment — already paid for the call
    for (let i = segmentStart; i < segmentEnd; i++) {
      if (pinyinCache.has(i)) continue;
      const ch = text[i];
      if (/[一-鿿㐀-䶿]/.test(ch)) {
        const off = i - segmentStart;
        const py = pinyinArray[off] || "";
        pinyinCache.set(i, py);
      } else {
        pinyinCache.set(i, "");
      }
    }

    return result;
  } catch (e) {
    console.warn("[pinyin] getCharPinyin failed:", e);
    // Fallback: single character
    const fn = await ensurePinyin();
    const result = fn(char);
    pinyinCache.set(index, result);
    return result;
  }
}

/** Clear the pinyin cache (e.g., when text changes). */
export function clearPinyinCache(): void {
  pinyinCache.clear();
}

/**
 * Batch-fetch pinyin for a range of characters.
 * Returns a Map of index → pinyin (only for CJK characters).
 * Much faster than calling getCharPinyin individually for each char.
 */
export async function getRangePinyin(
  text: string,
  start: number,
  end: number,
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  const clampedStart = Math.max(0, start);
  const clampedEnd = Math.min(text.length, end);

  if (clampedStart >= clampedEnd) return result;

  // Collect chars that need fetching (not in cache, are CJK)
  const toFetch: number[] = [];
  for (let i = clampedStart; i < clampedEnd; i++) {
    const cached = pinyinCache.get(i);
    if (cached !== undefined) {
      if (cached) result.set(i, cached);
      continue;
    }
    const char = text[i];
    if (/[一-鿿㐀-䶿]/.test(char)) {
      toFetch.push(i);
    } else {
      pinyinCache.set(i, "");
    }
  }

  if (toFetch.length === 0) return result;

  try {
    const pinyin = await ensurePinyinRaw();

    // Build a context-aware segment. Include characters BEFORE the range
    // so pinyin-pro can use word-boundary context to correctly resolve
    // polyphonic (多音字) pronunciations, e.g. 长→chang vs zhang.
    const CONTEXT_BEFORE = 20;
    const segmentStart = Math.max(0, clampedStart - CONTEXT_BEFORE);
    const segment = text.slice(segmentStart, clampedEnd);

    // Get pinyin for the entire segment at once as an array.
    // pinyin-pro performs word segmentation internally when given
    // multi-character input, resolving polyphonic characters correctly.
    const pinyinArray: string[] = pinyin(segment, {
      toneType: "none",
      type: "array",
    });

    // Map array results back to original character indices
    for (const idx of toFetch) {
      const offsetInSegment = idx - segmentStart;
      const py = pinyinArray[offsetInSegment] || "";
      pinyinCache.set(idx, py);
      if (py) result.set(idx, py);
    }

    // Free cache warming: also cache context characters we already processed
    for (let i = segmentStart; i < clampedStart; i++) {
      if (pinyinCache.has(i)) continue;
      const char = text[i];
      if (/[一-鿿㐀-䶿]/.test(char)) {
        const offsetInSegment = i - segmentStart;
        const py = pinyinArray[offsetInSegment] || "";
        pinyinCache.set(i, py);
      }
    }
  } catch (e) {
    console.warn("[pinyin] getRangePinyin failed:", e);
    // Fallback: character-by-character
    const fn = await ensurePinyin();
    for (const idx of toFetch) {
      const py = fn(text[idx]);
      pinyinCache.set(idx, py);
      if (py) result.set(idx, py);
    }
  }

  return result;
}

// ── Image marker detection ───────────────────────────────────────────────────

/**
 * If the text starting at `index` begins with an [IMG:...] marker,
 * return the total length of the marker. Otherwise return 0.
 */
export function getImageMarkerLength(text: string, index: number): number {
  const slice = text.slice(index);
  const match = slice.match(/^\[IMG:([^\]]+)\]/);
  return match ? match[0].length : 0;
}

// ── Heading detection ────────────────────────────────────────────────────────

/**
 * Detect heading lines in text and return their character index ranges.
 * Each range is [start, end) — start is the first character of the heading
 * line, end is the position after the last character (before the newline).
 *
 * Used by TextDisplay to render headings with distinct styling.
 */
export function detectHeadingRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  if (!text) return ranges;

  // Split into lines, tracking char positions in the original text
  const lines: { start: number; end: number; content: string }[] = [];
  let pos = 0;
  for (const raw of text.split("\n")) {
    lines.push({
      start: pos,
      end: pos + raw.length,
      content: raw.trim(),
    });
    pos += raw.length + 1; // +1 for the \n separator
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const len = line.content.length;
    if (len === 0) continue;

    const prevBlank = i === 0 || lines[i - 1].content.length === 0;
    const nextBlank = i === lines.length - 1 || lines[i + 1].content.length === 0;
    let isHeading = false;

    // 1. Structural markers: 第X章/节/篇/部/卷/回, Chapter X, Part X
    if (
      /^第[零一二三四五六七八九十百千\d]+[章节篇部卷回]/.test(line.content) ||
      /^Chapter\s+\d+/i.test(line.content) ||
      /^Part\s+\d+/i.test(line.content)
    ) {
      isHeading = true;
    }

    // 2. Numbered headings: 一、 / （一） / 1. / 1、 (short line only)
    if (!isHeading && len <= 40) {
      if (
        /^[一二三四五六七八九十]、/.test(line.content) ||
        /^（[一二三四五六七八九十]）/.test(line.content) ||
        /^\d{1,2}[\.\、\s]/.test(line.content)
      ) {
        isHeading = true;
      }
    }

    // 3. Short standalone line isolated by blank lines, not body text
    if (!isHeading && len <= 50 && prevBlank && nextBlank) {
      // Exclude lines that look like dialogue（"…" or 「…」）
      if (/^["「『『"].*["」』」"]$/.test(line.content)) {
        isHeading = false;
      }
      // Exclude body-text lines (end with sentence punctuation)
      else if (!/[。！？…～,\.!\?;；]$/.test(line.content)) {
        // Exclude single-symbol scene dividers
        if (len > 1 || /[一-鿿]/.test(line.content)) {
          isHeading = true;
        }
      }
    }

    if (isHeading) {
      ranges.push([line.start, line.end]);
    }
  }

  return ranges;
}
