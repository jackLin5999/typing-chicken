/**
 * 指法入门课程。
 *
 * 设计上的三条铁律（见下面 `buildLines` 的实现）：
 * 1. **不引入还没教过的键** —— 这是打字课程最重要的纪律。为了「有趣」提前用
 *    一个新键，会让学员在还没建立手位时就伸手去够，坏习惯比慢更难改。
 * 2. **准确率优先于速度** —— 前几课不设速度门槛，速度是准确率的副产品。
 * 3. **不卡关** —— 达标只是「通关标记」，没达标也能往下走。
 */

/** 一节课的定义（内容由 `buildLines` 生成，不手写）。 */
interface LessonSpec {
  /** 本课新教的字符。空数组 = 复习课。 */
  newKeys: string[];
  title: string;
}

interface UnitSpec {
  title: string;
  /** 一句话说明这个单元在练什么。 */
  subtitle: string;
  lessons: LessonSpec[];
}

export const UNITS: UnitSpec[] = [
  {
    title: "第 1 单元 · 基准键",
    subtitle: "手指的家。打完每个键都要回到这里",
    lessons: [
      { newKeys: ["f", "j"], title: "f 和 j —— 摸到那两个小凸点" },
      { newKeys: ["d", "k"], title: "d 和 k —— 中指归位" },
      { newKeys: ["s", "l"], title: "s 和 l —— 无名指归位" },
      { newKeys: ["a", ";"], title: "a 和 ; —— 小指归位" },
      { newKeys: ["g", "h"], title: "g 和 h —— 食指往里伸" },
      { newKeys: [], title: "基准键复习" },
    ],
  },
  {
    title: "第 2 单元 · 上排",
    subtitle: "手指从基准键往上够，够完回位",
    lessons: [
      { newKeys: ["e", "i"], title: "e 和 i —— 中指上移" },
      { newKeys: ["r", "u"], title: "r 和 u —— 食指上移" },
      { newKeys: ["t", "y"], title: "t 和 y —— 食指再往里" },
      { newKeys: ["w", "o"], title: "w 和 o —— 无名指上移" },
      { newKeys: ["q", "p"], title: "q 和 p —— 小指上移" },
      { newKeys: [], title: "上排复习" },
    ],
  },
  {
    title: "第 3 单元 · 下排",
    subtitle: "往下够比往上难，慢一点没关系",
    lessons: [
      { newKeys: ["c", ","], title: "c 和 , —— 中指下移" },
      { newKeys: ["v", "m"], title: "v 和 m —— 食指下移" },
      { newKeys: ["b", "n"], title: "b 和 n —— 食指往里下" },
      { newKeys: ["x", "."], title: "x 和 . —— 无名指下移" },
      { newKeys: ["z", "/"], title: "z 和 / —— 小指下移" },
      { newKeys: [], title: "下排复习" },
    ],
  },
  {
    title: "第 4 单元 · 全部字母",
    subtitle: "现在 26 个字母都认识了，开始打真词真句",
    lessons: [
      { newKeys: [], title: "真词连打" },
      { newKeys: [], title: "短句" },
    ],
  },
  {
    title: "第 5 单元 · 大写与标点",
    subtitle: "Shift 要用**另一只手**按",
    lessons: [
      { newKeys: ["A"], title: "Shift —— 左手大写" },
      { newKeys: ["B"], title: "Shift —— 右手大写" },
      { newKeys: ["?", "!", "'"], title: "问号、叹号、撇号" },
      { newKeys: ['"', "-", ":"], title: "引号、连字符、冒号" },
      { newKeys: [], title: "标点复习" },
    ],
  },
  {
    title: "第 6 单元 · 数字",
    subtitle: "数字排离基准键最远，最需要回位",
    lessons: [
      { newKeys: ["1", "2", "3", "4", "5"], title: "1 – 5 —— 左手" },
      { newKeys: ["6", "7", "8", "9", "0"], title: "6 – 0 —— 右手" },
      { newKeys: [], title: "数字连打（年份、小数、电话）" },
      { newKeys: [], title: "综合复习" },
    ],
  },
];

/**
 * 词表 —— **这是整套课程里唯一需要人工准备的素材**。
 *
 * 不按字母集分类：直接堆常见短词，由 `pickWords` 按「本课已教过的字母」
 * 过滤。加词不用改课程结构。
 *
 * 收录标准：2–7 个字母、常见、无撇号连字符（避免提前引入未教的标点）。
 */
