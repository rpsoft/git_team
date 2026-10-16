/** Backend datetimes are naive UTC ISO strings; parse them as UTC. */
export function parseUtc(value: string | null | undefined): Date | null {
  if (!value) return null;
  const hasZone = /[zZ]|[+-]\d{2}:?\d{2}$/.test(value);
  const d = new Date(hasZone ? value : `${value}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function timeAgo(value: string | null | undefined): string {
  const d = parseUtc(value);
  if (!d) return "";
  const diff = (d.getTime() - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return "just now";
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), "day");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: abs > 86400 * 300 ? "numeric" : undefined });
}

/** Compact mail-list style time: "14:05" today, "Mar 3" otherwise. */
export function shortTime(value: string | null | undefined): string {
  const d = parseUtc(value);
  if (!d) return "";
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function dateTime(value: string | null | undefined): string {
  const d = parseUtc(value);
  if (!d) return "";
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export function dateOnly(value: string | null | undefined): string {
  const d = parseUtc(value);
  if (!d) return "";
  return d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

export function duration(start: string | null | undefined, end: string | null | undefined): string {
  const s = parseUtc(start);
  if (!s) return "";
  const e = parseUtc(end) ?? new Date();
  const secs = Math.max(0, Math.round((e.getTime() - s.getTime()) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

export function usd(value: number | null | undefined, digits = 2): string {
  const v = value ?? 0;
  return `$${v.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: Math.max(digits, v < 1 && v > 0 ? 3 : digits) })}`;
}

export function compact(value: number): string {
  return Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

export function slugifyHandle(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function titleCase(s: string): string {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
}

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function randomSeed(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Mirrors backend team.hire(): slugify, then "-" -> "." (e.g. "Ada Lovelace" -> "ada.lovelace"). */
export function normalizeHandle(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-/g, ".");
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
