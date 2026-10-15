import { HOME_ROW_LEFT, HOME_ROW_RIGHT, keyCenterUnits } from "@/lib/keyboard";
import type { Finger } from "@/lib/keyboard";

/**
 * 覆盖在键盘上的**双手**。
 *
 * 画法上只留两样东西：
 * - **四根手指**：只描边、不填色（指尖底下正压着 a s d f / z x c v，
 *   填实了学员就看不见键位了），线本身往指根方向淡下去。
 * - **手掌**：只有掌指关节下方一小片往下化掉的影子。整只手掌摊在那里
 *   是一大坨，读者要的是手指，不是手掌。
 *
 * 从上方看到的是**手背**：手指、指根那几处关节。手心朝下压在键盘上，
 * **掌纹一概看不见** —— 照着「手掌」画掌纹，方向和位置都是错的。
 *
 * 手指的形状靠这几件事立住：
 * 1. **指尖齐平、指根错开**。四根指尖都搭在基准键上；长短的差别体现在指根
 *    （小指短，指根就低）。反着画（指尖错开成锯齿）出来是耙子。
 * 2. **指根比指尖收拢** —— 手指是扇形张开的，不是四根平行管子。
 * 3. **手指会伸到该按的那颗键上去**（见 `fingerPath` 的 `reach`）：
 *    指根钉在掌指关节不动，指尖落到目标键上 —— 打 qwerty 那行要往上够，
 *    打 zxcv 那行要往下收，够多远就伸多长。
 *
 * 该用哪根手指时，把那根**再描一遍高亮色**。高亮用的路径和普通的那根
 * 出自同一个函数，所以套上去严丝合缝。
 */

/** 单只左手（俯视，指尖朝上）的局部坐标；右手由镜像得到。 */
export const HAND_W = 96;

/** 手指间距（局部坐标）。横向缩放由它和键距的比值决定。 */
const FINGER_PITCH = 17;

interface FingerShape {
  finger: Finger;
  /** 指根中线的 x。 */
  baseX: number;
  /** 指尖中线的 x —— 由键距决定，指尖得对着键，不能乱动。 */
  tipX: number;
  /** 指根宽度。 */
  w: number;
  /** 指尖的 y。 */
  tip: number;
  /** 指根的 y。 */
  base: number;
}

/** 四指的几何（左手）。`tip` 几乎齐平，长短差别都在 `base` 上。 */
const FINGERS: FingerShape[] = [
  { finger: "left-pinky", baseX: 14, tipX: 10.5, w: 12, tip: 4, base: 30 },
  { finger: "left-ring", baseX: 29.5, tipX: 27.5, w: 13.5, tip: 1, base: 36 },
  { finger: "left-middle", baseX: 44.5, tipX: 44.5, w: 14, tip: 0, base: 39 },
  { finger: "left-index", baseX: 59, tipX: 61.5, w: 14, tip: 2, base: 37 },
];

/** 四指里最长那根（中指）的指尖 —— 对齐基准行时以它为准。 */
const LONGEST_TIP = Math.min(...FINGERS.map((f) => f.tip));

/**
 * 拇指：从大鱼际斜着伸出去，指尖落在空格键那一带。
 *
 * 两件事决定它像不像拇指：
 * - **根部要在食指根部附近**，不能沉到掌根去（沉下去就只是掌缘上的一个包，
 *   整只手会变成一个靴子）。真实的手，拇指掌指关节和食指掌指关节差不多高。
 * - **短而粗** —— 比任何一根手指都短，长度跟食指差不多。
 *
 * `angle` 是它相对「朝上」张开的角度（顺时针）：118° ≈ 比水平低 28°。
 */
const THUMB = { x: 66, y: 42, len: 21, w: 12, angle: 132 };

/**
 * 掌根的 y —— 手掌这块底色画到哪儿为止。
 *
 * 它已经**完全化没了**，只剩一个形状：比可见范围多留一点，让渐隐有个交代；
 * 留多了就是白白多出来的高度。
 */
const PALM_BOTTOM = 58;

/** 整只手最深的 y —— 算 viewBox 高度要用。 */
const HAND_BOTTOM = PALM_BOTTOM;

/**
 * 描边和底色都不写死颜色，一律走主题变量兑淡 ——
 * 纸白 / 米黄 / 深色三个主题下自动都对，不用各写一套。
 * 渐变的每一档也照这个来。
 */
const ACTIVE = "#3b82f6";

/**
 * 「伸过去」的目标。
 *
 * 手指不总是停在基准行：打 qwerty 那一行时要往上够，打 zxcv 那一行时
 * 要往下收，打数字行还要更远。这里给出手指和那颗键的位置，手就照此改写形状。
 */
