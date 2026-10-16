import { Search, UserPlus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useAgents, useRoles } from "../api/queries";
import { AgentCard } from "../components/AgentCard";
import { Segmented } from "../components/Tabs";
import { EmptyState, ErrorState, Loading, PageHeader } from "../components/ui";

type Filter = "active" | "fired";

export default function Team() {
  const [filter, setFilter] = useState<Filter>("active");
  const [q, setQ] = useState("");
  const [role, setRole] = useState<number | "">("");
  const { data, isPending, isError, error, refetch } = useAgents("all");
  const { data: roles } = useRoles();

  const counts = useMemo(() => ({
    active: (data ?? []).filter((a) => a.status === "active").length,
    fired: (data ?? []).filter((a) => a.status === "fired").length,
  }), [data]);

  const visible = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (data ?? [])
      .filter((a) => (filter === "active" ? a.status === "active" : a.status !== "active"))
      .filter((a) => role === "" || a.role.id === role)
      .filter((a) => !needle || a.name.toLowerCase().includes(needle) || a.handle.includes(needle) || a.role.name.toLowerCase().includes(needle));
  }, [data, filter, q, role]);

  return (
    <div>
      <PageHeader
        icon={<Users size={20} />}
        title="Team"
        subtitle="Your AI engineers. Click anyone to see their profile, work and mailbox."
        actions={<Link to="/team/hire" className="btn-primary"><UserPlus size={16} /> Hire</Link>}
      />
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Segmented<Filter>
          value={filter}
          onChange={setFilter}
          options={[
            { value: "active", label: <>Active <span className="text-subtle">{counts.active}</span></> },
            { value: "fired", label: <>Alumni <span className="text-subtle">{counts.fired}</span></> },
          ]}
        />
        <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
          <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-subtle" />
          <input className="input pl-9" placeholder="Search by name, handle, role…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <select className="input w-auto" value={role} onChange={(e) => setRole(e.target.value ? Number(e.target.value) : "")}>
          <option value="">All roles</option>
          {roles?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      {isPending && <Loading />}
      {isError && <ErrorState error={error} onRetry={() => refetch()} />}
      {data && !visible.length && (
        filter === "active" && counts.active === 0 ? (
          <EmptyState
            icon={<UserPlus size={22} />}
            title="No team yet — hire your first agent"
            description="Pick a role, give them a name and a face, and they’ll get a Gitea account and an email address."
            action={<Link to="/team/hire" className="btn-primary"><UserPlus size={16} /> Hire your first agent</Link>}
          />
        ) : (
          <EmptyState icon={<Users size={22} />} title={filter === "fired" && !counts.fired ? "No alumni" : "No matches"} description={filter === "fired" && !counts.fired ? "Agents you let go will appear here." : "Try a different search or role filter."} />
        )
      )}
      {visible.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {visible.map((a) => <AgentCard key={a.id} agent={a} />)}
        </div>
      )}
    </div>
  );
}
