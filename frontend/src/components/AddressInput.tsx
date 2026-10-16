import { X } from "lucide-react";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useSession } from "../App";
import { useDirectory } from "../api/queries";
import { cn } from "../lib/format";
import { Avatar } from "./Avatar";

export function AddressInput({ value, onChange, placeholder, autoFocus }: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const { data: directory } = useDirectory();
  const { nameFor, agentByAddress } = useSession();
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const suggestions = useMemo(() => {
    const q = text.trim().toLowerCase();
    return (directory ?? [])
      .filter((d) => !value.includes(d.address))
      .filter((d) => !q || d.address.toLowerCase().includes(q) || d.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [directory, text, value]);

  const add = (address: string) => {
    const a = address.trim().toLowerCase().replace(/[,;]$/, "");
    if (!a) return;
    if (!value.includes(a)) onChange([...value, a]);
    setText("");
    setHighlight(0);
    inputRef.current?.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setOpen(true);
      setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (e.key === "Enter" || e.key === "Tab" || e.key === "," || e.key === ";") {
      if (open && suggestions[highlight] && (e.key === "Enter" || e.key === "Tab")) {
        e.preventDefault();
        add(suggestions[highlight].address);
      } else if (text.trim()) {
        e.preventDefault();
        add(text);
      }
    } else if (e.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className="relative">
      <div
        className="input flex min-h-10 cursor-text flex-wrap items-center gap-1.5 py-1.5"
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((a) => {
          const agent = agentByAddress(a);
          return (
            <span key={a} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-3 py-0.5 pr-1.5 pl-0.5 text-xs" title={a}>
              {agent ? <Avatar agent={agent} size={18} /> : <span className="ml-1" />}
              {nameFor(a) !== a ? nameFor(a) : a}
              <button
                type="button"
                className="text-subtle hover:text-fg"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(value.filter((x) => x !== a));
                }}
                aria-label={`Remove ${a}`}
              >
                <X size={12} />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          autoFocus={autoFocus}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setHighlight(0);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => {
            setOpen(false);
            if (text.includes("@")) add(text);
          }, 150)}
          onKeyDown={onKeyDown}
          placeholder={value.length ? "" : placeholder}
          className="min-w-[8rem] flex-1 bg-transparent py-0.5 text-sm outline-none placeholder:text-subtle"
        />
      </div>
      {open && suggestions.length > 0 && (
        <ul className="card absolute z-20 mt-1 max-h-64 w-full overflow-y-auto p-1">
          {suggestions.map((d, i) => {
            const agent = d.agent_id ? agentByAddress(d.address) : undefined;
            return (
              <li key={d.address}>
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => add(d.address)}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn("flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm", i === highlight && "bg-surface-3")}
                >
                  {agent ? (
                    <Avatar agent={agent} size={24} />
                  ) : (
                    <Avatar size={24} fallback={d.name.slice(0, 1)} />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{d.name}</span>
                    <span className="block truncate text-xs text-muted">{d.address}</span>
                  </span>
                  {agent && <span className="text-xs text-subtle">{agent.role.name}</span>}
                  {d.kind === "system" && <span className="text-xs text-subtle">system</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