export interface Reach {
  /** 哪根手指过去。 */
  finger: Finger;
  /** 目标键的中心，**键盘坐标系**（和键共用一套坐标）。 */
  x: number;
  y: number;
}

/**
 * 够远排时，**整只手先挪多少比例**，剩下的才交给手指去伸。
 *
 * 这个数只能小不能大。整只手一起挪，其余四指也跟着离开基准键 ——
 * 挪到三成，够数字行时那四根指尖就浮到 qwerty 行上了，「手该待在哪」
 * 这条最重要的信息先坏了。挪一点点：手有个前倾的意思，基准行还在键上。
 */
const HAND_SHARE = 0.18;

interface KeyboardHandsProps {
  /** 当前该用哪根手指；null = 不特别高亮。 */
  activeFinger: Finger | null;
  /** 该用哪些手指伸到哪几颗键上去；不传就都停在基准行。 */
  reaches?: Reach[];
  /** 键盘坐标系里一个键宽是多少（用来把手指间距对上键距）。 */
  unitSize: number;
  /** 键区左上角的 x。 */
  originX: number;
  /** 基准键位那一行的垂直中心 —— 指尖就落在这条线上。 */
  homeRowY: number;
}

/** 这根手指属于哪只手（右手的手指名以 `right-` 开头）。 */
const handOf = (finger: Finger) => (finger.startsWith("right") ? "right" : "left");

/**
 * 一对手。**不自己开 `<svg>`** —— 直接画进键盘那个 SVG 里，
 * 手和键共用一套坐标，对位是算出来的而不是摆出来的。
 */
export function KeyboardHands({
  activeFinger,
  reaches,
  unitSize,
  originX,
  homeRowY,
}: KeyboardHandsProps) {
  const scale = unitSize / FINGER_PITCH;
  const offsetY = homeRowY - LONGEST_TIP * scale;

  /**
   * 这只手整体该挪多少（局部单位）。
   *
   * 一只手上最多只有一个目标 —— 打大写时，按住 Shift 的小指在主键**另一只手**上。
   * 看不出是哪根手指在干什么的话就一动不动，所以对不上就返回 0。
   */
  const shiftYOf = (side: "left" | "right") => {
    const mine = reaches?.find((r) => handOf(r.finger) === side);
    if (!mine) return 0;
    const f = FINGERS.find((x) => x.finger === mine.finger.replace("right-", "left-"));
    if (!f) return 0;
    const targetY = (mine.y - offsetY) / scale;
    return (targetY - f.tip) * HAND_SHARE;
  };

  return (
    <g>
      <Hand
        side="left"
        x={anchorX(HOME_ROW_LEFT, originX, unitSize, scale, false)}
        y={offsetY + shiftYOf("left") * scale}
        scale={scale}
        activeFinger={activeFinger}
        reaches={reaches}
      />
      <Hand
        side="right"
        x={anchorX(HOME_ROW_RIGHT, originX, unitSize, scale, true)}
        y={offsetY + shiftYOf("right") * scale}
        scale={scale}
        activeFinger={activeFinger}
        reaches={reaches}
      />
    </g>
  );
}

/** 手的底部在键盘坐标系里的 y —— 调用方用它决定 viewBox 要多高。 */
export function handsBottomY(unitSize: number, homeRowY: number): number {
  const scale = unitSize / FINGER_PITCH;
  return homeRowY + (HAND_BOTTOM - LONGEST_TIP) * scale;
}

/**
 * 求出这只手该从哪个 x 开始画。
 *
 * 手在局部坐标里「小指指尖」是固定的（10.5），把它对齐到小指该管的那颗
 * 基准键上，整只手就自动对准了 —— 不用一个键一个键地摆。
 */
function anchorX(
  homeKeys: readonly string[],
  originX: number,
  unitSize: number,
  scale: number,
  flip: boolean,
): number {
  const units = keyCenterUnits(homeKeys[0]); // 「小指优先」顺序，第一个就是小指
  const pinkyCenter = originX + (units ?? 0) * unitSize;

  // 右手是镜像绘制的：小指在局部坐标里会翻到 HAND_W - 10.5
  const mirrored = flip ? HAND_W - FINGERS[0].tipX : FINGERS[0].tipX;
  return pinkyCenter - mirrored * scale;
}

// ── 手指 ────────────────────────────────────────────────────────────────

/**
 * 指尖的宽度。
 *
 * 平时收在指根的 0.72（指尖本来就比指根细）。但**手指短的时候不能再这么收**：
 * 往下排收（打 v 这种）时整根只剩十几毫米长，再一收窄，加上半圆头，
 * 就变成一个带柄的小球了。越短越不收。
 */
