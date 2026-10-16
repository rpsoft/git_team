import { useQueryClient } from "@tanstack/react-query";
import { FolderGit2, LogIn, ServerCrash } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../api/client";
import { qk } from "../api/queries";
import { FormError, Spinner } from "../components/ui";

export default function Login({ offline, error: bootError, onRetry }: { offline?: boolean; error?: unknown; onRetry?: () => void }) {
  const qc = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const me = await api.login({ username, password });
      qc.setQueryData(qk.me, me);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden px-4 py-12">
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background:
            "radial-gradient(600px 300px at 20% 10%, rgb(124 108 255 / 0.25), transparent), radial-gradient(500px 300px at 80% 90%, rgb(34 211 238 / 0.18), transparent)",
        }}
      />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          <span
            className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-white shadow-lg"
            style={{ background: "linear-gradient(135deg, #7c6cff, #22d3ee)" }}
          >
            <FolderGit2 size={28} />
          </span>
          <h1 className="text-2xl font-bold tracking-tight">Git Team</h1>
          <p className="mt-1 text-sm text-muted">Manage your team of AI engineers.</p>
        </div>
        {offline ? (
          <div className="card p-6 text-center">
            <ServerCrash className="mx-auto mb-3 text-danger" />
            <div className="font-semibold">Can’t reach the backend</div>
            <p className="mt-1 text-sm text-muted">{bootError instanceof Error ? bootError.message : "The API is not responding."}</p>
            <button className="btn-secondary mt-4" onClick={onRetry}>Try again</button>
          </div>
        ) : (
          <form onSubmit={submit} className="card space-y-4 p-6">
            <label className="block">
              <span className="label">Username</span>
              <input className="input" autoFocus autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="block">
              <span className="label">Password</span>
              <input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <FormError error={error} />
            <button className="btn-primary w-full" disabled={busy || !username || !password}>
              {busy ? <Spinner className="text-accent-fg" /> : <LogIn size={16} />} Sign in
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
