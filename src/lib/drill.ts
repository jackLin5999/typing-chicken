/** 句末标点 —— 中文为主，兼顾英文。换行也是边界（目录、标题这类短行不靠标点分段）。 */
const SENTENCE_END = new Set([
  "。", "！", "？", "…", "；",
  ".", "!", "?", ";",
]);

/** 单句在重练里最多留这么长，避免一个超长段落把整篇撑爆。 */
const MAX_SEGMENT_CHARS = 120;

interface Segment {
  start: number;
  end: number;
}

/** 把正文切成句子区间（句末标点归到前一句）。 */
function splitSentences(text: string): Segment[] {
  const segments: Segment[] = [];
  let start = 0;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (!SENTENCE_END.has(ch) && ch !== "\n") continue;
    if (text.slice(start, i + 1).trim()) segments.push({ start, end: i + 1 });
    start = i + 1;
  }

  if (start < text.length && text.slice(start).trim()) {
    segments.push({ start, end: text.length });
  }

  return segments;
}

/**
 * 取出这一句的内容；句子过长时以 `anchor`（错字位置）为中心截一个窗口，
 * 免得把一整段几百字全塞进重练里。
 */
function segmentText(text: string, segment: Segment, anchor: number): string {
  const raw = text.slice(segment.start, segment.end);
  if (raw.length <= MAX_SEGMENT_CHARS) return raw.trim();

  const half = Math.floor(MAX_SEGMENT_CHARS / 2);
  const from = Math.max(segment.start, anchor - half);
  const to = Math.min(segment.end, from + MAX_SEGMENT_CHARS);
  return text.slice(from, to).trim();
}

/**
 * 从正文里挑出「打过错的那些句子」，拼成一段重练文本。
 *
 * 为什么按句子而不是按单字：中文打字练的是词和句。把 12 个孤零零的字
 * 排成一行，练出来的手感没有意义。
 *
 * 返回空串表示没有可练的内容（没错字，或索引全落在正文之外）。
 */
export function buildMistakeDrill(
  text: string,
  incorrectIndices: number[],
  maxChars = 300,
): string {
  if (!text || incorrectIndices.length === 0) return "";

  const segments = splitSentences(text);
  if (segments.length === 0) return "";

  // 每个错字 → 它所在的句子（按 start 去重，保持原文顺序）
  const chosen = new Map<number, { segment: Segment; anchor: number }>();
  for (const idx of incorrectIndices) {
    const segment = segments.find((s) => idx >= s.start && idx < s.end);
    if (!segment) continue;
    if (!chosen.has(segment.start)) {
      chosen.set(segment.start, { segment, anchor: idx });
    }
  }
  if (chosen.size === 0) return "";

  const ordered = [...chosen.values()].sort(
    (a, b) => a.segment.start - b.segment.start,
  );

  const parts: string[] = [];
  let total = 0;
  for (const { segment, anchor } of ordered) {
    const piece = segmentText(text, segment, anchor);
    if (!piece) continue;
    // 已经攒够了就停 —— 宁可少练几句，也别甩一大篇出来
    if (parts.length > 0 && total + piece.length > maxChars) break;
    parts.push(piece);
    total += piece.length;
  }

  return parts.join("");
}

/** 正文里有多少个**不同的**错字位置，用于界面上显示。 */
export function countMistakes(text: string, incorrectIndices: number[]): number {
  if (!text || incorrectIndices.length === 0) return 0;
  return new Set(
    incorrectIndices.filter((i) => i >= 0 && i < text.length),
  ).size;
}
