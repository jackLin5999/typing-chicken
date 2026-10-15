/**
 * 标准 QWERTY 主键区的布局与手指分工。
 *
 * 这是「指法提示」和「入门课程」共用的地基：课程用它决定每节课教哪些键，
 * 提示用它决定高亮哪个键、写哪根手指。
 */

export type Finger =
  | "left-pinky"
  | "left-ring"
  | "left-middle"
  | "left-index"
  | "right-index"
  | "right-middle"
  | "right-ring"
  | "right-pinky"
  | "thumb";

export const FINGER_LABEL: Record<Finger, string> = {
  "left-pinky": "左手小指",
  "left-ring": "左手无名指",
  "left-middle": "左手中指",
  "left-index": "左手食指",
  "right-index": "右手食指",
  "right-middle": "右手中指",
  "right-ring": "右手无名指",
  "right-pinky": "右手小指",
  thumb: "拇指",
};

/**
 * 每个手指一种颜色，用于给键位分区上色。
 *
 * 八个色相均匀分开，但**颜色永远不是唯一线索** —— 界面上同时会写出
 * 「用左手无名指」。这样即使色觉有差异或截图是黑白的，信息也不丢。
 */
export const FINGER_COLOR: Record<Finger, string> = {
  "left-pinky": "#ef4444",
  "left-ring": "#f97316",
  "left-middle": "#eab308",
  "left-index": "#22c55e",
  "right-index": "#14b8a6",
  "right-middle": "#3b82f6",
  "right-ring": "#8b5cf6",
  "right-pinky": "#ec4899",
  thumb: "#94a3b8",
};

/** 一根手指属于哪只手 —— 高亮时按手做整片提示。 */
export function handOf(finger: Finger): "left" | "right" {
  return finger.startsWith("left") ? "left" : "right";
}

export interface KeyCap {
  /** 键帽上显示的字符。修饰键显示文字。 */
  label: string;
  /** 宽度，单位是「一个普通键」。 */
  units: number;
  /**
   * 这个键**打出来的字符**（小写）。修饰键为 undefined。
   * 用来把目标字符映射到键位。
   */
  char?: string;
  /** 同键位需要 Shift 才能打出的字符，例如 "!" 之于 "1"。 */
  shiftChar?: string;
  /** 该用哪根手指；修饰键为 undefined（不参与指法提示）。 */
  finger?: Finger;
  /** 修饰键（Tab / Caps / Enter…）—— 画出来但不上色、不高亮。 */
  modifier?: boolean;
  /** 视觉上的额外左偏移，单位是键宽（用于让行与行错开）。 */
  indent?: number;
  /** 只对 Shift 有意义：打大写时要高亮**另一只手**的那个 Shift。 */
  shiftSide?: "left" | "right";
}

/** 手指与键的对应关系，按标准指法。 */
const F = {
  lp: "left-pinky",
  lr: "left-ring",
  lm: "left-middle",
  li: "left-index",
  ri: "right-index",
  rm: "right-middle",
  rr: "right-ring",
  rp: "right-pinky",
  th: "thumb",
} as const satisfies Record<string, Finger>;

/** 一行键的简写：`"q w e r t"` → 五个普通键。 */
function row(chars: string, fingers: Finger[]): KeyCap[] {
  return chars.split(" ").map((c, i) => ({
    label: c,
    units: 1,
    char: c,
    finger: fingers[Math.min(i, fingers.length - 1)],
  }));
}

const LETTER_ROW_1 = row("q w e r t y u i o p", [F.lp, F.lr, F.lm, F.li, F.li, F.ri, F.ri, F.rm, F.rr, F.rp]);
const LETTER_ROW_2 = row("a s d f g h j k l", [F.lp, F.lr, F.lm, F.li, F.li, F.ri, F.ri, F.rm, F.rr]);
const LETTER_ROW_3 = row("z x c v b n m", [F.lp, F.lr, F.lm, F.li, F.li, F.ri, F.ri]);

