/**
 * Format seconds into a MM:SS string.
 */
export function formatTime(totalSeconds: number): string {
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

/**
 * True for characters the typing engine skips automatically instead of asking
 * the user to type them.
 *
 * Uses the Unicode white-space set rather than a hardcoded list of
 * `" " / "\n" / "\t" / "\r"`. Chinese e-books indent paragraphs with
 * U+3000 IDEOGRAPHIC SPACE and frequently contain U+00A0 NO-BREAK SPACE;
 * neither is a plain space, so a hardcoded list leaves the cursor parked on an
 * invisible character the user has to press space through at the start of
 * every paragraph. `\s` covers every Unicode Space_Separator plus the line
 * terminators, which is exactly the set we want.
 */
export function isWhitespace(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/**
 * True for characters the engine skips while 「跳过标点」 is on.
 *
 * Matches the Unicode general categories P (punctuation) and S (symbols)
 * instead of a hardcoded list. That covers the CJK forms real books use
 * (，。！？、；：（）《》「」【】—…), their ASCII counterparts (, . ! ? ; :), and
 * the stray symbols that turn up in prose (～ × ÷ ° ￥ ©). Letters, digits and
 * CJK ideographs are in neither category, so nothing the user must actually
 * type is lost.
 */
export function isPunctuation(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{P}\p{S}]/u.test(ch);
}

/**
 * True for characters the engine passes over without the user pressing
 * anything: whitespace always, punctuation too while 「跳过标点」 is on.
 */
export function isAutoSkipped(
  ch: string | undefined,
  skipPunctuation: boolean,
): boolean {
  return isWhitespace(ch) || (skipPunctuation && isPunctuation(ch));
}

/** 汉字（含扩展 A 区）。判断「要不要走拼音」就看它。 */
export function isCjkChar(ch: string | undefined): boolean {
  return ch !== undefined && /[㐀-鿿]/.test(ch);
}

/** 拼音转成「键盘上敲得出来的样子」。`ü` 一律按 `v` 算 —— 输入法里就是敲 v（女 = nv）。 */
const keyablePinyin = (s: string) =>
  s.toLowerCase().replace(/ü/g, "v").replace(/[^a-z]/g, "");

export type PinyinKeyHint =
  /** 敲这个字母。 */
  | { kind: "key"; letter: string }
  /** 拼音打完了，接下来是选字（空格或数字），没有字母可敲。 */
  | { kind: "done" }
  /** 组合串和拼音对不上，或者根本拿不到拼音 —— 不猜。 */
  | { kind: "none" };

/**
 * 中文输入时，键盘上该标出来的那个字母。
 *
 * 打中文敲的是拼音字母，而输入法把字母扣在自己手里 —— 提交之前
 * `targetText[cursorIndex]` 一直是那个汉字，键位提示于是什么都不亮。
 * 这个函数把它翻译回去。
 *
 * 关键是**组合串会横跨好几个字**：「zhongguo」＝中国，「zhongg」是打到一半。
 * 所以不能只盯着光标下那一个字，要从光标起往前走，一个字一个字地把组合串
 * 消耗掉，走到哪儿、下一个字母就是谁。
 *
 * 返回 `done` 而不是退回第一个字母：拼音打满了就没有「下一个字母」，
 * 这时候指的是选字键。跳回首字母是在骗人 —— 那个字母早就敲过了。
 *
 * 对不上（多音字：行 xíng/háng，你打的可能是另一个读音）返回 `none`，
 * 宁可什么都不亮，也不指一个错的键。
 */
export function pinyinNextKey(
  composed: string,
  fromIndex: number,
  pinyinAt: (index: number) => string,
  maxChars = 8,
): PinyinKeyHint {
  let rest = keyablePinyin(composed);

  for (let i = 0; i < maxChars; i++) {
    const py = keyablePinyin(pinyinAt(fromIndex + i));
    if (!py) continue; // 空格、标点：没有拼音，跳过

    if (py.startsWith(rest)) {
      // 组合串停在这个字里（包括「还没开始打」的 rest 为空）
      const letter = py[rest.length];
      return letter ? { kind: "key", letter } : { kind: "done" };
    }
    if (rest.startsWith(py)) {
      // 这个字已经打完了，接着消耗下一个字
      rest = rest.slice(py.length);
      continue;
    }
    return { kind: "none" };
  }
  return { kind: "none" };
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
