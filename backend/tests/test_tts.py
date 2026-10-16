import httpx
import respx

from app.api import tts


async def test_voices_are_described_and_filtered(client, monkeypatch):
    monkeypatch.setattr(tts, "_cache", {"at": 0.0, "voices": None})
    with respx.mock(assert_all_called=False) as mock:
        mock.get("http://tts:8880/v1/audio/voices").mock(return_value=httpx.Response(200, json={"voices": [
            {"id": "am_michael"}, {"id": "af_heart"}, {"id": "af_v0bella"}, {"id": "bm_atten_inno"}, {"id": "jf_alpha"}]}))
        mock.route(host="test").pass_through()
        data = (await client.get("/api/tts/voices")).json()
    assert data["available"] is True
    ids = [v["id"] for v in data["voices"]]
    assert ids[:2] == ["af_heart", "am_michael"], "preferred voices first"
    assert "af_v0bella" not in ids, "legacy v0 voices hidden"
    heart = data["voices"][0]
    assert heart == {"id": "af_heart", "label": "Heart", "kind": "feminine", "lang": "en-US",
                     "language": "American English", "preferred": 0}
    assert next(v for v in data["voices"] if v["id"] == "bm_atten_inno")["label"] == "Atten"


async def test_voices_unavailable_when_service_down(client, monkeypatch):
    monkeypatch.setattr(tts, "_cache", {"at": 0.0, "voices": None})
    with respx.mock(assert_all_called=False) as mock:
        mock.get("http://tts:8880/v1/audio/voices").mock(side_effect=httpx.ConnectError("down"))
        mock.route(host="test").pass_through()
        assert (await client.get("/api/tts/voices")).json() == {"available": False, "voices": []}


async def test_speech_proxies_audio(client):
    with respx.mock(assert_all_called=False) as mock:
        route = mock.post("http://tts:8880/v1/audio/speech").mock(return_value=httpx.Response(200, content=b"ID3mp3"))
        mock.route(host="test").pass_through()
        r = await client.post("/api/tts/speech", json={"text": "Hello there.", "voice": "af_heart"})
    assert r.status_code == 200 and r.content == b"ID3mp3" and r.headers["content-type"] == "audio/mpeg"
    sent = route.calls.last.request
    assert b'"voice":"af_heart"' in sent.content and b'"response_format":"mp3"' in sent.content
    bad = await client.post("/api/tts/speech", json={"text": "x", "voice": "../etc"})
    assert bad.status_code == 422
