import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI
from starlette.middleware.sessions import SessionMiddleware

from app.api import agents, mail, meetings, projects, system, tts
from app.api.deps import require_manager
from app.config import get_settings
from app.db import SessionLocal
from app.services import meetings as meeting_service
from app.services.seed import seed_roles

logging.basicConfig(level=logging.INFO)


@asynccontextmanager
async def lifespan(_: FastAPI):
    async with SessionLocal() as db:
        await seed_roles(db)
    reaper = asyncio.create_task(meeting_service.reap_idle())
    yield
    reaper.cancel()
    await meeting_service.end_all()


def create_app() -> FastAPI:
    s = get_settings()
    app = FastAPI(title="Git Team", lifespan=lifespan)
    app.add_middleware(SessionMiddleware, secret_key=s.secret_key, same_site="lax", max_age=60 * 60 * 24 * 14)

    auth = [Depends(require_manager)]
    for module in (agents, meetings, projects, system):
        app.include_router(module.router, prefix="/api", dependencies=auth)
    app.include_router(mail.router, prefix="/api", dependencies=auth)
    app.include_router(tts.router, prefix="/api", dependencies=auth)
    app.include_router(agents.public, prefix="/api")
    app.include_router(system.public, prefix="/api")

    @app.get("/api/health")
    async def health():
        return {"ok": True}

    return app


app = create_app()
