FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl ripgrep \
    && rm -rf /var/lib/apt/lists/*
COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

# Agents run as an unprivileged user; their workspaces live on a dedicated volume.
RUN useradd --create-home --uid 1000 studio && mkdir -p /workspaces /data && chown studio /workspaces /data
WORKDIR /app
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY . .
RUN uv sync --frozen --no-dev && chown -R studio /app
ENV PATH="/app/.venv/bin:$PATH" PYTHONUNBUFFERED=1
USER studio

CMD ["sh", "-c", "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"]