const WORD_POOL: string[] = [
  // 只用 a d f j k l s 就能拼的（第 1 单元后期）
  "a", "as", "ask", "asks", "add", "adds", "ads", "all", "fall", "falls",
  "fad", "fads", "lad", "lads", "dad", "dads", "sad", "salad", "salads",
  "flask", "flasks", "alas", "lass", "jazz", "adds", "ask", "flak",
  // 加上 g h
  "ash", "dash", "gash", "hash", "lash", "slash", "flash", "glad", "half",
  "hall", "halls", "has", "had", "gas", "gag", "hag", "jag", "sag", "shad",
  "shall", "flag", "flags", "gala", "gladly", "halls", "salad",
  // 加上 e i
  "like", "side", "idle", "idea", "ideal", "silk", "slide", "false", "field",
  "fields", "ease", "sea", "seas", "sail", "sails", "aid", "aids", "die",
  "dies", "lie", "lies", "tie", "ties", "lied", "held", "hide", "hides",
  "slide", "slide", "skill", "skills", "filled", "filed", "shield", "shield",
  "shelf", "shelves", "shale", "aisle", "deaf", "deal", "deals", "dealt",
  "jade", "jades", "kale", "lake", "lakes", "leak", "leaks", "leaf", "leaks",
  "else", "slid", "sleek", "sleek", "sleeve", "she", "he", "his", "him",
  "hide", "held", "held", "laid", "laid", "laid", "lied", "slide",
  // 加上 r u t y w o q p（全字母）
  "the", "and", "you", "that", "was", "for", "are", "with", "his", "they",
  "one", "have", "this", "from", "had", "hot", "word", "but", "what", "some",
  "we", "can", "out", "other", "were", "all", "there", "when", "up", "use",
  "your", "how", "said", "an", "each", "she", "which", "do", "their", "time",
  "if", "will", "way", "about", "many", "then", "them", "write", "would",
  "like", "so", "these", "her", "long", "make", "thing", "see", "him", "two",
  "has", "look", "more", "day", "could", "go", "come", "did", "number", "no",
  "most", "people", "my", "over", "know", "water", "than", "call", "first",
  "who", "may", "down", "side", "been", "now", "find", "any", "new", "work",
  "part", "take", "get", "place", "made", "live", "where", "after", "back",
  "little", "only", "round", "man", "year", "came", "show", "every", "good",
  "me", "give", "our", "under", "name", "very", "through", "just", "form",
  "much", "great", "think", "say", "help", "low", "line", "before", "turn",
  "cause", "same", "mean", "differ", "move", "right", "boy", "old", "too",
  "does", "tell", "sentence", "set", "three", "want", "air", "well", "also",
  "play", "small", "end", "put", "home", "read", "hand", "port", "large",
  "spell", "add", "even", "land", "here", "must", "big", "high", "such",
  "follow", "act", "why", "ask", "men", "change", "went", "light", "kind",
  "off", "need", "house", "picture", "try", "us", "again", "animal", "point",
  "mother", "world", "near", "build", "self", "earth", "father", "head",
  "stand", "own", "page", "should", "country", "found", "answer", "school",
  "grow", "study", "still", "learn", "plant", "cover", "food", "sun", "four",
  "between", "state", "keep", "eye", "never", "last", "let", "thought",
  "city", "tree", "cross", "farm", "hard", "start", "might", "story", "saw",
  "far", "sea", "draw", "left", "late", "run", "while", "press", "close",
  "night", "real", "life", "few", "north", "open", "seem", "together",
  "next", "white", "children", "begin", "got", "walk", "example", "ease",
  "paper", "group", "always", "music", "those", "both", "mark", "often",
  "letter", "until", "mile", "river", "car", "feet", "care", "second",
  "book", "carry", "took", "science", "eat", "room", "friend", "began",
  "idea", "fish", "mountain", "stop", "once", "base", "hear", "horse",
  "cut", "sure", "watch", "color", "face", "wood", "main", "enough",
  "plain", "girl", "usual", "young", "ready", "above", "ever", "red",
  "list", "though", "feel", "talk", "bird", "soon", "body", "dog", "family",
  "direct", "pose", "leave", "song", "measure", "door", "product", "black",
  "short", "class", "wind", "question", "happen", "complete", "ship",
  "area", "half", "rock", "order", "fire", "south", "problem", "piece",
  "told", "knew", "pass", "since", "top", "whole", "king", "space", "heard",
  "best", "hour", "better", "true", "during", "hundred", "five", "remember",
  "step", "early", "hold", "west", "ground", "interest", "reach", "fast",
  "verb", "sing", "listen", "six", "table", "travel", "less", "morning",
  "ten", "simple", "several", "vowel", "toward", "war", "lay", "against",
  "pattern", "slow", "center", "love", "person", "money", "serve", "appear",
  "road", "map", "rain", "rule", "govern", "pull", "cool", "notice", "voice",
  "unit", "power", "town", "fine", "certain", "fly", "fall", "lead", "cry",
  "dark", "machine", "note", "wait", "plan", "figure", "star", "box",
  "noun", "field", "rest", "correct", "able", "pound", "done", "beauty",
  "drive", "stood", "contain", "front", "teach", "week", "final", "gave",
  "green", "quick", "develop", "sleep", "warm", "free", "minute", "strong",
  "special", "mind", "behind", "clear", "tail", "produce", "fact", "street",
  "inch", "lot", "nothing", "course", "stay", "wheel", "full", "force",
  "blue", "object", "decide", "surface", "deep", "moon", "island", "foot",
  "yet", "busy", "test", "record", "boat", "common", "gold", "possible",
  "plane", "age", "dry", "wonder", "laugh", "thousand", "ago", "ran",
  "check", "game", "shape", "yes", "cool", "miss", "brought", "heat", "snow",
  "bed", "bring", "sit", "perhaps", "fill", "east", "weight", "language",
  "among", "grand", "ball", "yet", "wave", "drop", "heart", "present",
  "heavy", "dance", "engine", "position", "arm", "wide", "sail", "material",
  "size", "vary", "settle", "speak", "weight", "general", "ice", "matter",
  "circle", "pair", "include", "divide", "syllable", "felt", "grand",
  "ball", "yet", "wave", "drop", "heart", "present", "heavy", "dance",
  "engine", "position", "arm", "wide", "sail", "material", "size", "vary",
];

