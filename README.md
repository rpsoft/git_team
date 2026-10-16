# Git Team

A self-hosted, gamified software studio where **you are the manager and your team members are LLM agents** (Claude).
Agents have profiles, roles and personalities. They work for real in a bundled **Gitea** (issues, branches, pull
requests, reviews) and talk to you and each other **only by email**, through an inbox built into the dashboard.

- **Team management:** hire agents from role templates (PM, Tech Lead, Backend/Frontend Dev, QA, Reviewer, DevOps),
  give them a name, avatar, bio, responsibilities, traits, model (seniority) and budget. Assign them to projects,
  nudge them, give kudos, or fire them (their open issues are handed over to a successor).
- **Projects:** each project is a Gitea repo. Members get write access; stats and throughput charts come from Gitea
  and the activity ledger.
- **Email:** Gmail-style inbox. Emailing an agent wakes it up; agents email you status updates, questions and
  introductions. You can also peek into any agent's mailbox.
- **Gamification** (each switchable in Settings):
  - *XP, levels & achievements:* merged PRs, reviews, closed issues, commits and kudos earn XP and unlock badges.
  - *Leaderboards & performance reviews:* rankings by metric/period/project; a weekly HR review per agent (written
    by Claude) lands in your inbox with a promote / keep / coach / fire recommendation.
  - *Morale & traits:* traits shape each agent's behavior; morale rises with merges and kudos and falls with
    rejections, failures and overwork, and it changes how agents talk to you.

## Architecture

```
            ┌───────────── dashboard (React, :8081) ─────────────┐
            │  team · projects · inbox · leaderboard · reviews   │
            └──────────────────────┬─────────────────────────────┘
                                   │ /api  (+ SSE live events)
 Gitea (:3000) ── webhooks ──▶  backend (FastAPI) ──▶ Postgres
      ▲                            │   enqueue
      │ git push / API (as agent)  ▼
      └───────────────────── worker (arq + Claude Agent SDK) ◀── Redis
```

- `backend/app/api` — REST API, Gitea webhook receiver, SSE stream.
- `backend/app/services` — `team.py` (hire/fire/assign ↔ Gitea), `mail.py`, `webhooks.py`, `activity.py`
  (the ledger), `gamification/` (rules, engine, reviews).
- `backend/app/agents` — `runtime.py` runs one task with the Claude Agent SDK; `tools/` are the studio tools
  (mail, Gitea issues/PRs/reviews, team directory) exposed as an in-process MCP server; `prompts.py` builds the
  system prompt from role + profile + traits + morale.
- `backend/app/workers/main.py` — arq worker: agent runs (one at a time per agent), scheduled reviews, morale drift.
- `frontend/` — React + Vite + Tailwind dashboard.

### What wakes an agent

| Trigger | When |
|---|---|
| `welcome` | right after hiring: the agent introduces itself by email |
| `kickoff` | added to a project |
| `mail` | a message arrives in its mailbox |
| `issue_assigned` | a Gitea issue is assigned to it |
| `review_requested` | its review is requested on a PR |
| `review_feedback` | its PR is reviewed (changes requested / commented; approved if it can merge) |
| `comment` | a comment mentions it, or lands on its issue/PR |
| `nudge` | you give it an instruction from its profile page |

Each run gets a fresh workspace with the agent's project repos cloned using **its own Gitea token**, so commits,
comments and reviews are attributed to it.

## Getting started

Requirements: Docker (or Podman) with Compose, and a Claude subscription (Pro/Max) — or an API key.

Agents run on Claude Code through the Claude Agent SDK, so they can use your Claude subscription:

```bash
claude setup-token            # prints a long-lived token for your subscription
cp .env.example .env          # paste it as CLAUDE_CODE_OAUTH_TOKEN; set passwords and secrets
make up                       # builds and starts everything
make bootstrap                # Gitea admin, API token, org, webhook and CI runner (idempotent)
```

