import { useMemo } from "react";
import {
  FINGER_COLOR,
  FINGER_LABEL,
  KEYBOARD_ROWS,
  homeKeyOf,
  keyCenterUnits,
  keyLayout,
  shiftKeyLayout,
  strokeFor,
} from "@/lib/keyboard";
import { KeyboardHands, handsBottomY } from "./KeyboardHands";
import type { Reach } from "./KeyboardHands";
import type { Finger } from "@/lib/keyboard";
import type { KeyLayout } from "@/lib/keyboard";

interface KeyboardHintProps {
  /** 下一个要打的字符。undefined = 只显示键盘、不提示。 */
  nextChar: string | undefined;
  /**
   * 已经教过的键（小写字母 / 字符）。传了就把它之外的键压暗 ——
   * 课程里用，让学员一眼看出「现在只用得上这些」。
   */
  taught?: ReadonlySet<string>;
  /**
   * 键盘下方是否画一对手的虚影。
   *
   * 默认关：它要多占约 75px 高，阅读界面没有这个预算。
   * 课程里开 —— 那里本来就是在学指法。
   */
  showHands?: boolean;
  /**
   * 顶掉键盘下方那行说明文字。
   *
   * 中文输入用：该敲的字母不一定存在 —— 拼音打完了是「去选字」，
   * 多音字对不上是「这个字读什么」，都不是「用哪根手指敲哪个键」。
   * 这时候没有键可指，但**必须说清楚在等什么**，否则键盘就是一片死寂。
   */
  hintOverride?: string;
  className?: string;
}

// 一个键宽 40、行距 40。viewBox 是 612 宽 —— 容器给到 max-w-2xl（672px）时
// 缩放约 1.1，键宽约 41px、字高约 14px，是能看清的比例。
// 之前放在 max-w-md（448px）里缩到 0.73，字只剩 8px，糊成一团。
const UNIT = 40;
const GAP = 3;
const KEY_H = 36;
const ROW_PITCH = 40;
const PAD = 6;
const TOTAL_UNITS = 15; // 每行都是 15 个单位宽

const W = TOTAL_UNITS * UNIT + PAD * 2;
const H = KEYBOARD_ROWS.length * ROW_PITCH + PAD * 2;

/** 基准键（a s d f / j k l ;）那一行的垂直中心 —— 指尖就落在这条线上。 */
const HOME_ROW_Y = PAD + 2 * ROW_PITCH + KEY_H / 2;


/**
 * 键盘指法提示。
 *
 * 8 个手指分区各一种颜色，但**颜色不是唯一线索** —— 下方同时写出
 * 「用左手无名指」。色觉有差异、或者截图转成黑白，信息都不会丢。
 *
 * 需要 Shift 的字符会同时高亮**另一只手的** Shift，这是标准指法，
 * 也顺带教会用户「不要用同侧的手去够 Shift」。
 */
