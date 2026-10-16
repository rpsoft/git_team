"""Runtime settings stored in the DB (feature flags, limits), editable from the dashboard."""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Setting

DEFAULTS: dict[str, Any] = {
    # Gamification modules
    "feature_xp": True,  # XP, levels & achievements
    "feature_leaderboard": True,  # leaderboards & performance reviews
    "feature_morale": True,  # morale & traits
    # Operations
    "review_period_days": 7,
    "agents_paused": False,  # global kill switch: no new agent runs
    "voice_speed": 1.15,  # speaking rate in 1:1 calls (1.0 = normal)
    # Written by the bootstrap script
    "gitea_admin_token": None,
}

PUBLIC_KEYS = ["feature_xp", "feature_leaderboard", "feature_morale", "review_period_days", "agents_paused",
               "voice_speed"]


async def get_setting(db: AsyncSession, key: str) -> Any:
    row = await db.get(Setting, key)
    return row.value if row is not None else DEFAULTS.get(key)


async def set_setting(db: AsyncSession, key: str, value: Any) -> None:
    row = await db.get(Setting, key)
    if row is None:
        db.add(Setting(key=key, value=value))
    else:
        row.value = value


async def public_settings(db: AsyncSession) -> dict[str, Any]:
    return {k: await get_setting(db, k) for k in PUBLIC_KEYS}


async def feature_enabled(db: AsyncSession, feature: str) -> bool:
    return bool(await get_setting(db, f"feature_{feature}"))
