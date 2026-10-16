import { Phone } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, useLocation, useParams } from "react-router";
import { useSession } from "../App";
import { useActiveCall } from "../components/ActiveCall";

/**
 * /team/:id/call starts (or reopens) a call. The call itself is rendered by ActiveCallDock in the
 * layout, so it survives navigating to other pages.
 */
export default function Call() {
  const id = Number(useParams().id);
  const location = useLocation();
  const { call, start } = useActiveCall();
  const { agentById } = useSession();
  const callRef = useRef(call);
  callRef.current = call;

  // Decide once per visit: reopen this agent's call if it's live (or we came to see its notes), else dial.
  useEffect(() => {
    const c = callRef.current;
    const resume = (location.state as { resume?: boolean } | null)?.resume;
    if (c?.agentId === id && (c.live || resume)) return;
    start(id);
  }, [id, location.key, start]);

  if (call && call.agentId !== id && call.live) {
    const other = agentById(call.agentId);
    return (
      <div className="mx-auto max-w-md">
        <div className="card p-6 text-center">
          <Phone size={22} className="mx-auto text-muted" />
          <h1 className="mt-3 text-lg font-semibold">You're already on a call</h1>
          <p className="mt-1 text-sm text-muted">
            Hang up with {other?.name ?? "the other agent"} before calling {agentById(id)?.name ?? "someone else"}.
          </p>
          <Link to={`/team/${call.agentId}/call`} state={{ resume: true }} className="btn-primary mt-5">
            Return to call
          </Link>
        </div>
      </div>
    );
  }
  return null;
}
