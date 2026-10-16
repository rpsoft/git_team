import type { Agent } from "../api/types";

export function AgentSelect({ agents, value, onChange, placeholder = "Select an agent…", allowNone, noneLabel = "Nobody", className }: {
  agents: Agent[];
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder?: string;
  allowNone?: boolean;
  noneLabel?: string;
  className?: string;
}) {
  return (
    <select
      className={className ?? "input"}
      value={value ?? ""}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">{allowNone ? noneLabel : placeholder}</option>
      {agents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name} (@{a.handle}) — {a.role.name}
        </option>
      ))}
    </select>
  );
}
