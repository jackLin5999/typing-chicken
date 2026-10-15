interface StatTileProps {
  label: string;
  value: string;
  /** 小字补充说明（可选），例如「共 12 次练习」。 */
  hint?: string;
}

/**
 * 一个数字块。统计数据里「一眼看到的那个数」用块比用图表更直接 ——
 * 平均速度这种单值不需要画图。
 */
export function StatTile({ label, value, hint }: StatTileProps) {
  return (
    <div className="flex flex-col gap-0.5 p-3 rounded-xl bg-surface-alt">
      <span className="text-[10px] tracking-[0.15em] uppercase text-muted font-medium">
        {label}
      </span>
      <span className="text-xl font-bold text-ink tabular-nums font-serif">
        {value}
      </span>
      {hint && <span className="text-[10px] text-muted">{hint}</span>}
    </div>
  );
}
