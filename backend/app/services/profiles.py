"""Generates a fresh persona (full name + bio) for a new hire."""

import json
import random

from claude_agent_sdk import ClaudeAgentOptions, ResultMessage, query

from app.config import get_settings
from app.models import Role
from app.services.gamification.rules import TRAITS

PROFILE_MODEL = "claude-haiku-4-5"  # fast and cheap; this is a tiny creative task

PROFILE_SCHEMA = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "description": "First and last name"},
        "bio": {"type": "string", "description": "2-3 sentences, first person is NOT used"},
        "voice_type": {"type": "string", "enum": ["feminine", "masculine"],
                       "description": "Speaking voice that fits the persona you invented (used for voice calls)"},
    },
    "required": ["name", "bio", "voice_type"],
    "additionalProperties": False,
}

# Nudges for variety so repeated clicks don't converge on the same persona.
FLAVORS = [
    "grew up in a small coastal town", "switched careers from music", "started coding on a hand-me-down laptop",
    "came from a game studio", "spent years in fintech", "was an open-source maintainer", "studied physics",
    "worked at a scrappy startup", "taught programming bootcamps", "came from embedded systems",
    "was a data journalist", "worked in healthcare IT", "ran a one-person consultancy", "studied linguistics",
]


async def generate(role: Role, traits: list[str], taken_names: list[str]) -> dict[str, str]:
    trait_text = "; ".join(TRAITS.get(t, t) for t in traits) or "no particular traits chosen yet"
    prompt = (
        f"Invent a persona for a new {role.name} joining a software team.\n"
        f"Role: {role.description}\nPersonality: {trait_text}\n"
        f"Background hint: they {random.choice(FLAVORS)}.\n"
        f"Pick a realistic, culturally diverse full name (first + last). Avoid famous people and avoid these "
        f"names already on the team: {', '.join(taken_names) or 'none'}.\n"
        "Write a bio of 2-3 short sentences in the third person: a bit of backstory, what they're great at, "
        "and one human detail. No emojis, no quotes, under 60 words. Also choose the speaking voice "
        "(feminine or masculine) for this persona."
    )
    options = ClaudeAgentOptions(
        model=PROFILE_MODEL,
        effort="low",
        tools=[],
        setting_sources=[],
        max_turns=3,
        output_format={"type": "json_schema", "schema": PROFILE_SCHEMA},
        env=get_settings().claude_env(),
    )
    result: ResultMessage | None = None
    async for message in query(prompt=prompt, options=options):
        if isinstance(message, ResultMessage):
            result = message
    if result is None or result.is_error:
        raise RuntimeError(f"profile generation failed: {result.subtype if result else 'no result'}")
    data = result.structured_output if isinstance(result.structured_output, dict) else json.loads(result.result or "")
    return {"name": data["name"].strip(), "bio": data["bio"].strip(),
            "voice_type": data.get("voice_type") if data.get("voice_type") in ("feminine", "masculine") else "any"}
