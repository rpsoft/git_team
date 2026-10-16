import { useQuery } from "@tanstack/react-query";
import { ClipboardCheck, Play } from "lucide-react";
import { useMemo, useState } from "react";
import { useSession } from "../App";
import { api } from "../api/client";
import { qk, useFeatures, useSettings } from "../api/queries";
import type { Agent } from "../api/types";
import { FireDialog, KudosDialog } from "../components/AgentDialogs";
import { ReviewCard } from "../components/ReviewCard";
import { Segmented } from "../components/Tabs";
import { useToast } from "../components/Toasts";
import { EmptyState, ErrorState, Loading, PageHeader, Spinner } from "../components/ui";
import { dateOnly, parseUtc } from "../lib/format";

type Filter = "all" | "promote" | "keep" | "coach" | "fire";

export default function Reviews() {
  const { agentById } = useSession();
  const features = useFeatures();
  const { data: settings } = useSettings();
  const toast = useToast();
  const q = useQuery({ queryKey: qk.reviews(), queryFn: () => api.reviews(undefined, 200) });
  const [running, setRunning] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [fire, setFire] = useState<Agent | null>(null);
  const [kudos, setKudos] = useState<Agent | null>(null);

  const groups = useMemo(() => {
    const out = new Map<string, NonNullable<typeof q.data>>();
    for (const r of q.data ?? []) {
      if (filter !== "all" && r.recommendation !== filter) continue;
      const key = parseUtc(r.created_at)?.toDateString() ?? r.created_at;
      if (!out.has(key)) out.set(key, []);
      out.get(key)!.push(r);
    }
    return [...out.entries()];
  }, [q.data, filter]);

  const run = async () => {
    setRunning(true);
    try {
      await api.runReviews();
      toast.success("Reviews queued", "HR is writing performance reviews. They’ll appear here shortly.");
    } catch (e) {
      toast.error("Could not start reviews", e instanceof Error ? e.message : undefined);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div>
      <PageHeader
        icon={<ClipboardCheck size={20} />}
        title="Performance reviews"
        subtitle={`Written by HR every ${settings?.review_period_days ?? 7} days from real activity. Act on them — or don’t.`}
        actions={
          <button className="btn-primary" onClick={run} disabled={running}>
            {running ? <Spinner className="text-accent-fg" /> : <Play size={15} />} Run reviews now
          </button>
        }
      />
      <Segmented<Filter>
        className="mb-5"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: "All" },
          { value: "promote", label: "Promote" },
          { value: "keep", label: "Keep" },
          { value: "coach", label: "Coach" },
          { value: "fire", label: "Fire" },
        ]}
      />
      {q.isPending && <Loading />}
      {q.isError && <ErrorState error={q.error} onRetry={() => q.refetch()} />}
      {q.data && !groups.length && (
        <EmptyState
          icon={<ClipboardCheck size={22} />}
          title={q.data.length ? "No reviews match this filter" : "No reviews yet"}
          description={q.data.length ? undefined : "Reviews are generated each period. Run them now to see how your team is doing."}
          action={!q.data.length && <button className="btn-primary" onClick={run} disabled={running}><Play size={15} /> Run reviews now</button>}
        />
      )}
      <div className="space-y-8">
        {groups.map(([day, reviews]) => (
          <section key={day}>
            <h2 className="mb-3 flex items-center gap-3 text-xs font-semibold tracking-wide text-muted uppercase">
              {dateOnly(reviews[0]!.created_at)}
              <span className="h-px flex-1 bg-border" />
              <span className="font-normal normal-case">{reviews.length} review{reviews.length === 1 ? "" : "s"}</span>
            </h2>
            <div className="grid gap-4 xl:grid-cols-2">
              {reviews.map((r) => {
                const agent = agentById(r.agent_id);
                return (
                  <ReviewCard
                    key={r.id}
                    review={r}
                    agent={agent}
                    canKudos={features.xp || features.morale}
                    onFire={agent ? () => setFire(agent) : undefined}
                    onKudos={agent ? () => setKudos(agent) : undefined}
                  />
                );
              })}
            </div>
          </section>
        ))}
      </div>
      {fire && <FireDialog agent={fire} open onClose={() => setFire(null)} />}
      {kudos && <KudosDialog agent={kudos} open onClose={() => setKudos(null)} />}
    </div>
  );
}