/**
 * 用在「短句」课里的固定句子 —— 全部小写、只用已教的标点。
 *
 * 不手写每课正文，但这几句要有意义、读得通，不是随机字母串。
 * （第一句是那个经典 pangram，是唯一例外 —— 它覆盖全部 26 个字母，
 *   用来检查有没有漏掉某个键确实好用。）
 */
const SENTENCE_POOL: string[] = [
  "the quick brown fox jumps over the lazy dog",
  "a journey of a thousand miles begins with a single step",
  "practice makes perfect but only if you practice right",
  "keep your eyes on the screen and your fingers on the home row",
  "speed will come on its own once your fingers stop guessing",
  "it is not the strongest that survives but the most adaptable",
  "every expert was once a beginner who refused to quit",
  "small daily improvements are the key to long term results",
  "the best time to plant a tree was twenty years ago",
  "you do not have to be great to start but you have to start",
  "reading a book while you type is the fastest way to improve",
  "slow is smooth and smooth is fast",
];

/** 数字排的练习组，避免随机数字串看起来像乱码。 */
const NUMBER_GROUPS: string[] = [
  "2026 1999 2008 1234 5678",
  "3.14 2.71 0.5 1.25 9.99",
  "010 1234 5678 9012 3456",
  "10 25 50 75 100 250 500",
  "12 24 36 48 60 72 84 96",
];

// ── 生成 ────────────────────────────────────────────────────────────────

export interface Lesson {
  id: string;
  /** 从 1 开始的序号，界面上显示成「第 N 课」。 */
  index: number;
  unitTitle: string;
  unitSubtitle: string;
  title: string;
  newKeys: string[];
  /** 到本课为止可以使用的字符。 */
  allowed: Set<string>;
  /** 要打的正文。 */
  text: string;
  /** 达标线。前几课不设速度门槛（0 = 不检查）。 */
  targetAccuracy: number;
  targetWpm: number;
}

/** 确定性伪随机 —— 课程内容必须在每次渲染时都一样。 */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 键位重复：把新键和已教的键两两配对，形成有节奏的短串。 */
function drillChunks(keys: string[], rand: () => number, count: number): string[] {
  const pool = keys.length > 0 ? keys : ["f", "j"];
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = pool[Math.floor(rand() * pool.length)];
    const b = pool[Math.floor(rand() * pool.length)];
    out.push(`${a}${a}${b}${b}`);
  }
  return out;
}

