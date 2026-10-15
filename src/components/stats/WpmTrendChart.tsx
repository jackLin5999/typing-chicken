import { useMemo, useRef, useState } from "react";
import type { PracticeSession } from "@/types/stats";
import { formatSessionTime } from "@/lib/stats";

interface WpmTrendChartProps {
  /** 按时间**正序**（旧 → 新）。画图时左边是过去，右边是现在。 */
  sessions: PracticeSession[];
}

const W = 640;
const H = 180;
const PAD = { top: 16, right: 18, bottom: 26, left: 42 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** 把最大值抬到一个好看的刻度（20 / 50 / 100…），免得 y 轴顶着数字。 */
function niceMax(value: number): number {
  if (value <= 0) return 20;
  const steps = [20, 40, 60, 80, 100, 120, 160, 200, 250, 300, 400];
  return steps.find((s) => s >= value) ?? Math.ceil(value / 100) * 100;
}

/**
 * WPM 进步曲线。
 *
 * 只有一条序列，所以按规范**不需要图例** —— 标题已经说明它是什么，
 * 颜色也只用主题的 accent 一个。坐标轴和网格一律弱化（muted + 低透明度），
 * 数据点只给「最快的一次」和「最近一次」直接标注，不是每个点都写数字。
 */
export function WpmTrendChart({ sessions }: WpmTrendChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hovered, setHovered] = useState<number | null>(null);

  const { points, maxWpm, bestIndex, d } = useMemo(() => {
    const peak = niceMax(Math.max(...sessions.map((s) => s.wpm), 0));
    const n = sessions.length;

    const pts = sessions.map((session, i) => ({
      session,
      x: PAD.left + (n === 1 ? PLOT_W / 2 : (i / (n - 1)) * PLOT_W),
      y: PAD.top + PLOT_H - (session.wpm / peak) * PLOT_H,
    }));

    const path = pts
      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
      .join(" ");

    let best = 0;
    pts.forEach((p, i) => {
      if (p.session.wpm > pts[best].session.wpm) best = i;
    });

    return { points: pts, maxWpm: peak, bestIndex: best, d: path };
  }, [sessions]);

  // 鼠标 → 最近的数据点。按 SVG 的实际渲染尺寸换算，viewBox 是等比缩放的。
  const handleMove = (e: React.MouseEvent<SVGRectElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const svgX = ((e.clientX - rect.left) / rect.width) * W;

    let nearest = 0;
    let bestDist = Infinity;
    points.forEach((p, i) => {
      const dist = Math.abs(p.x - svgX);
      if (dist < bestDist) {
        bestDist = dist;
        nearest = i;
      }
    });
    setHovered(nearest);
  };

  const lastIndex = points.length - 1;
  // 只挑两个点直接标注；重合时只留最后一个
  const labelled = bestIndex === lastIndex ? [lastIndex] : [bestIndex, lastIndex];
  const active = hovered ?? lastIndex;
  const activePoint = points[active];

  const yTicks = [0, maxWpm / 2, maxWpm];

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto text-muted"
        role="img"
        aria-label={`最近 ${sessions.length} 次练习的速度变化，最快 ${Math.round(
          Math.max(...sessions.map((s) => s.wpm), 0),
        )} 字/分`}
      >
        {/* 网格与 y 轴刻度 —— 全部弱化，不与数据抢注意力 */}
        {yTicks.map((tick) => {
          const y = PAD.top + PLOT_H - (tick / maxWpm) * PLOT_H;
          return (
            <g key={tick}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={y}
                y2={y}
                stroke="currentColor"
                strokeWidth={1}
                opacity={tick === 0 ? 0.28 : 0.12}
              />
              <text
                x={PAD.left - 8}
                y={y + 3}
                textAnchor="end"
                className="fill-current text-[10px] tabular-nums"
                opacity={0.7}
              >
                {Math.round(tick)}
              </text>
            </g>
          );
        })}

        {/* 悬停竖线 */}
        {activePoint && (
          <line
            x1={activePoint.x}
            x2={activePoint.x}
            y1={PAD.top}
            y2={PAD.top + PLOT_H}
            stroke="currentColor"
            strokeWidth={1}
            opacity={0.25}
          />
        )}

        {/* 折线本体：2px，主题 accent */}
        {points.length > 1 && (
          <path
            d={d}
            fill="none"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-accent"
            stroke="currentColor"
          />
        )}

        {/* 直接标注：只给最快的一次和最近一次 */}
        {labelled.map((i) => {
          const p = points[i];
          if (!p) return null;
          const above = p.y > PAD.top + 14;
          return (
            <g key={i}>
              <circle cx={p.x} cy={p.y} r={3.5} className="text-accent" fill="currentColor" />
              <text
                x={p.x}
                y={above ? p.y - 8 : p.y + 15}
                textAnchor={i === lastIndex ? "end" : i === 0 ? "start" : "middle"}
                className="fill-current text-[10px] font-medium tabular-nums text-ink"
              >
                {Math.round(p.session.wpm)}
              </text>
            </g>
          );
        })}

        {/* x 轴：只标首尾两个时间，避免挤成一团 */}
        {points.length > 1 && (
          <>
            <text
              x={PAD.left}
              y={H - 8}
              textAnchor="start"
              className="fill-current text-[10px]"
              opacity={0.7}
            >
              {formatSessionTime(points[0].session.createdAt)}
            </text>
            <text
              x={W - PAD.right}
              y={H - 8}
              textAnchor="end"
              className="fill-current text-[10px]"
              opacity={0.7}
            >
              {formatSessionTime(points[lastIndex].session.createdAt)}
            </text>
          </>
        )}

        {/* 悬停命中层 —— 比数据点大得多，鼠标不用瞄准 */}
        <rect
          x={PAD.left}
          y={PAD.top}
          width={PLOT_W}
          height={PLOT_H}
          fill="transparent"
          onMouseMove={handleMove}
          onMouseLeave={() => setHovered(null)}
        />
      </svg>

      {/* 悬停提示 */}
      {hovered !== null && activePoint && (
        <div
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-full rounded-md bg-surface-alt px-2 py-1 shadow-md border border-gray-200/60 dark:border-gray-700/40 whitespace-nowrap"
          style={{
            left: `${(activePoint.x / W) * 100}%`,
            top: `${(activePoint.y / H) * 100}%`,
          }}
        >
          <div className="text-[11px] font-semibold text-ink tabular-nums">
            {Math.round(activePoint.session.wpm)} 字/分 · {activePoint.session.accuracy}%
          </div>
          <div className="text-[10px] text-muted">
            {formatSessionTime(activePoint.session.createdAt)}
          </div>
        </div>
      )}
    </div>
  );
}