function tipWidth(w: number, len: number): number {
  const slender = Math.max(0, 1 - len / (2.2 * w)); // 手指够长 → 0
  return w * (0.72 + 0.2 * slender);
}

/**
 * 一根手指的轮廓：从指根 `(bx, by)` 长到指尖 `(tx, ty)`。
 *
 * 两件事让它读成「手指」而不是「管子」：
 *
 * 1. **中心线是一段浅弧，不是直线**。手指本来就不是直的，伸长了尤其明显 ——
 *    直线画法下，够到上排的那根会变成长长一根管子，一点手指的样子都没有。
 * 2. **沿中心线锥度摊开**：指根宽、指尖窄，最后收成一个圆头。
 *    弧线上每个采样点都要**按自己那一点的切线**往两侧摊，不能拿整体方向糊弄，
 *    否则弧的两侧会一边宽一边窄。
 *
 * **用向量算，不写死「朝上」** —— 换行时指尖要伸到别的键上，方向、长度、
 * 弯曲都得跟着变。指根收口那条线不描（靠隐含闭合补齐填充），
 * 指根于是直接落在掌缘上。
 */
function fingerOutline(
  bx: number,
  by: number,
  tx: number,
  ty: number,
  w: number,
): string {
  const dx = tx - bx;
  const dy = ty - by;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dy / len; // 轴的法向：+n 是「左」侧
  const ny = -dx / len;

  const halfBase = w / 2;
  const halfTip = tipWidth(w, len) / 2;
  const r = halfTip;

  // 弯多少：跟着长度走，但封顶 —— 弯过头指尖就对不准键了
  const bend = Math.min(len * 0.12, w * 0.85);
  const cx = (bx + tx) / 2 + nx * bend;
  const cy = (by + ty) / 2 + ny * bend;

  /** 中心线上 t 处的：坐标、这一点的单位法向、这一点该多宽。 */
  const sample = (t: number) => {
    const mt = 1 - t;
    const px = mt * mt * bx + 2 * mt * t * cx + t * t * tx;
    const py = mt * mt * by + 2 * mt * t * cy + t * t * ty;
    const dxT = 2 * mt * (cx - bx) + 2 * t * (tx - cx);
    const dyT = 2 * mt * (cy - by) + 2 * t * (ty - cy);
    const l = Math.hypot(dxT, dyT) || 1;
    return {
      x: px,
      y: py,
      ux: dxT / l, // 单位切向
      uy: dyT / l,
      nx: dyT / l, // 单位法向
      ny: -dxT / l,
      half: halfBase + (halfTip - halfBase) * t ** 0.7,
    };
  };

  const STEPS = 12;
  const left: string[] = [];
  const right: string[] = [];
  const q = (x: number, y: number) => `${x.toFixed(2)} ${y.toFixed(2)}`;

  for (let i = 0; i <= STEPS; i++) {
    const s = sample(i / STEPS);
    left.push(q(s.x + s.nx * s.half, s.y + s.ny * s.half));
    right.push(q(s.x - s.nx * s.half, s.y - s.ny * s.half));
  }

  /*
   * 关节那道横纹。手指长起来的时候全靠它撑住「这是一根手指」——
   * 只有轮廓没有关节，长到两排键那么长就成了一根管子。
   * 画在 0.58 处：再往指尖去会横穿 z x c v 那行的字母，往指根去就贴着掌缘了。
   */
  const j = sample(0.58);
  const jw = j.half * 0.72;
  const crease = `M ${q(j.x + j.nx * jw, j.y + j.ny * jw)}
    Q ${q(j.x + j.ux * 2.4, j.y + j.uy * 2.4)} ${q(
      j.x - j.nx * jw,
      j.y - j.ny * jw,
    )}`;

  return `M ${left[0]} L ${left.slice(1).join(" L ")}
    A ${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${right[STEPS]}
    L ${right.slice(0, -1).reverse().join(" L ")}
    ${crease}`;
}

/**
 * 单根手指的轮廓。默认长到它**在基准键上的位置**；
 * 传 `reach` 就改成长到那颗键上（换了行时用）。
 *
 * 往下排去（打 zxcv 那一行）时，**指根跟着往下挪一截**。手指不会真的变短，
 * 它是弯下来的；指根钉死不动的话，整根会被压成一个带圆头的短球。
 * 只挪六成 —— 挪满就成了整根平移，指根会和掌缘脱开。
 */