/** 从词表里挑「只用已教字母」的词。 */
function pickWords(allowed: Set<string>, rand: () => number, count: number, maxLen: number): string[] {
  const usable = WORD_POOL.filter(
    (w) => w.length <= maxLen && [...w].every((c) => allowed.has(c)),
  );
  if (usable.length === 0) return [];

  // 去重后随机抽，避免每课都从 "a as ask" 开始
  const unique = [...new Set(usable)];
  const picked: string[] = [];
  for (let i = 0; i < count && unique.length > 0; i++) {
    picked.push(unique[Math.floor(rand() * unique.length)]);
  }
  return picked;
}

/** 把词排成每行大约 `perLine` 个，控制单行长度。 */
function packWords(words: string[], perLine: number): string[] {
  const lines: string[] = [];
  for (let i = 0; i < words.length; i += perLine) {
    lines.push(words.slice(i, i + perLine).join(" "));
  }
  return lines;
}

function buildLines(
  index: number,
  newKeys: string[],
  allowed: Set<string>,
  isLast: boolean,
): string {
  const rand = mulberry32(index * 7919);
  const letters = [...allowed].filter((c) => /[a-z]/.test(c));
  const lines: string[] = [];

  // 大写课用大写字母当「标记」，不是真的新字符（a 早就教过了）
  const wantsUppercase = newKeys.some((k) => /^[A-Z]$/.test(k));

  // ① 键位重复 —— 每课都从「新键」开始建立肌肉记忆。
  //    数字和标点也算「新键」，否则数字课会退化成一堆字母练习。
  const focus = newKeys.filter((k) => k.length === 1 && !/^[A-Z]$/.test(k));
  if (focus.length > 0) {
    lines.push(drillChunks(focus, rand, 5).join(" "));
    lines.push(drillChunks(focus, rand, 5).join(" "));
  } else {
    // 复习课：从全部已教键里抽
    lines.push(drillChunks(letters, rand, 6).join(" "));
  }

  // ② 真词 —— 只用已教字母。字母太少时这一节会自然为空，那就跳过。
  const wordCount = letters.length >= 15 ? 28 : letters.length >= 10 ? 20 : 12;
  const words = pickWords(allowed, rand, wordCount, letters.length >= 15 ? 6 : 4);
  if (words.length > 0) {
    lines.push(...packWords(words, letters.length >= 15 ? 7 : 5));
  }

  // ②b 大写练习 —— 否则「Shift 课」里全是大写字母一个都见不到
  if (wantsUppercase) {
    const caps = pickWords(allowed, rand, 10, 6).map(
      (w) => w[0].toUpperCase() + w.slice(1),
    );
    if (caps.length > 0) lines.push(packWords(caps, 6).join("\n"));
  }

  // ③ 短句 —— 字母够多之后才有意义
  if (letters.length >= 20 && isLast) {
    const sentence = SENTENCE_POOL[Math.floor(rand() * SENTENCE_POOL.length)];
    if ([...sentence].every((c) => allowed.has(c) || c === " ")) {
      lines.push(sentence);
    }
  }

  // ④ 数字课
  if (allowed.has("1") && allowed.has("0")) {
    lines.push(NUMBER_GROUPS[index % NUMBER_GROUPS.length]);
  }

  return lines.join("\n");
}

function buildLessons(): Lesson[] {
  const lessons: Lesson[] = [];
  const allowed = new Set<string>([" "]);
  let index = 0;

  UNITS.forEach((unit, unitIdx) => {
    unit.lessons.forEach((spec, lessonIdx) => {
      index += 1;
      spec.newKeys.forEach((k) => allowed.add(k.toLowerCase()));
      // 大写课：A/B 只是「用 Shift 打 a/b」的意思，字符本身早已可用
      spec.newKeys.forEach((k) => {
        if (/^[A-Z]$/.test(k)) allowed.add(k.toLowerCase());
      });

      const isLastOfUnit = lessonIdx === unit.lessons.length - 1;

      lessons.push({
        id: `${unitIdx + 1}-${lessonIdx + 1}`,
        index,
        unitTitle: unit.title,
        unitSubtitle: unit.subtitle,
        title: spec.title,
        newKeys: spec.newKeys,
        allowed: new Set(allowed),
        text: buildLines(index, spec.newKeys, allowed, isLastOfUnit),
        // 前 8 课只求准，不求快
        targetAccuracy: index <= 8 ? 94 : 96,
        targetWpm: index <= 8 ? 0 : index <= 20 ? 20 : 30,
      });
    });
  });

  return lessons;
}

export const LESSONS: Lesson[] = buildLessons();

export const LESSON_BY_ID = new Map(LESSONS.map((l) => [l.id, l]));

/** 课程一共有几个单元 —— 用于进度显示。 */
export const UNIT_COUNT = UNITS.length;
