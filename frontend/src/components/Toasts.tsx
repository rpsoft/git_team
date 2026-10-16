import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { iconFor } from "../lib/icons";
import { cn } from "../lib/format";

export type ToastKind = "info" | "success" | "error" | "celebrate";

export interface ToastInput {
  title: string;
  message?: string;
  kind?: ToastKind;
  icon?: string;
  duration?: number;
}

interface ToastItem extends ToastInput {
  id: number;
}

interface ToastApi {
  push: (t: ToastInput) => void;
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast outside ToastProvider");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);

  const push = useCallback(
    (t: ToastInput) => {
      const id = nextId.current++;
      setItems((xs) => [...xs.slice(-4), { ...t, id }]);
      window.setTimeout(() => dismiss(id), t.duration ?? (t.kind === "celebrate" ? 7000 : 5000));
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (title, message) => push({ title, message, kind: "success" }),
      error: (title, message) => push({ title, message, kind: "error" }),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {items.map((t) => (
          <Toast key={t.id} item={t} onClose={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function Toast({ item, onClose }: { item: ToastItem; onClose: () => void }) {
  const kind = item.kind ?? "info";
  const Icon =
    kind === "celebrate" ? iconFor(item.icon ?? "trophy")
    : kind === "success" ? CheckCircle2
    : kind === "error" ? AlertCircle
    : Info;
  const tone = {
    info: "text-accent bg-accent-soft",
    success: "text-success bg-success/10",
    error: "text-danger bg-danger/10",
    celebrate: "text-black",
  }[kind];
  return (
    <div
      className={cn(
        "card pointer-events-auto flex animate-slide-in items-start gap-3 p-3.5",
        kind === "celebrate" && "border-xp/40",
      )}
      role="status"
    >
      <span
        className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg", tone)}
        style={kind === "celebrate" ? { background: "linear-gradient(135deg, #fde68a, #f59e0b)" } : undefined}
      >
        <Icon size={18} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{item.title}</div>
        {item.message && <div className="mt-0.5 text-sm break-words text-muted">{item.message}</div>}
      </div>
      <button className="text-subtle hover:text-fg" onClick={onClose} aria-label="Dismiss">
        <X size={16} />
      </button>
    </div>
  );
}
