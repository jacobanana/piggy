"""Composition root: the FastAPI app, all wiring, and the baked SPA."""

from pathlib import Path

from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

import identity.api
import ledger.api
from core.config import get_settings
from core.http import register_exception_handlers
from core.logging import configure_logging

settings = get_settings()
# Before anything else logs: uvicorn only wires its own loggers, so without
# this the application's own records have nowhere to go.
configure_logging()

app = FastAPI(title="Piggy", version="1.0.0")

register_exception_handlers(app)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

api = APIRouter(prefix="/api")
api.include_router(identity.api.router)
if settings.dev_auth_enabled:
    api.include_router(identity.api.dev_router)
api.include_router(ledger.api.router)
api.include_router(ledger.api.default_router)


@api.get("/health", tags=["meta"])
def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(api)


def mount_spa(application: FastAPI) -> None:
    """Serve the built frontend when it exists (production / docker image)."""
    dist = Path(settings.frontend_dist_dir)
    if dist.is_dir():
        application.mount("/", StaticFiles(directory=dist, html=True), name="spa")


mount_spa(app)
