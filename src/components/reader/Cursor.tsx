/**
 * Animated typing cursor — a prominent vertical bar at the current position.
 */
export function Cursor() {
  return (
    <span
      className="
        absolute left-0 top-1/2 -translate-y-1/2
        w-[3px] h-[1.35em]
        bg-accent
        animate-cursor-blink
        rounded-full
        shadow-[0_0_6px_rgba(59,130,246,0.5)]
        dark:shadow-[0_0_8px_rgba(96,165,250,0.6)]
      "
      aria-hidden="true"
    />
  );
}