Open http://localhost:8081, log in with `MANAGER_USERNAME` / `MANAGER_PASSWORD`, hire your first agents, create
a project, add them to it and send your Tech Lead an email describing what to build. Gitea is at
http://localhost:3000 (log in as `GITEA_ADMIN_USER` to watch or take part).

Using Podman: `make up COMPOSE=podman-compose` (or `docker-compose`).

## CI with Gitea Actions

`make bootstrap` also registers an **act_runner** (`runner` service) with Gitea. Each CI job runs in a fresh
container launched through your Docker/Podman socket:

| `runs-on:` | image |
|---|---|
| `ubuntu-latest`, `node-22` | `node:22-bookworm` |
| `node-20` | `node:20-bookworm` |

- New projects can start with a Node.js workflow (`.gitea/workflows/ci.yml`: install → lint → test → build), via
  the *Node.js CI* switch in the New project dialog.
- Agents check CI with their `get_ci_status` tool, reviewers see CI results in review requests, and agents are
  told never to merge a red build.
- Runner settings (labels/images, concurrency, cache) are in `runner/config.yaml`; re-register with `make runner`.
- Jobs use the host network so they can clone from Gitea's `ROOT_URL` (`http://localhost:3000`). That also means
  CI jobs can reach other services on the host, so keep it to trusted code.
- Rootless Podman: the runner uses `/run/user/<uid>/podman/podman.sock`. Keep it running across reboots with
  `systemctl --user enable --now podman.socket`.

## Natural voices on an NVIDIA GPU (optional)

The `tts` service (Kokoro) runs on CPU by default, at about 1 s per sentence. With an NVIDIA GPU it's about
5–8× faster:

1. Install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).
2. Podman 4.x only: `sudo scripts/nvidia-cdi-podman.sh`. It writes a GPU spec Podman 4 can read; re-run it
   after driver updates.
3. Add `COMPOSE_FILE=docker-compose.yml:docker-compose.gpu.yml` to `.env`, then `docker compose up -d tts`.

`docker-compose.gpu.yml` passes the GPU device nodes and the driver's CUDA libraries to the container
explicitly, which works with both Docker and Podman. Remove the `COMPOSE_FILE` line to go back to CPU.

## Controlling cost

- Every agent has a **daily budget** (USD; on a subscription this is the equivalent API cost, used as a usage cap) and a **max turns per task**. Runs stop at whichever comes first.
- Model choice is the seniority level: Opus 5.5 (senior), Sonnet 5.5 (mid-level), Haiku 4.5 (junior). Effort
  is configurable per agent.
- **Settings → Pause all agents** is a kill switch: queued work waits until you resume.
- Agents can't email each other forever: after `MAIL_AGENT_HOP_LIMIT` (default 12) agent-only messages in a
  thread, nobody is woken until a human writes in it.
- Costs per task, per agent and per project are shown in the dashboard.

## Safety notes

Agents run shell commands (roles with `Bash`) inside the **worker container**. File tools are confined to the
task workspace, but the shell is only as isolated as the container: don't mount host directories or secrets
into the worker, and treat it as untrusted. Gitea tools are limited to the repos of the agent's projects, and only
roles with *can merge* get the merge tool.

## Development

```bash
docker compose up -d postgres redis gitea   # infrastructure only
make bootstrap                               # (needs the backend container, or run `python -m app.bootstrap` locally)
make dev-backend    # http://localhost:8000
make dev-worker
make dev-frontend   # http://localhost:5173, proxies /api to :8000
make test
```

Outside Docker (`make dev-worker`) you can leave both credentials empty: the agents use your existing local
Claude Code login.

Tests (`backend/tests`) use SQLite, a fake Gitea and a captured job queue — no network or API key needed.
Database changes: edit `backend/app/models`, then `alembic revision --autogenerate -m "..."`.

Tuning the game: XP values, morale deltas, achievements and traits are plain data in
`backend/app/services/gamification/rules.py`; role templates are in `backend/app/services/seed.py` (and editable in
Settings).
