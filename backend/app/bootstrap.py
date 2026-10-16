"""One-time Gitea setup: admin API token, the studio org, and the org-wide webhook.

Run after the Gitea admin user exists:  python -m app.bootstrap
Idempotent — safe to re-run.
"""

import asyncio
import secrets
import sys

from app.config import get_settings
from app.db import SessionLocal
from app.services.gitea import GiteaClient, GiteaError
from app.services.infra import decrypt, encrypt
from app.services.seed import seed_roles
from app.services.settings_store import get_setting, set_setting


async def main() -> int:
    s = get_settings()
    async with SessionLocal() as db:
        await seed_roles(db)
        stored = await get_setting(db, "gitea_admin_token")
        token = decrypt(stored) if stored else None
        if token:
            try:
                async with GiteaClient(token=token) as gc:
                    await gc.request("GET", "/user")
            except GiteaError:
                token = None
        if not token:
            async with GiteaClient(basic=(s.gitea_admin_user, s.gitea_admin_password)) as gc:
                token = (await gc.request("POST", f"/users/{s.gitea_admin_user}/tokens", json={
                    "name": f"studio-{secrets.token_hex(3)}", "scopes": ["all"],
                }))["sha1"]
            await set_setting(db, "gitea_admin_token", encrypt(token))
            await db.commit()
            print("✓ admin API token created")

        async with GiteaClient(token=token) as gc:
            await gc.ensure_org(s.gitea_org)
            print(f"✓ organization '{s.gitea_org}'")
            hook_url = f"{s.backend_internal_url.rstrip('/')}/api/webhooks/gitea"
            await gc.ensure_org_hook(s.gitea_org, hook_url, s.gitea_webhook_secret)
            print(f"✓ webhook → {hook_url}")
    print("Bootstrap complete.")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