export function KeyboardHint({
  nextChar,
  taught,
  showHands = false,
  hintOverride,
  className,
}: KeyboardHintProps) {
  const stroke = useMemo(() => strokeFor(nextChar), [nextChar]);

  /**
   * 该用哪些手指**伸到**哪些键上去。
   *
   * 两根手指会同时伸：主键那根，以及需要 Shift 时另一只手的小指
   * （Shift 在键区最边上，小指得横着挪过去 —— 不画出来，那句
   * 「按住【右手小指】的 Shift」就只是句空话）。
   *
   * 打在基准行上时，目标就是那根手指本来待的地方 —— 什么也不会动；
   * 打到别行去才会有变化。拇指不参与：空格键就在它手底下。
   */
  const reaches = useMemo<Reach[]>(() => {
    if (!stroke) return [];

    /** 目标点：落在键上、并且**尽量靠近这根手指原来的位置**。
     *  宽键（Shift 有 2 个多键宽）取正中会把手指拽出去老远，取最近的那一头才对。 */
    const target = (finger: Finger, at: KeyLayout): Reach => {
      const home = keyCenterUnits(homeKeyOf(finger) ?? "");
      const x =
        home === null
          ? at.centerX
          : Math.min(Math.max(home, at.leftX + 0.6), at.leftX + at.units - 0.6);
      return {
        finger,
        x: PAD + x * UNIT,
        y: PAD + at.row * ROW_PITCH + KEY_H / 2,
      };
    };

    const out: Reach[] = [];
    const main = keyLayout(stroke.key);
    if (main && stroke.finger !== "thumb") out.push(target(stroke.finger, main));

    if (stroke.shift && stroke.shiftFinger) {
      const side = stroke.shiftFinger.startsWith("left") ? "left" : "right";
      const shift = shiftKeyLayout(side);
      if (shift) out.push(target(stroke.shiftFinger, shift));
    }
    return out;
  }, [stroke]);

  /** 需要 Shift 时，该高亮哪一侧的那个 Shift（永远是与主键相反的那只手）。 */
  const shiftSide =
    stroke?.shift && stroke.shiftFinger
      ? stroke.shiftFinger.startsWith("left")
        ? ("left" as const)
        : ("right" as const)
      : undefined;

  const hintText = useMemo(() => {
    if (!nextChar) return "把光标放到要打的字上";
    if (!stroke) return "这个字符需要用输入法，指法提示对它不适用";
    if (stroke.shift && stroke.shiftFinger) {
      return `按住【${FINGER_LABEL[stroke.shiftFinger]}】的 Shift，再用【${FINGER_LABEL[stroke.finger]}】敲 ${stroke.key.toUpperCase()}`;
    }
    return `用【${FINGER_LABEL[stroke.finger]}】敲 ${stroke.key}`;
  }, [nextChar, stroke]);

  return (
    <div className={className}>
      <svg
        viewBox={`0 0 ${W} ${
          showHands ? Math.max(H, handsBottomY(UNIT, HOME_ROW_Y) + 6) : H
        }`}
        className="w-full h-auto text-ink"
        role="img"
        aria-label={`键盘指法提示：${hintText}`}
      >
        {KEYBOARD_ROWS.map((rowKeys, rowIndex) => {
          let x = PAD;
          const y = PAD + rowIndex * ROW_PITCH;

          return rowKeys.map((cap, i) => {
            const width = cap.units * UNIT - GAP;
            // 缩进得**先加再画**。漏了这一步，空格键就会画到行首 ——
            // `keyCenterUnits` 里是算上了缩进的，两边不一致，键就歪了。
            x += (cap.indent ?? 0) * UNIT;
            const rectX = x;
            x += cap.units * UNIT;

            const isNext = !!stroke && !cap.modifier && cap.char === stroke.key;
            const isShiftKey = shiftSide !== undefined && cap.shiftSide === shiftSide;

            // 课程里没教过的键压暗，视线自然只落在能用的键上
            const dimmed =
              !cap.modifier &&
              !!cap.char &&
              taught !== undefined &&
              !taught.has(cap.char) &&
              cap.char !== " ";

            const zoneColor = cap.finger ? FINGER_COLOR[cap.finger] : undefined;

            return (
              <g key={`${rowIndex}-${i}`}>
                <rect
                  x={rectX}
                  y={y}
                  width={width}
                  height={KEY_H}
                  rx={5}
                  fill={zoneColor ?? "currentColor"}
                  opacity={
                    // 待按的键**不能填成实色** —— 字母是深色的，压在饱和的蓝底上
                    // 直接看不见了（用户报的「字母整个被遮住」就是这个）。
                    // 底色只比别的键重一点，靠下面那圈描边把它挑出来。
                    dimmed
                      ? 0.05
                      : cap.modifier
                        ? 0.06
                        : isNext || isShiftKey
                          ? 0.42
                          : 0.22
                  }
                />
                {/* 待按的键：一圈蓝边。这样键帽底色和字母都还看得清 */}
                {(isNext || isShiftKey) && (
                  <rect
                    x={rectX}
                    y={y}
                    width={width}
                    height={KEY_H}
                    rx={5}
                    fill="none"
                    stroke="#3b82f6"
                    strokeWidth={2.5}
                    opacity={0.9}
                  />
                )}
                <text
                  x={rectX + width / 2}
                  y={y + KEY_H / 2 + 5}
                  textAnchor="middle"
                  className={`fill-current ${cap.modifier ? "text-[10px]" : "text-[14px]"}`}
                  opacity={isNext || isShiftKey ? 0.95 : dimmed ? 0.3 : 0.7}
                >
                  {cap.label}
                </text>
              </g>
            );
          });
        })}

        {/* 线稿双手 —— 盖在键盘上，指尖落在基准键行 */}
        {showHands && (
          <KeyboardHands
            activeFinger={stroke?.finger ?? null}
            reaches={reaches}
            unitSize={UNIT}
            originX={PAD}
            homeRowY={HOME_ROW_Y}
          />
        )}
      </svg>

      <p className="mt-1.5 text-center text-xs text-muted">{hintOverride ?? hintText}</p>
    </div>
  );
}
