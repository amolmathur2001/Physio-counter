"""Physio Counter server: serves the phone web app and the AI endpoints."""

import base64
import hmac
import os
import time
from collections import defaultdict, deque
from pathlib import Path

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import ai

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"
IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/gif"}
MAX_IMAGE_BYTES = 5 * 1024 * 1024
MAX_TEXT_CHARS = 8000

# When set, every /api call must send this code (X-Access-Code header) so strangers can't spend AI credits.
ACCESS_CODE = os.environ.get("APP_ACCESS_CODE", "")
RATE_LIMIT = 40  # AI requests per client
RATE_WINDOW_SECONDS = 600

app = FastAPI(title="Physio Counter")
_recent_calls: dict[str, deque] = defaultdict(deque)


def _client_ip(request: Request) -> str:
    # Render and Cloudflare put the real client first in X-Forwarded-For.
    forwarded = request.headers.get("x-forwarded-for", "")
    return forwarded.split(",")[0].strip() or (request.client.host if request.client else "unknown")


@app.middleware("http")
async def guard_api(request: Request, call_next):
    if not request.url.path.startswith("/api/"):
        return await call_next(request)
    if ACCESS_CODE and not hmac.compare_digest(request.headers.get("x-access-code", ""), ACCESS_CODE):
        return JSONResponse(status_code=401, content={"detail": "Access code required."})
    if request.url.path != "/api/check":
        calls = _recent_calls[_client_ip(request)]
        now = time.monotonic()
        while calls and now - calls[0] > RATE_WINDOW_SECONDS:
            calls.popleft()
        if len(calls) >= RATE_LIMIT:
            return JSONResponse(status_code=429, content={"detail": "Too many AI requests, try again in a few minutes."})
        calls.append(now)
    return await call_next(request)


@app.get("/api/check")
async def check_access():
    return {"ok": True}


@app.exception_handler(ai.AIUnavailable)
async def _ai_unavailable(_: Request, exc: ai.AIUnavailable):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.exception_handler(ai.AIError)
async def _ai_error(_: Request, exc: ai.AIError):
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.post("/api/prescription", response_model=ai.Prescription)
async def read_prescription(text: str = Form(""), image: UploadFile | None = File(None)):
    content: list[dict] = []
    if image is not None and image.filename:
        if image.content_type not in IMAGE_TYPES:
            raise HTTPException(400, "Photo must be JPEG, PNG, WebP or GIF.")
        data = await image.read()
        if len(data) > MAX_IMAGE_BYTES:
            raise HTTPException(413, "Photo is too large (max 5 MB).")
        content.append({
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": image.content_type,
                "data": base64.standard_b64encode(data).decode("ascii"),
            },
        })
    text = text.strip()
    if len(text) > MAX_TEXT_CHARS:
        raise HTTPException(413, f"Text is too long (max {MAX_TEXT_CHARS} characters).")
    if text:
        content.append({"type": "text", "text": text})
    if not content:
        raise HTTPException(400, "Add the prescription text or a photo of it.")
    return await ai.read_prescription(content)


class CommandRequest(BaseModel):
    transcript: str = Field(min_length=1, max_length=500)
    state: dict


@app.post("/api/command", response_model=ai.VoiceCommand)
async def interpret_command(req: CommandRequest):
    return await ai.interpret_command(req.transcript, req.state)


# Mounted last so /api routes take priority.
app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
