import type { PracticeSession } from "@/types/stats";

/**
 * SQLite 的 `datetime('now')` 存的是 **UTC**，格式 `YYYY-MM-DD HH:MM:SS`。
 * `new Date("2026-10-15 14:32:00")` 在多数浏览器里会被当成本地时间，
 * 差出整整一个时区 —— 所以要显式补上 `T` 和 `Z`。
 */
export function parseSessionDate(createdAt: string): Date {
  return new Date(`${createdAt.replace(" ", "T")}Z`);
}

/** 「10-15 14:32」这种紧凑写法，用在图表和列表里。 */
export function formatSessionTime(createdAt: string): string {
  const d = parseSessionDate(createdAt);
  if (Number.isNaN(d.getTime())) return createdAt;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 「1 小时 12 分」/「8 分 30 秒」这种给人看的时长。 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${Math.round(seconds % 60)} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

export interface StatsSummary {
  count: number;
  avgWpm: number;
  bestWpm: number;
  avgAccuracy: number;
  totalSeconds: number;
  totalChars: number;
}

/**
 * 汇总一批练习记录。
 *
 * 平均速度按**每次练习等权**算，而不是「总字数 ÷ 总时长」——
 * 后者会让一次很长的慢练习盖掉十次快的，看到的数不是「我一般多快」。
 */
export function summarize(sessions: PracticeSession[]): StatsSummary {
  if (sessions.length === 0) {
    return {
      count: 0,
      avgWpm: 0,
      bestWpm: 0,
      avgAccuracy: 0,
      totalSeconds: 0,
      totalChars: 0,
    };
  }

  const sum = sessions.reduce(
    (acc, s) => ({
      wpm: acc.wpm + s.wpm,
      accuracy: acc.accuracy + s.accuracy,
      seconds: acc.seconds + s.durationSeconds,
      chars: acc.chars + s.correctKeystrokes,
    }),
    { wpm: 0, accuracy: 0, seconds: 0, chars: 0 },
  );

  return {
    count: sessions.length,
    avgWpm: Math.round(sum.wpm / sessions.length),
    bestWpm: Math.round(Math.max(...sessions.map((s) => s.wpm))),
    avgAccuracy: Math.round((sum.accuracy / sessions.length) * 10) / 10,
    totalSeconds: sum.seconds,
    totalChars: sum.chars,
  };
}

/** 按天聚合，用于「今天练了多少」这类判断。 */
export function isToday(createdAt: string): boolean {
  const d = parseSessionDate(createdAt);
  if (Number.isNaN(d.getTime())) return false;
  const now = new Date();
  return (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  );
}