const DIGIT_CHARS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];
const DIGIT_SHIFT = ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")"];
const DIGIT_FINGERS: Finger[] = [F.lp, F.lr, F.lm, F.li, F.li, F.ri, F.ri, F.rm, F.rr, F.rp];

/**
 * 整个键盘，按行排列。宽度合计 15 个单位。
 *
 * 只画主键区加必要的修饰键 —— Ctrl / Win / Alt 对指法教学没有意义，
 * 画上去只是噪声。
 */
export const KEYBOARD_ROWS: KeyCap[][] = [
  [
    { label: "`", units: 1, char: "`", shiftChar: "~", finger: F.lp },
    ...DIGIT_CHARS.map((c, i) => ({
      label: c,
      units: 1,
      char: c,
      shiftChar: DIGIT_SHIFT[i],
      finger: DIGIT_FINGERS[i],
    })),
    { label: "-", units: 1, char: "-", shiftChar: "_", finger: F.rp },
    { label: "=", units: 1, char: "=", shiftChar: "+", finger: F.rp },
    { label: "Backspace", units: 2, modifier: true },
  ],
  [
    { label: "Tab", units: 1.5, modifier: true },
    ...LETTER_ROW_1,
    { label: "[", units: 1, char: "[", shiftChar: "{", finger: F.rp },
    { label: "]", units: 1, char: "]", shiftChar: "}", finger: F.rp },
    { label: "\\", units: 1.5, char: "\\", shiftChar: "|", finger: F.rp },
  ],
  [
    { label: "Caps", units: 1.75, modifier: true },
    ...LETTER_ROW_2,
    { label: ";", units: 1, char: ";", shiftChar: ":", finger: F.rp },
    { label: "'", units: 1, char: "'", shiftChar: '"', finger: F.rp },
    { label: "Enter", units: 2.25, modifier: true },
  ],
  [
    { label: "Shift", units: 2.25, modifier: true, shiftSide: "left" },
    ...LETTER_ROW_3,
    { label: ",", units: 1, char: ",", shiftChar: "<", finger: F.rm },
    { label: ".", units: 1, char: ".", shiftChar: ">", finger: F.rr },
    { label: "/", units: 1, char: "/", shiftChar: "?", finger: F.rp },
    { label: "Shift", units: 2.75, modifier: true, shiftSide: "right" },
  ],
  [
    { label: "Space", units: 7, char: " ", finger: F.th, indent: 4 },
  ],
];

/** 字符 → 键位。`shift` 为 true 表示这个字符需要按住 Shift 才能打出来。 */
export interface KeyStroke {
  /** 主键上印的字符（不带 Shift 的那个）。 */
  key: string;
  /** 这个输入是否需要 Shift。 */
  shift: boolean;
  /** 该用哪根手指按主键。 */
  finger: Finger;
  /** Shift 该用哪根手指（按「另一只手按 Shift」的标准指法）。 */
  shiftFinger?: Finger;
}

const CHAR_TO_STROKE = new Map<string, KeyStroke>();
for (const rowKeys of KEYBOARD_ROWS) {
  for (const cap of rowKeys) {
    if (!cap.char || !cap.finger) continue;
    CHAR_TO_STROKE.set(cap.char, { key: cap.char, shift: false, finger: cap.finger });
    if (cap.shiftChar) {
      // 用另一只手的**小指**按 Shift —— 这是标准指法，也是键盘上 Shift 的位置
      const shiftFinger: Finger = handOf(cap.finger) === "left" ? "right-pinky" : "left-pinky";
      CHAR_TO_STROKE.set(cap.shiftChar, {
        key: cap.char,
        shift: true,
        finger: cap.finger,
        shiftFinger,
      });
    }
  }
}

/**
 * 查一个字符该怎么打。
 *
 * 大写字母走 Shift；ASCII 之外的字符（汉字、全角标点）返回 undefined ——
 * 那些不是「一次按键」，指法提示对它们没有意义。
 */
