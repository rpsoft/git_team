import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { qk } from "../api/queries";
import type { LiveEvent, Settings } from "../api/types";
import { useToast } from "../components/Toasts";

export type LiveStatus = "connecting" | "open" | "closed";

interface Options {
  enabled: boolean;
  managerAddress?: string;
  resolveName?: (address: string) => string;
}

/**
 * Subscribes to GET /api/events (Server-Sent Events) and keeps react-query caches fresh.
 * Invalidations are batched (250ms) so bursts of events don't stampede the API.
 */
export function useEvents({ enabled, managerAddress, resolveName }: Options): LiveStatus {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<LiveStatus>("connecting");

  // Keep latest callbacks without reconnecting.
  const ctx = useRef({ managerAddress, resolveName, toast });
  ctx.current = { managerAddress, resolveName, toast };

  useEffect(() => {
    if (!enabled) return;
    const pending = new Map<string, QueryKey>();
    let timer: number | undefined;

    const invalidate = (...keys: QueryKey[]) => {
      for (const k of keys) pending.set(JSON.stringify(k), k);
      if (timer === undefined) {
        timer = window.setTimeout(() => {
          timer = undefined;
          const keys = [...pending.values()];
          pending.clear();
          for (const key of keys) qc.invalidateQueries({ queryKey: key });
        }, 250);
      }
    };

    const agentKeys = (agentId?: number | null): QueryKey[] =>
      agentId ? [qk.agentsAll, qk.agent(agentId)] : [qk.agentsAll];

    const handle = (ev: LiveEvent) => {
      const { managerAddress: me, resolveName: name, toast: t } = ctx.current;
      switch (ev.type) {
        case "mail": {
          invalidate(["mail"], qk.overview);
          if (me && ev.recipients?.includes(me) && ev.sender !== me) {
            t.push({
              title: `New mail from ${name?.(ev.sender) ?? ev.sender}`,
              message: ev.subject,
              kind: "info",
            });
          }
          break;
        }
        case "activity":
          invalidate(["activity"], qk.overview, ...agentKeys(ev.agent_id), ["leaderboard"]);
          if (ev.project_id) invalidate(qk.project(ev.project_id), qk.projects);
          if (ev.kind === "project_created" || ev.kind === "assigned" || ev.kind === "unassigned") invalidate(qk.projects);
          if (ev.kind === "hired" || ev.kind === "fired") invalidate(qk.directory, qk.projects);
          if (ev.kind === "review_written" || ev.kind?.includes("review")) invalidate(["reviews"]);
          break;
        case "task":
          invalidate(qk.tasks, qk.task(ev.task_id), qk.overview, ...agentKeys(ev.agent_id));
          break;
        case "xp":
        case "morale":
          invalidate(...agentKeys(ev.agent_id), ["leaderboard"], qk.overview);
          break;
        case "toast":
          t.push({ title: ev.title, message: ev.message, icon: ev.icon, kind: "celebrate" });
          invalidate(["reviews"]);
          break;
        case "settings": {
          const { type: _type, ...settings } = ev;
          qc.setQueryData<Settings>(qk.settings, settings as Settings);
          break;
        }
        default:
          break;
      }
    };

    let es: EventSource | null = null;
    let retry: number | undefined;
    let closed = false;

    const connect = () => {
      setStatus("connecting");
      es = new EventSource("/api/events", { withCredentials: true });
      es.onopen = () => setStatus("open");
      es.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data) as LiveEvent;
          if (data && typeof data === "object" && "type" in data) handle(data);
        } catch {
          /* ignore malformed events */
        }
      };
      es.onerror = () => {
        // EventSource retries on its own unless the connection was refused (e.g. 401).
        if (es?.readyState === EventSource.CLOSED && !closed) {
          setStatus("closed");
          retry = window.setTimeout(connect, 5000);
        } else {
          setStatus("connecting");
        }
      };
    };
    connect();

    return () => {
      closed = true;
      es?.close();
      if (retry) window.clearTimeout(retry);
      if (timer) window.clearTimeout(timer);
    };
  }, [enabled, qc]);

  return status;
}
