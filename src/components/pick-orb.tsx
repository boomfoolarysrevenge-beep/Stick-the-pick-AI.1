import { Mic, Square } from "lucide-react";
import { cn } from "@/lib/utils";

export type OrbMode = "idle" | "listening" | "thinking" | "speaking";

type PickOrbProps = {
  mode: OrbMode;
  micOn: boolean;
  level: number;
  onToggle: () => void;
};

export function PickOrb({ mode, micOn, level, onToggle }: PickOrbProps) {
  const label = micOn ? "Turn off microphone" : "Turn on microphone";
  const bounce = micOn && (mode === "speaking" || mode === "listening") ? 0.02 + level * 0.04 : 0;

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={micOn}
      className={cn(
        "relative mx-auto flex h-[280px] w-[200px] items-end justify-center sm:h-[340px] sm:w-[240px]",
        "transition-transform duration-150 ease-out",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50",
        "active:scale-[0.98]",
        !micOn && mode === "idle" && "orb-breathe",
      )}
    >
      <span
        className={cn(
          "pointer-events-none absolute inset-x-6 bottom-2 top-4 rounded-[40%] border",
          micOn ? "border-live/50" : "border-border",
        )}
        aria-hidden="true"
      />
      <img
        src="/stick-the-pick.jpg"
        alt="Stick the Pick standing in the studio"
        className="relative z-10 h-full w-auto max-w-full object-contain object-bottom select-none"
        draggable={false}
        style={{
          transform: bounce ? `translateY(${bounce * -24}px)` : undefined,
          filter:
            mode === "thinking"
              ? "saturate(0.85) brightness(0.92)"
              : micOn
                ? "saturate(1.05)"
                : undefined,
        }}
      />
      <span
        className={cn(
          "absolute bottom-3 left-1/2 z-20 grid size-12 -translate-x-1/2 place-items-center rounded-full sm:size-14",
          "transition-colors duration-200",
          micOn && mode !== "speaking" ? "bg-live text-live-fg" : "bg-fg text-accent-fg",
          mode === "speaking" && "bg-accent text-accent-fg",
        )}
      >
        {micOn ? (
          <Square className="size-4 fill-current" strokeWidth={2} />
        ) : (
          <Mic className="size-5" strokeWidth={1.75} />
        )}
      </span>
    </button>
  );
}