export function strokeFor(ch: string | undefined): KeyStroke | undefined {
  if (!ch) return undefined;
  if (ch >= "A" && ch <= "Z") {
    const base = CHAR_TO_STROKE.get(ch.toLowerCase());
    if (!base) return undefined;
    const shiftFinger: Finger = handOf(base.finger) === "left" ? "right-pinky" : "left-pinky";
    return { key: base.key, shift: true, finger: base.finger, shiftFinger };
  }
  return CHAR_TO_STROKE.get(ch);
}

/** 所有「教得到」的键（普通字符，不含修饰键）。 */
export const ALL_TYPABLE_CHARS: string[] = [...CHAR_TO_STROKE.keys()];

/** 一个键在主键区里占的位置。横向单位是「一个键宽」，纵向是行号。 */
export interface KeyLayout {
  /** 键帽中心的 x。 */
  centerX: number;
  /** 键的左边缘。 */
  leftX: number;
  /** 键宽。 */
  units: number;
  /** 第几行，0 = 数字行、2 = 基准行。 */
  row: number;
}

/** 在主键区里按条件找一颗键。 */
function findKey(match: (cap: KeyCap) => boolean): KeyLayout | null {
  for (let row = 0; row < KEYBOARD_ROWS.length; row++) {
    let x = 0;
    for (const cap of KEYBOARD_ROWS[row]) {
      x += cap.indent ?? 0;
      if (match(cap)) {
        return { centerX: x + cap.units / 2, leftX: x, units: cap.units, row };
      }
      x += cap.units;
    }
  }
  return null;
}

/**
 * 某个键在主键区里的位置。
 *
 * 指法提示要把手指画在对应的键**正上方**（基准行）或**伸到那颗键上**
 * （换了行的时候），所以得知道每个键画在哪儿 —— 手的位置不能凭感觉摆，
 * 必须和键距严格对齐。
 * 找不到（不是可打字符、或是修饰键）返回 null。
 */
export function keyLayout(target: string): KeyLayout | null {
  return findKey((cap) => cap.char === target);
}

/**
 * 某个 Shift 键的位置。
 *
 * 打大写和 `!@#$` 时要按住 Shift，提示里会说要按哪只手的小指 ——
 * 那只手的小指就得**真的伸到 Shift 上**去，所以也得知道它画在哪儿。
 */
export function shiftKeyLayout(side: "left" | "right"): KeyLayout | null {
  return findKey((cap) => cap.shiftSide === side);
}

/** 某个键在主键区里的水平中心，单位是「一个键宽」。 */
export function keyCenterUnits(target: string): number | null {
  return keyLayout(target)?.centerX ?? null;
}

/** 手指的短名 —— 指位条下面一格一个，长名字放不下。 */
export const FINGER_SHORT: Record<Finger, string> = {
  "left-pinky": "小",
  "left-ring": "无",
  "left-middle": "中",
  "left-index": "食",
  "right-index": "食",
  "right-middle": "中",
  "right-ring": "无",
  "right-pinky": "小",
  thumb: "拇",
};

/**
 * 基准键位：左手小指/无名指/中指/食指，右手食指/中指/无名指/小指。
 * 顺序和 `KeyboardHands` 里手指的画法一致（两手都是「小指优先」）。
 */
export const HOME_ROW_LEFT = ["a", "s", "d", "f"] as const;
export const HOME_ROW_RIGHT = [";", "l", "k", "j"] as const;

/** 一根手指管的基准键。拇指没有基准键（空格键有 7 个键宽，谈不上「归谁」）。 */
export function homeKeyOf(finger: Finger): string | null {
  if (finger === "thumb") return null;
  const which = finger.split("-")[1];
  const index = ["pinky", "ring", "middle", "index"].indexOf(which ?? "");
  if (index < 0) return null;
  const row = finger.startsWith("left") ? HOME_ROW_LEFT : HOME_ROW_RIGHT;
  return row[index] ?? null;
}

/** 课程会依次教到的主键区字母 —— 顺序见 lessons.ts。 */
export const LETTER_KEYS = "abcdefghijklmnopqrstuvwxyz".split("");
