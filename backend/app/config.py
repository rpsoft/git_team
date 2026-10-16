from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://gitteam:gitteam@postgres:5432/gitteam"
    redis_url: str = "redis://redis:6379/0"

    # Manager (the human) login
    manager_username: str = "manager"
    manager_password: str = "change-me"
    manager_name: str = "The Manager"
    secret_key: str = "dev-secret-change-me"

    # Mail
    mail_domain: str = "team.local"

    # Gitea
    gitea_url: str = "http://gitea:3000"  # internal URL used by backend/worker
    gitea_public_url: str = "http://localhost:3000"  # URL shown to the browser
    gitea_admin_user: str = "studio-admin"
    gitea_admin_password: str = "change-me-too"
    gitea_org: str = "studio"
    gitea_webhook_secret: str = "webhook-secret"
    backend_internal_url: str = "http://backend:8000"  # what Gitea calls for webhooks

    # Agents run on Claude Code (via the Claude Agent SDK). Authenticate with ONE of:
    #  - claude_code_oauth_token: your Claude subscription (`claude setup-token`), or
    #  - anthropic_api_key: a Claude API key.
    # Leave both empty to use an existing local Claude Code login (non-Docker dev).
    claude_code_oauth_token: str = ""
    anthropic_api_key: str = ""
    default_model: str = "claude-opus-5-5"
    review_model: str = "claude-opus-5-5"
    # Kokoro TTS server (OpenAI-compatible /v1/audio/speech); empty disables natural voices.
    tts_url: str = "http://tts:8880"
    workspaces_dir: str = "/workspaces"
    data_dir: str = "/data"
    worker_max_jobs: int = 4
    # Stop agent<->agent email ping-pong after this many agent messages without a manager reply.
    mail_agent_hop_limit: int = 12

    def claude_env(self) -> dict[str, str]:
        """Credentials passed to the Claude Code process."""
        if self.claude_code_oauth_token:
            return {"CLAUDE_CODE_OAUTH_TOKEN": self.claude_code_oauth_token}
        if self.anthropic_api_key:
            return {"ANTHROPIC_API_KEY": self.anthropic_api_key}
        return {}

    @property
    def manager_address(self) -> str:
        return f"{self.manager_username}@{self.mail_domain}"

    @property
    def hr_address(self) -> str:
        return f"hr@{self.mail_domain}"


@lru_cache
def get_settings() -> Settings:
    return Settings()
