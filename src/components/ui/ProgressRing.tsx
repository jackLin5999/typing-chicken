/**
 * A circular SVG progress indicator.
 * Used on book cards and session summaries.
 */
interface ProgressRingProps {
  progress: number; // 0–100
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function ProgressRing({
  progress,
  size = 40,
  strokeWidth = 3,
  className = "",
}: ProgressRingProps) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (Math.min(progress, 100) / 100) * circumference;

  return (
    <svg
      width={size}
      height={size}
      className={`transform -rotate-90 ${className}`}
      aria-label={`${Math.round(progress)}% complete`}
    >
      {/* Background track */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        className="text-gray-200 dark:text-gray-700"
      />
      {/* Progress arc */}
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        className="text-accent transition-all duration-500 ease-out"
      />
      {progress >= 100 && (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          className="text-accent-correct"
        />
      )}
    </svg>
  );
}
