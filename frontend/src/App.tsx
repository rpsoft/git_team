import { useQuery } from "@tanstack/react-query";
import { createContext, lazy, Suspense, useCallback, useContext, useMemo, type ReactNode } from "react";
import { Navigate, Route, Routes } from "react-router";
import { ApiError, api } from "./api/client";
import { qk, useAgents, useDirectory, useFeatures, useMeta } from "./api/queries";
import type { Agent, Me } from "./api/types";
import Layout from "./components/Layout";
import { Loading } from "./components/ui";
import { useEvents, type LiveStatus } from "./hooks/useEvents";
import Login from "./pages/Login";

const Overview = lazy(() => import("./pages/Overview"));
const Projects = lazy(() => import("./pages/Projects"));
const ProjectDetail = lazy(() => import("./pages/ProjectDetail"));
const Team = lazy(() => import("./pages/Team"));
const Hire = lazy(() => import("./pages/Hire"));
const AgentProfile = lazy(() => import("./pages/AgentProfile"));
const Call = lazy(() => import("./pages/Call"));
const Inbox = lazy(() => import("./pages/Inbox"));
const Leaderboard = lazy(() => import("./pages/Leaderboard"));
const Reviews = lazy(() => import("./pages/Reviews"));
const SettingsPage = lazy(() => import("./pages/Settings"));

interface Session {
  me: Me;
  live: LiveStatus;
  managerAddress: string;
  /** Display name for a mail address (agents, manager, system). */
  nameFor: (address: string) => string;
  /** Agent (active or fired) for an id or address, if known. */
  agentById: (id: number | null | undefined) => Agent | undefined;
  agentByAddress: (address: string) => Agent | undefined;
}

const SessionContext = createContext<Session | null>(null);

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}

function SessionProvider({ me, children }: { me: Me; children: ReactNode }) {
  const { data: meta } = useMeta();
  const { data: directory } = useDirectory();
  const { data: agents } = useAgents("all");
  const managerAddress = meta?.manager_address ?? me.email;

  const byId = useMemo(() => new Map((agents ?? []).map((a) => [a.id, a])), [agents]);
  const byAddress = useMemo(() => new Map((agents ?? []).map((a) => [a.email.toLowerCase(), a])), [agents]);
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of agents ?? []) m.set(a.email.toLowerCase(), a.name);
    for (const d of directory ?? []) m.set(d.address.toLowerCase(), d.name);
    m.set(managerAddress.toLowerCase(), me.name || "You");
    return m;
  }, [agents, directory, managerAddress, me.name]);

  const nameFor = useCallback((address: string) => names.get(address.toLowerCase()) ?? address, [names]);
  const live = useEvents({ enabled: true, managerAddress, resolveName: nameFor });

  const value = useMemo<Session>(
    () => ({
      me,
      live,
      managerAddress,
      nameFor,
      agentById: (id) => (id == null ? undefined : byId.get(id)),
      agentByAddress: (address) => byAddress.get(address.toLowerCase()),
    }),
    [me, live, managerAddress, nameFor, byId, byAddress],
  );
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

function FeatureRoute({ enabled, children }: { enabled: boolean; children: ReactNode }) {
  const { loaded } = useFeatures();
  if (!loaded) return <Loading />;
  return enabled ? <>{children}</> : <Navigate to="/" replace />;
}

function AuthedApp({ me }: { me: Me }) {
  const features = useFeatures();
  return (
    <SessionProvider me={me}>
      <Suspense fallback={<div className="flex h-full items-center justify-center"><Loading /></div>}>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<Overview />} />
          <Route path="projects" element={<Projects />} />
          <Route path="projects/:id" element={<ProjectDetail />} />
          <Route path="team" element={<Team />} />
          <Route path="team/hire" element={<Hire />} />
          <Route path="team/:id" element={<AgentProfile />} />
          <Route path="team/:id/call" element={<Call />} />
          <Route path="inbox" element={<Inbox />} />
          <Route
            path="leaderboard"
            element={<FeatureRoute enabled={features.leaderboard}><Leaderboard /></FeatureRoute>}
          />
          <Route
            path="reviews"
            element={<FeatureRoute enabled={features.leaderboard}><Reviews /></FeatureRoute>}
          />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="login" element={<Navigate to="/" replace />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
      </Suspense>
    </SessionProvider>
  );
}

export default function App() {
  const meQuery = useQuery({
    queryKey: qk.me,
    queryFn: async (): Promise<Me | null> => {
      try {
        return await api.me();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: Infinity,
    retry: 1,
  });

  if (meQuery.isPending) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loading label="Starting Git Team…" />
      </div>
    );
  }
  if (meQuery.isError) {
    return <Login offline error={meQuery.error} onRetry={() => meQuery.refetch()} />;
  }
  if (!meQuery.data) return <Login />;
  return <AuthedApp me={meQuery.data} />;
}
