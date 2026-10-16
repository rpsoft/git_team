COMPOSE ?= docker compose
-include .env
# Same defaults as backend/app/config.py, for values not set in .env
GITEA_ADMIN_USER ?= studio-admin
GITEA_ADMIN_PASSWORD ?= change-me-too
GITEA_PUBLIC_URL ?= http://localhost:3000
MAIL_DOMAIN ?= team.local
# Container engine socket for the CI runner: rootless Podman if present, else Docker's.
DOCKER_SOCKET ?= $(firstword $(wildcard /run/user/$(shell id -u)/podman/podman.sock) /var/run/docker.sock)
export

.PHONY: up down logs bootstrap runner test dev-backend dev-worker dev-frontend

up: .env
	@mkdir -p .runner
	$(COMPOSE) up -d --build
	@echo "Dashboard: http://localhost:8081   Gitea: $(GITEA_PUBLIC_URL)"

down:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f backend worker

.env:
	cp .env.example .env
	@echo "Created .env from .env.example — edit it (at least CLAUDE_CODE_OAUTH_TOKEN and passwords), then re-run."
	@exit 1

# Create the Gitea admin account, then the API token, org and webhook. Idempotent.
bootstrap:
	@until $(COMPOSE) exec -T gitea curl -sf http://localhost:3000/api/healthz >/dev/null; do echo "waiting for gitea..."; sleep 3; done
	-$(COMPOSE) exec -T -u git gitea gitea admin user create --admin \
		--username "$(GITEA_ADMIN_USER)" --password "$(GITEA_ADMIN_PASSWORD)" \
		--email "$(GITEA_ADMIN_USER)@$(MAIL_DOMAIN)" --must-change-password=false
	$(COMPOSE) exec -T backend python -m app.bootstrap
	@$(MAKE) --no-print-directory runner

# (Re)register the Gitea Actions runner. The token is only needed for the first registration.
runner:
	@mkdir -p .runner
	@$(COMPOSE) exec -T -u git gitea gitea actions generate-runner-token | tail -n1 | tr -d '\r' > .runner/token
	@test -s .runner/token || (echo "could not get a runner token from gitea" && exit 1)
	$(COMPOSE) up -d runner
	$(COMPOSE) restart runner
	@echo "✓ runner started — check Gitea → Site Administration → Actions → Runners"

test:
	cd backend && uv run pytest -q
	cd frontend && npx tsc --noEmit

# Local development without containers for the app (still needs postgres/redis/gitea from compose)
dev-backend:
	cd backend && DATABASE_URL=postgresql+asyncpg://gitteam:gitteam@localhost:5432/gitteam \
		REDIS_URL=redis://localhost:6379/0 GITEA_URL=http://localhost:3000 \
		uv run sh -c "alembic upgrade head && uvicorn app.main:app --reload"

dev-worker:
	cd backend && DATABASE_URL=postgresql+asyncpg://gitteam:gitteam@localhost:5432/gitteam \
		REDIS_URL=redis://localhost:6379/0 GITEA_URL=http://localhost:3000 \
		WORKSPACES_DIR=$(CURDIR)/.workspaces DATA_DIR=$(CURDIR)/.data \
		uv run arq app.workers.main.WorkerSettings

dev-frontend:
	cd frontend && npm run dev