function fingerPath(
  f: FingerShape,
  reach?: { x: number; y: number } | null,
): string {
  const tx = reach?.x ?? f.tipX;
  const ty = reach?.y ?? f.tip;
  const drop = Math.max(0, ty - f.tip) * 0.6;
  return fingerOutline(f.baseX, f.base + drop, tx, ty, f.w);
}

// ── 拇指 ────────────────────────────────────────────────────────────────

/**
 * 拇指的四个关键点，都在手的局部坐标里。
 *
 * 拇指只剩一条轴线可摆：根部中心、指尖圆头、两侧的点都由 `dir`（指向指尖）
 * 和 `nrm`（指向食指那一侧）推出来 —— 不用手拧四个坐标。
 */
function thumbGeometry() {
  const a = (THUMB.angle * Math.PI) / 180;
  const dir = { x: Math.sin(a), y: -Math.cos(a) };
  const nrm = { x: dir.y, y: -dir.x };
  const r = (THUMB.w * 0.85) / 2;
  const tipC = {
    x: THUMB.x + dir.x * (THUMB.len - r),
    y: THUMB.y + dir.y * (THUMB.len - r),
  };
  return {
    dir,
    r,
    tipC,
    upper: { x: THUMB.x + nrm.x * (THUMB.w / 2), y: THUMB.y + nrm.y * (THUMB.w / 2) },
    lower: { x: THUMB.x - nrm.x * (THUMB.w / 2), y: THUMB.y - nrm.y * (THUMB.w / 2) },
    upperTip: { x: tipC.x + nrm.x * r, y: tipC.y + nrm.y * r },
    lowerTip: { x: tipC.x - nrm.x * r, y: tipC.y - nrm.y * r },
  };
}

/** 拇指：上缘 → 指尖圆头 → 下缘。接在虎口后面，接着往下走掌根。 */
function thumbOutline(): string {
  const { dir, r, upper, upperTip, lowerTip, lower } = thumbGeometry();
  return `C ${upper.x + dir.x * 9} ${upper.y + dir.y * 9} ${upperTip.x} ${upperTip.y} ${upperTip.x} ${upperTip.y}
    A ${r} ${r} 0 0 1 ${lowerTip.x} ${lowerTip.y}
    C ${lowerTip.x} ${lowerTip.y} ${lower.x + dir.x * 9} ${lower.y + dir.y * 9} ${lower.x} ${lower.y}`;
}

/**
 * 拇指自己的**闭合**轮廓 —— 只用于高亮。
 *
 * 平时拇指是手掌轮廓的一部分（见 `palmOutline`）：拆成两条路径的话，
 * 掌缘和拇指缘会在掌根那里交叉出一个「X」，两笔都淡下去之后，
 * 剩下一个谁也说不清是什么的叉。
 */
function thumbPath(): string {
  const { r, upper, upperTip, lowerTip, lower } = thumbGeometry();
  return `M ${upper.x} ${upper.y} L ${upperTip.x} ${upperTip.y}
    A ${r} ${r} 0 0 1 ${lowerTip.x} ${lowerTip.y} L ${lower.x} ${lower.y}`;
}

// ── 整只手 ──────────────────────────────────────────────────────────────

/**
 * 手掌的轮廓。**画出来的只有掌指关节那一条**，往下靠渐变化掉 ——
 * 整只手掌摊在那里是一大坨，读者要的是手指，不是手掌。
 *
 * 上边那条（掌指关节线）由 Z 补上：四根手指的指根就落在那条线上，
 * 于是手指看起来是从手掌里长出来的，而不是四根浮在键盘上的钩子。
 */
function palmOutline(fingers: FingerShape[]): string {
  const first = fingers[0];
  const last = fingers[fingers.length - 1];
  const leftEdge = first.baseX - first.w / 2 - 1; // 掌左上角
  const knuckleRight = last.baseX + last.w / 2;

  let d = `M ${knuckleRight} ${last.base}`;

  // 虎口：食指和拇指之间**必须收这一刀**。不收，拇指就只是掌缘上鼓出来的一块，
  // 整只手看着像只靴子 —— 这一刀是「这里有个拇指」的主要来源。
  const { upper, lower } = thumbGeometry();
  const web = { x: upper.x - 7.5, y: upper.y + 5 };
  d += ` C ${web.x + 5} ${web.y - 3} ${web.x + 2} ${web.y} ${web.x} ${web.y}`;
  d += ` C ${web.x - 1.5} ${web.y + 1.5} ${upper.x - 5} ${upper.y + 2} ${upper.x} ${upper.y}`;
  d += ` ${thumbOutline()}`;

  // 掌根 → 小鱼际 → 回到掌左上角，最后由 Z 补上掌指关节那条线
  const heel = leftEdge + 29;
  d += ` C ${lower.x - 6} ${lower.y + 3} ${(lower.x + heel) / 2} ${PALM_BOTTOM} ${heel} ${PALM_BOTTOM}`;
  d += ` C ${leftEdge + 11} ${PALM_BOTTOM} ${leftEdge + 4} ${PALM_BOTTOM - 9} ${
    leftEdge + 1
  } ${first.base + 22}`;
  d += ` C ${leftEdge - 1} ${first.base + 16} ${leftEdge - 1} ${first.base + 8} ${leftEdge} ${
    first.base - 1
  } Z`;
  return d;
}

