from typing import Annotated

from fastapi import Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.models import Agent, Project

DB = Annotated[AsyncSession, Depends(get_db)]


def require_manager(request: Request) -> str:
    user = request.session.get("user")
    if not user:
        raise HTTPException(401, "not logged in")
    return user


async def get_agent(agent_id: int, db: DB) -> Agent:
    agent = await db.get(Agent, agent_id)
    if agent is None:
        raise HTTPException(404, "agent not found")
    return agent


async def get_project(project_id: int, db: DB) -> Project:
    project = await db.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "project not found")
    return project


AgentDep = Annotated[Agent, Depends(get_agent)]
ProjectDep = Annotated[Project, Depends(get_project)]
