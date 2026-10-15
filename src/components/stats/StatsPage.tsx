import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { BarChart3, Loader2, Trash2 } from "lucide-react";
import type { PracticeSession } from "@/types/stats";
import {
  formatDuration,
  formatSessionTime,
  summarize,
} from "@/lib/stats";
import { StatTile } from "./StatTile";
import { WpmTrendChart } from "./WpmTrendChart";

/** 图上最多画这么多个点 —— 再多就挤成一条实心带，看不出趋势。 */
const MAX_CHART_POINTS = 60;
/** 下面列表最多列这么多条。 */
const MAX_LISTED = 30;

/**
 * 统计页：把每次练完一章的记录汇成「有没有进步」这一个问题。
 *
 * 图表只画速度一条线；平均/最快/总时长这些单值用数字块呈现，
 * 不硬塞进同一个坐标系（双 y 轴是最常见的图表错误）。
 */
export function StatsPage() {
  const [sessions, setSessions] = useState<PracticeSession[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmingClear, setConfirmingClear] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const rows = await invoke<PracticeSession[]>("get_sessions", { limit: 500 });
      setSessions(rows);
    } catch (err) {
      console.error("读取练习历史失败:", err);
      setError("读取练习历史失败");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleClear = useCallback(async () => {
    try {
      await invoke("clear_sessions");
      setSessions([]);
    } catch (err) {
      console.error("清空练习历史失败:", err);
      setError("清空失败，请重试");
    } finally {
      setConfirmingClear(false);
    }
  }, []);

  // DB 按时间倒序返回；图表要正序（左旧右新），列表保持倒序。
  const chronological = useMemo(
    () => [...sessions].reverse().slice(-MAX_CHART_POINTS),
    [sessions],
  );
  const summary = useMemo(() => summarize(sessions), [sessions]);
  const listed = sessions.slice(0, MAX_LISTED);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-8 py-10">
        <header className="mb-6">
          <div className="flex items-center gap-3">
            <BarChart3 size={22} className="text-accent" />
            <h1 className="text-2xl font-bold text-ink font-serif">统计</h1>
          </div>
          <p className="mt-1 text-sm text-muted">
            每练完一章都会记一笔，这里是你的进步曲线
          </p>
        </header>

        {isLoading && (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <Loader2 size={22} className="animate-spin text-accent" />
            <p className="text-sm text-muted">正在读取…</p>
          </div>
        )}

        {!isLoading && error && (
          <div className="rounded-lg border border-error/30 bg-error/[0.06] px-4 py-3 text-sm text-ink">
            {error}
          </div>
        )}

        {!isLoading && !error && sessions.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 gap-4">
            <BarChart3 size={38} className="text-muted/40" />
            <p className="text-sm text-muted">还没有练习记录</p>
            <p className="text-xs text-muted/80">
              去书架挑一本，把一章打完整，这里就会有数据
            </p>
          </div>
        )}

        {!isLoading && !error && sessions.length > 0 && (
          <>
            {/* 数字块：单值不画图 */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <StatTile
                label="平均速度"
                value={`${summary.avgWpm}`}
                hint="字 / 分"
              />
              <StatTile
                label="最快"
                value={`${summary.bestWpm}`}
                hint="字 / 分"
              />
              <StatTile
                label="平均准确率"
                value={`${summary.avgAccuracy}%`}
                hint={`共 ${summary.count} 次练习`}
              />
              <StatTile
                label="累计时长"
                value={formatDuration(summary.totalSeconds)}
                hint={`${summary.totalChars} 字`}
              />
            </div>

            {/* 速度曲线 */}
            <section className="mb-6 p-4 rounded-xl bg-surface border border-gray-200/60 dark:border-gray-700/40">
              <h2 className="text-sm font-semibold text-ink mb-3">
                速度变化
                <span className="ml-2 text-xs font-normal text-muted">
                  最近 {chronological.length} 次
                </span>
              </h2>
              {chronological.length < 2 ? (
                <p className="py-8 text-center text-xs text-muted">
                  至少练完两次才有曲线可看
                </p>
              ) : (
                <WpmTrendChart sessions={chronological} />
              )}
            </section>

            {/* 明细表 —— 同时也是图表的「表格视图」，方便读具体数值 */}
            <section>
              <div className="flex items-center justify-between mb-3">
                <h2 className="text-sm font-semibold text-ink">练习记录</h2>
                {confirmingClear ? (
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-muted">确定清空全部记录？</span>
                    <button
                      onClick={handleClear}
                      className="px-2.5 py-1 rounded-md bg-error text-white text-xs font-medium hover:opacity-90 transition-opacity cursor-pointer"
                    >
                      清空
                    </button>
                    <button
                      onClick={() => setConfirmingClear(false)}
                      className="px-2.5 py-1 rounded-md bg-surface-alt text-ink text-xs font-medium hover:bg-surface-hover transition-colors cursor-pointer"
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => setConfirmingClear(true)}
                    className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs text-muted hover:text-error hover:bg-error/[0.06] transition-colors cursor-pointer"
                  >
                    <Trash2 size={13} />
                    清空
                  </button>
                )}
              </div>

              <div className="rounded-xl bg-surface border border-gray-200/60 dark:border-gray-700/40 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[10px] tracking-[0.12em] uppercase text-muted">
                      <th className="text-left font-medium px-4 py-2">时间</th>
                      <th className="text-left font-medium px-3 py-2">章节</th>
                      <th className="text-right font-medium px-3 py-2">速度</th>
                      <th className="text-right font-medium px-3 py-2">准确率</th>
                      <th className="text-right font-medium px-3 py-2">时长</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listed.map((s) => (
                      <tr
                        key={s.id}
                        className="border-t border-gray-200/50 dark:border-gray-700/30"
                      >
                        <td className="px-4 py-2 text-xs text-muted whitespace-nowrap tabular-nums">
                          {formatSessionTime(s.createdAt)}
                        </td>
                        <td className="px-3 py-2 text-ink">
                          <span className="line-clamp-1">{s.chapterTitle || s.bookTitle}</span>
                          {s.isDrill && (
                            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded bg-accent/10 text-accent align-middle">
                              错字重练
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right text-ink tabular-nums">
                          {Math.round(s.wpm)}
                        </td>
                        <td className="px-3 py-2 text-right text-muted tabular-nums">
                          {s.accuracy}%
                        </td>
                        <td className="px-3 py-2 text-right text-muted tabular-nums whitespace-nowrap">
                          {formatDuration(s.durationSeconds)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {sessions.length > MAX_LISTED && (
                <p className="mt-2 text-xs text-muted">
                  仅显示最近 {MAX_LISTED} 条，共 {sessions.length} 条
                </p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