interface HandProps {
  side: "left" | "right";
  x: number;
  y: number;
  scale: number;
  activeFinger: Finger | null;
  reaches?: Reach[];
}

function Hand({ side, x, y, scale, activeFinger, reaches }: HandProps) {
  const flip = side === "right";
  // 右手：平移到位后镜像。镜像会让 x 轴反向，所以先往回挪一个手宽。
  const transform = flip
    ? `translate(${x} ${y}) scale(${-scale} ${scale}) translate(${-HAND_W} 0)`
    : `translate(${x} ${y}) scale(${scale})`;

  const localFinger = (base: Finger): Finger =>
    flip ? (base.replace("left-", "right-") as Finger) : base;

  const activeShape = FINGERS.find((f) => localFinger(f.finger) === activeFinger);
  const thumbOn = localFinger("thumb") === activeFinger;

  /**
   * 这根手指的目标换算成本手的局部坐标；没有就是 null（停在基准行）。
   *
   * 右手是镜像画的（scale 带负号），局部 x 要按 `HAND_W - …` 翻一次，
   * 不翻的话目标会跑到手的另一侧去。
   *
   * `y` 用的是**挪过之后**的手原点 —— 整只手先挪了一截，这里再按新原点算，
   * 两者合起来才正好落在键上。
   */
  const reachOf = (f: FingerShape) => {
    const r = reaches?.find((x2) => x2.finger === localFinger(f.finger));
    if (!r) return null;
    return {
      x: flip ? HAND_W - (r.x - x) / scale : (r.x - x) / scale,
      y: (r.y - y) / scale,
    };
  };

  return (
    <g transform={transform} strokeLinejoin="round" strokeLinecap="round">
      <defs>
        {/* 手掌：只在掌指关节下方留一点点影子，往下一路化到没有 */}
        <linearGradient id={`palm-fill-${side}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(var(--color-surface))" stopOpacity="0.82" />
          <stop offset="35%" stopColor="rgb(var(--color-surface))" stopOpacity="0.34" />
          <stop offset="70%" stopColor="rgb(var(--color-surface))" stopOpacity="0" />
        </linearGradient>
        {/* 手指的描边：指尖清楚、往指根淡下去 —— 和手掌一个方向地化掉 */}
        <linearGradient id={`finger-line-${side}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(var(--color-ink))" stopOpacity="0.4" />
          <stop offset="55%" stopColor="rgb(var(--color-ink))" stopOpacity="0.22" />
          <stop offset="100%" stopColor="rgb(var(--color-ink))" stopOpacity="0.05" />
        </linearGradient>
      </defs>

      {/*
        手掌：**只有一层往下化掉的底色，不描边**。
        描了边就会留下它的形状：掌根和拇指根那一带会交叉出一个「∧」，
        两笔都淡下去之后剩一个说不清是什么的符号。虚化就虚化干净。
      */}
      <path d={palmOutline(FINGERS)} fill={`url(#palm-fill-${side})`} stroke="none" />

      {/* 四指：只描边 —— 底下压着 a s d f / z x c v，填实了就看不见键位。
          线本身也往下淡，手指于是像从键盘里长出来，而不是挂在半空 */}
      {FINGERS.map((f) => (
        <path
          key={f.finger}
          d={fingerPath(f, reachOf(f))}
          fill="none"
          stroke={`url(#finger-line-${side})`}
          strokeWidth={1.3}
        />
      ))}

      {/* 高亮：该用哪根手指，就把那根填成蓝的、再描一圈 */}
      {activeShape && (
        <path
          d={fingerPath(activeShape, reachOf(activeShape))}
          fill={ACTIVE}
          fillOpacity={0.18}
          stroke={ACTIVE}
          strokeWidth={2.2}
        />
      )}
      {thumbOn && (
        <path
          d={thumbPath()}
          fill={ACTIVE}
          fillOpacity={0.18}
          stroke={ACTIVE}
          strokeWidth={2.2}
        />
      )}
    </g>
  );
}
