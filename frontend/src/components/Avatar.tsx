import { useDicebearUri } from "../lib/avatar";
import { cn } from "../lib/format";

export interface AvatarSource {
  name?: string;
  avatar_url?: string | null;
  avatar_style?: string;
  avatar_seed?: string;
  handle?: string;
}

interface Props {
  agent?: AvatarSource | null;
  size?: number;
  working?: boolean;
  dimmed?: boolean;
  ring?: string;
  className?: string;
  /** Text fallback (e.g. manager / system senders). */
  fallback?: string;
}

export function Avatar({ agent, size = 40, working, dimmed, ring, className, fallback }: Props) {
  const generated = useDicebearUri(
    agent?.avatar_style || "notionists",
    agent?.avatar_seed || agent?.handle || agent?.name || "x",
    !!agent && !agent.avatar_url,
  );
  const src = agent ? agent.avatar_url || generated : null;

  return (
    <span
      className={cn("relative inline-flex shrink-0", className)}
      style={{ width: size, height: size }}
      title={agent?.name}
    >
      {working && (
        <span
          className="absolute inset-0 animate-pulse-ring rounded-full bg-success/50"
          aria-hidden
        />
      )}
      {src ? (
        <img
          src={src}
          alt={agent?.name ?? ""}
          width={size}
          height={size}
          className={cn(
            "relative h-full w-full rounded-full border border-border bg-surface-3 object-cover",
            dimmed && "opacity-50 grayscale",
          )}
          style={ring ? { boxShadow: `0 0 0 2px var(--surface), 0 0 0 4px ${ring}` } : undefined}
          draggable={false}
        />
      ) : (
        <span
          className="relative flex h-full w-full items-center justify-center rounded-full border border-border bg-surface-3 font-semibold text-muted"
          style={{ fontSize: Math.max(10, size * 0.38) }}
        >
          {agent ? "" : fallback ?? "?"}
        </span>
      )}
      {working && (
        <span
          className="absolute right-0 bottom-0 block rounded-full border-2 border-surface bg-success"
          style={{ width: Math.max(8, size * 0.26), height: Math.max(8, size * 0.26) }}
          title="Working now"
        />
      )}
    </span>
  );
}

/** Plain dicebear preview image (hire wizard, avatar picker). */
export function DicebearImg({ styleName, seed, className, alt = "" }: { styleName: string; seed: string; className?: string; alt?: string }) {
  const uri = useDicebearUri(styleName, seed);
  return uri ? <img src={uri} alt={alt} className={className} draggable={false} /> : <span className={cn("block animate-pulse", className)} />;
}
