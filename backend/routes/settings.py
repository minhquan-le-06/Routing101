"""
backend/routes/settings.py -- process-level info and settings: which
embedding profile this process loaded, and the backend-side search
settings (long-query chunking strategy).
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import config
from ..core.models import QUERY_CHUNK_STRATEGIES, get_query_chunk_strategy, set_query_chunk_strategy

router = APIRouter()


@router.get("/api/profile")
def profile():
    """Which embedding profile this process loaded -- the frontend badges it
    so two tabs on two ports can't be mistaken for each other."""
    return {"profile": config.EMBED_PROFILE, "dim": config.EMBED_DIM,
            "model_id": config.SIGLIP2_MODEL_ID}


class SettingsRequest(BaseModel):
    query_chunk_strategy: str


def _settings_payload():
    return {"query_chunk_strategy": get_query_chunk_strategy(),
            "query_chunk_strategies": list(QUERY_CHUNK_STRATEGIES)}


@router.get("/api/settings")
def get_settings():
    """Backend-side search settings -- currently just how an over-64-token
    query is split for the SigLIP2 embedding legs (backend/core/models.py). Unlike
    the frontend's own preferences these can't live in localStorage: they
    change what a search returns, and the splitting happens in this process.
    The settings dialog reads this on open so it shows the live value rather
    than whatever the last tab happened to set."""
    return _settings_payload()


@router.post("/api/settings")
def post_settings(body: SettingsRequest):
    try:
        set_query_chunk_strategy(body.query_chunk_strategy)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _settings_payload()
