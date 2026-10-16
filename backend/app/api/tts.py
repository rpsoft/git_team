"""Natural voices for 1:1 calls: an authenticated proxy to the Kokoro TTS service."""

import time

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import get_settings

router = APIRouter(prefix="/tts")

# Kokoro voice ids look like "af_heart": language letter + f/m + name.
LANGUAGES = {"a": ("en-US", "American English"), "b": ("en-GB", "British English"), "e": ("es", "Spanish"),
             "f": ("fr", "French"), "h": ("hi", "Hindi"), "i": ("it", "Italian"), "j": ("ja", "Japanese"),
             "p": ("pt-BR", "Brazilian Portuguese"), "z": ("zh", "Mandarin Chinese")}
# Highest-rated voices first; automatic picks come from the top of each list.
PREFERRED = ["af_heart", "af_bella", "af_nicole", "af_sarah", "af_aoede", "af_kore", "bf_emma", "bf_isabella",
             "am_michael", "am_fenrir", "am_puck", "am_echo", "am_eric", "am_liam", "bm_george", "bm_fable",
             "bm_lewis", "bm_daniel"]

_cache: dict[str, object] = {"at": 0.0, "voices": None}


class SpeechIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    voice: str = Field(pattern=r"^[a-z]{2}_[a-z0-9_]+$")
    speed: float = Field(default=1.0, ge=0.5, le=2.0)


def describe(voice_id: str) -> dict | None:
    if len(voice_id) < 4 or voice_id[2] != "_" or "v0" in voice_id or voice_id[1] not in "fm":
        return None
    lang, lang_name = LANGUAGES.get(voice_id[0], ("", "Other"))
    label = voice_id[3:].replace("_inno", "").replace("_", " ").title()
    return {"id": voice_id, "label": label, "kind": "feminine" if voice_id[1] == "f" else "masculine",
            "lang": lang, "language": lang_name,
            "preferred": PREFERRED.index(voice_id) if voice_id in PREFERRED else None}


@router.get("/voices")
async def voices():
    """Available natural voices, or {"available": false} when the TTS service isn't running."""
    s = get_settings()
    if not s.tts_url:
        return {"available": False, "voices": []}
    if _cache["voices"] is not None and time.monotonic() - float(_cache["at"]) < 300:
        return {"available": True, "voices": _cache["voices"]}
    try:
        async with httpx.AsyncClient(timeout=5) as client:
            data = (await client.get(f"{s.tts_url.rstrip('/')}/v1/audio/voices")).json()
    except (httpx.HTTPError, ValueError):
        return {"available": False, "voices": []}
    ids = [v["id"] if isinstance(v, dict) else v for v in data.get("voices", [])]
    described = [d for d in (describe(i) for i in ids) if d]
    described.sort(key=lambda d: (d["preferred"] is None, d["preferred"] or 0, d["lang"], d["id"]))
    _cache.update(at=time.monotonic(), voices=described)
    return {"available": True, "voices": described}


@router.post("/speech")
async def speech(body: SpeechIn):
    """Synthesize one sentence to MP3, streamed through as Kokoro produces it."""
    s = get_settings()
    if not s.tts_url:
        raise HTTPException(503, "natural voices are disabled")
    client = httpx.AsyncClient(timeout=httpx.Timeout(60, connect=5))
    request = client.build_request("POST", f"{s.tts_url.rstrip('/')}/v1/audio/speech", json={
        "model": "kokoro", "input": body.text, "voice": body.voice, "speed": body.speed,
        "response_format": "mp3", "stream": True,
    })
    try:
        upstream = await client.send(request, stream=True)
    except httpx.HTTPError as e:
        await client.aclose()
        raise HTTPException(503, f"TTS service unavailable: {e}")
    if upstream.status_code != 200:
        detail = (await upstream.aread())[:300].decode(errors="replace")
        await upstream.aclose()
        await client.aclose()
        raise HTTPException(502, f"TTS failed: {detail}")

    async def relay():
        try:
            async for chunk in upstream.aiter_bytes():
                yield chunk
        finally:
            await upstream.aclose()
            await client.aclose()

    return StreamingResponse(relay(), media_type="audio/mpeg", headers={"Cache-Control": "no-store"})
