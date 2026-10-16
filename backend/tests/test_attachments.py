from pathlib import Path

from app.agents.tools import ToolContext
from app.models import Thread
from app.services import mail
from tests.test_team_api import hire

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


async def upload(client, name, data, ctype):
    r = await client.post("/api/mail/attachments", files={"file": (name, data, ctype)})
    assert r.status_code == 201, r.text
    return r.json()


async def test_send_with_attachments_and_download(client, db, tmp_path: Path):
    await hire(client)
    img = await upload(client, "screen shot.png", PNG, "image/png")
    doc = await upload(client, "spec.html", b"<script>alert(1)</script>", "text/html")
    assert img["is_image"] and not doc["is_image"]

    r = await client.post("/api/mail/send", json={"to": ["ada@team.local"], "subject": "Bug", "body": "",
                                                  "attachment_ids": [img["id"], doc["id"]]})
    assert r.status_code == 201, r.text
    assert [a["filename"] for a in r.json()["attachments"]] == ["screen shot.png", "spec.html"]

    thread_id = (await client.get("/api/mail/threads?folder=sent")).json()[0]["id"]
    summary = (await client.get("/api/mail/threads?folder=sent")).json()[0]
    assert summary["attachment_count"] == 2
    thread = (await client.get(f"/api/mail/threads/{thread_id}")).json()
    att = thread["messages"][0]["attachments"][0]

    got = await client.get(att["url"])
    assert got.status_code == 200 and got.content == PNG
    assert got.headers["content-disposition"].startswith("inline")
    html = await client.get(thread["messages"][0]["attachments"][1]["url"])
    assert html.headers["content-disposition"].startswith("attachment"), "active content is never inline"

    # an attachment can only be sent once
    again = await client.post("/api/mail/send", json={"to": ["ada@team.local"], "subject": "x", "body": "y",
                                                      "attachment_ids": [img["id"]]})
    assert again.status_code == 400

    # agents get the files in their workspace and see where they are
    t = await db.get(Thread, thread_id)
    assert mail.materialize(t, tmp_path) == 2
    assert (tmp_path / f"attachments/{img['id']}-screen shot.png").read_bytes() == PNG
    rendered = mail.render_thread(t, await mail.directory(db))
    assert f"./attachments/{img['id']}-screen shot.png (image/png" in rendered


async def test_empty_message_rejected(client):
    await hire(client)
    r = await client.post("/api/mail/send", json={"to": ["ada@team.local"], "subject": "x", "body": "  "})
    assert r.status_code == 400


async def test_agent_can_attach_workspace_files(client, db, tmp_path: Path):
    await hire(client)
    (tmp_path / "report.txt").write_text("all green")
    from app.agents import tools as tools_mod

    captured = {}
    orig = tools_mod.create_sdk_mcp_server

    def spy(name, version="1.0.0", tools=None):
        captured.update({t.name: t for t in tools})
        return orig(name=name, version=version, tools=tools)

    tools_mod.create_sdk_mcp_server = spy
    try:
        tools_mod.build_server(ToolContext(agent_id=1, handle="ada", gitea_username="ada", token_enc="x",
                                 can_merge=False, repos=set(), workspace=tmp_path))
    finally:
        tools_mod.create_sdk_mcp_server = orig

    send = captured["send_email"].handler
    ok = await send({"to": ["manager@team.local"], "subject": "Report", "body": "see attached",
                     "attachments": ["report.txt"]})
    assert "is_error" not in ok, ok
    bad = await send({"to": ["manager@team.local"], "subject": "x", "body": "y", "attachments": ["../../etc/passwd"]})
    assert bad.get("is_error")

    thread = (await client.get("/api/mail/threads")).json()[0]
    msg = (await client.get(f"/api/mail/threads/{thread['id']}")).json()["messages"][0]
    assert msg["attachments"][0]["filename"] == "report.txt"
