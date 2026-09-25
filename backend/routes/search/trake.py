"""
backend/routes/search/trake.py -- TRAKE endpoint, on top of
backend/search/composite/trake.py's ranking logic. Each
candidate's matched events carry a thumbnail_url (frontend renders them
directly, same shape convention as everywhere else) and their own
`timestamp` (seconds) so the frontend can drive TRAKE's marker-bar
playback dialog without a second round-trip -- it only needs GET
/api/playback (already built) to resolve fps for the live timer.
"""

from typing import Dict, List, Literal, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from ... import config
from ...core.keyframes import thumbnail_url
from ...core.models import get_query_chunk_strategy, siglip2_long_query_tokens
from ...filters.lot import parse_lot_range
from ...search.composite import trake as trake_mod
from ..schemas import SearchScope

router = APIRouter()


class TrakeContext(BaseModel):
    # Summary is video-level (always resolves to frame 1 -- see
    # attach_keyframe_summary in backend/search/summary.py), so it's
    # reserved for this whole-video boost query and fixed here, not a
    # user-facing choice -- see TrakeEvent below for the events' own list.
    text: str
    signal: Literal["Summary"] = "Summary"


class TrakeEvent(BaseModel):
    text: str
    signal: Literal["Keyframe", "ASR", "Caption", "OCR", "Mixed"]


class TrakeSearchRequest(SearchScope):
    context: Optional[TrakeContext] = None
    events: List[TrakeEvent]
    top_v: int = 15
    mixed_weights: Dict[str, int] = {}
    mixed_legs: Dict[str, bool] = {}


class TrakeSearchResponse(BaseModel):
    message: Optional[str] = None
    warning: Optional[str] = None
    candidates: list = []


@router.post("/api/search/trake", response_model=TrakeSearchResponse)
def search_trake(body: TrakeSearchRequest):
    texts = [ev.text.strip() for ev in body.events]
    if len(body.events) < 1 or not all(texts):
        return TrakeSearchResponse(message="Fill in every event's query text to search (minimum 1 event).")

    fetch_k = max(config.FETCH_K, body.top_k)
    lot_filter = parse_lot_range(body.lot_filter, body.exclude_lot)
    ctx_text = (body.context.text.strip() if body.context else "")
    ctx_signal = body.context.signal if body.context else "Summary"

    # OCR-signal events have no SigLIP2 leg at all (search/ocr.py is
    # fuzzy-only), so they're exempt -- every other signal option here
    # (Keyframe/ASR/Caption/Mixed, plus the context row's fixed Summary)
    # always runs a SigLIP2 leg internally, via trake_search_event().
    long_labels = []
    ctx_tokens = siglip2_long_query_tokens(ctx_text) if ctx_text else None
    if ctx_tokens:
        long_labels.append(f"context ({ctx_tokens} tokens)")
    for i, ev in enumerate(body.events):
        n_tokens = None if ev.signal == "OCR" else siglip2_long_query_tokens(ev.text)
        if n_tokens:
            long_labels.append(f"event {i + 1} ({n_tokens} tokens)")
    trunc_warning = None
    if long_labels:
        trunc_warning = (
            f"{', '.join(long_labels)} over the 64-token window -- "
            f"'{get_query_chunk_strategy()}'."
        )

    def run_event(text, signal):
        return trake_mod.trake_search_event(
            text, signal, fetch_k, body.video_filter, lot_filter,
            mixed_weights=body.mixed_weights, mixed_legs=body.mixed_legs,
            facet_field=body.facet_field, facet_value=body.facet_value,
        )

    all_dfs, labels = [], []
    if ctx_text:
        all_dfs.append(run_event(ctx_text, ctx_signal))
        labels.append("E0")
    for i, ev in enumerate(body.events):
        all_dfs.append(run_event(ev.text, ev.signal))
        labels.append(f"E{i + 1}")

    # Context bonus: any video in the context query's own top-(Top-K/2)
    # candidates gets a flat score bump, independent of whether that video
    # also satisfies the ordered-chain match above.
    bonus_video_ids = None
    if ctx_text:
        ctx_df = all_dfs[0]
        if ctx_df is not None and not ctx_df.empty:
            half = max(1, body.top_k // 2)
            bonus_video_ids = set(ctx_df.sort_values("rank").head(half)["video_id"])

    candidates = trake_mod.trake_rank_videos(all_dfs, labels, body.top_v, bonus_video_ids=bonus_video_ids)

    for c in candidates:
        for e in c["events"]:
            if e["matched"]:
                e["thumbnail_url"] = thumbnail_url(e["video_id"], e["n"])

    message = None
    if not candidates:
        message = ("No video matches every event in the required order. Try broader event text, "
                   "fewer events, or a different signal per event.")
    return TrakeSearchResponse(message=message, warning=trunc_warning, candidates=candidates)
