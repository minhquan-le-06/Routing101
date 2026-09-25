"""
backend/routes/search/signals.py -- per-signal search endpoints (Keyframe, ASR,
Caption, OCR, Summary, Mixed). All share the same shape: fetch_k
computation, apply_filters before RRF, the same skip messages for picture
queries, and graceful degrade when Elasticsearch is down.
"""

from dataclasses import dataclass
from typing import Callable, List, Literal, Optional

from fastapi import APIRouter
from pydantic import BaseModel

from ... import config
from ...core.models import (get_query_chunk_strategy, is_image_query, siglip2_long_query_note,
                           siglip2_long_query_tokens)
from ...core.query import resolve_query
from ...filters import metadata as md
from ...filters import objects as od
from ...filters.lot import apply_filters, parse_lot_range
from ...search import asr as asr_mod
from ...search import caption as cap_mod
from ...search import keyframe as kf
from ...search import ocr as ocr_mod
from ...search import summary as sum_mod
from ...search.common import df_to_results, rrf_fuse
from ...search.composite import trake as trake_mod
from ..schemas import LegResult, QuerySearchRequest, SearchScope

router = APIRouter()

# Shared skip-message text, so the API response reads the same regardless
# of which signal it came from.
_SKIP_NOTHING_TO_FUSE = "Skipped — picture queries only ever have one active leg (SigLIP2), nothing to fuse."


class KeyframeSearchRequest(QuerySearchRequest):
    pass


class KeyframeSearchResponse(BaseModel):
    warning: Optional[str] = None
    results: list = []


# Keyframe is SigLIP2-only -- its CLIP ViT-B/32 leg (and the Multilingual-CLIP
# query-time text encoder behind it) was removed entirely, see
# backend/search/keyframe.py's docstring. No legs to choose, no RRF to fuse
# -- same single-leg shape as OCR below.
@router.post("/api/search/keyframe", response_model=KeyframeSearchResponse)
def search_keyframe(body: KeyframeSearchRequest):
    query = resolve_query(body.query, body.image_id)
    top_k = body.top_k
    fetch_k = max(config.FETCH_K, top_k)
    lot_filter = parse_lot_range(body.lot_filter, body.exclude_lot)
    od_matched, od_unmatched = od.match_classes(body.od_filter)
    od_warning = od.unmatched_warning(od_unmatched)
    # Keyframe is SigLIP2-only (see docstring above), so an over-window query
    # takes priority over the OD warning -- it affects every result, not
    # just the ones an unmatched OD class would have narrowed.
    trunc_warning = None if is_image_query(query) else siglip2_long_query_note(query)

    df = apply_filters(kf.search_siglip2_frame(query, k=fetch_k), body.video_filter, lot_filter)
    df = md.apply_facet_filter(df, body.facet_field, body.facet_value)
    filtered = od.apply_od_filter(df, od_matched)
    return KeyframeSearchResponse(warning=trunc_warning or od_warning, results=df_to_results(filtered.head(top_k), "score"))


# ---------------------------------------------------------------------------
# ASR / Caption / Summary share one shape: a SigLIP2 leg + Elasticsearch
# leg(s) + RRF, all resolved to a keyframe `n` via that signal's
# attach_keyframe_* before df_to_results. So they share one handler,
# _run_text_signal(), and each endpoint only declares its _TextSignal:
# which legs it has, how to attach `n`, how to fuse. OCR is the one-leg
# exception (its own endpoint, no RRF). ASR alone carries a third leg,
# `exact` (Elasticsearch match_phrase) -- hence the default-off field on the
# shared request/response models below, which Caption/Summary simply never
# set or read.
# ---------------------------------------------------------------------------

class TextSignalLegs(BaseModel):
    siglip: bool = True
    fuzzy: bool = True
    exact: bool = False  # ASR only -- Caption/Summary never send or read it
    rrf: bool = True


class TextSignalSearchRequest(QuerySearchRequest):
    # od_filter (inherited) is applied by ASR/Caption; ignored by Summary
    # (video-level, no per-frame OD).
    legs: TextSignalLegs = TextSignalLegs()


class TextSignalSearchResponse(BaseModel):
    siglip: Optional[LegResult] = None
    fuzzy: Optional[LegResult] = None
    exact: Optional[LegResult] = None  # ASR only, None for Caption/Summary
    rrf: Optional[LegResult] = None


def _siglip_leg(search_fn):
    """Adapt a SigLIP2 leg (returns a df) to the ES legs' (df, warning) shape."""
    return lambda query, k: (search_fn(query, k=k), None)


@dataclass(frozen=True)
class _TextSignal:
    legs: dict  # leg name (a TextSignalLegs field) -> fn(query, k) -> (df, warning), in RRF priority order
    attach: Callable  # the signal's attach_keyframe_*
    fuse: Callable  # the signal's rrf_fuse_*
    od: bool = True  # Summary is video-level: no per-frame OD filter, no OD warning


_ASR = _TextSignal(
    legs={"siglip": _siglip_leg(asr_mod.search_siglip2_asr),
          "fuzzy": asr_mod.search_asr_fuzzy,
          "exact": asr_mod.search_asr_exact},
    attach=asr_mod.attach_keyframe_asr, fuse=asr_mod.rrf_fuse_asr)
_CAPTION = _TextSignal(
    legs={"siglip": _siglip_leg(cap_mod.search_siglip2_caption),
          "fuzzy": cap_mod.search_caption_fuzzy},
    attach=cap_mod.attach_keyframe_caption, fuse=cap_mod.rrf_fuse_caption)
_SUMMARY = _TextSignal(
    legs={"siglip": _siglip_leg(sum_mod.search_siglip2_summary),
          "fuzzy": sum_mod.search_summary_fuzzy},
    attach=sum_mod.attach_keyframe_summary, fuse=sum_mod.rrf_fuse_summary, od=False)


def _run_text_signal(body: TextSignalSearchRequest, sig: _TextSignal) -> TextSignalSearchResponse:
    query = resolve_query(body.query, body.image_id)
    top_k = body.top_k
    fetch_k = max(config.FETCH_K, top_k)
    lot_filter = parse_lot_range(body.lot_filter, body.exclude_lot)
    image_query = is_image_query(query)
    od_matched, od_warning = None, None
    if sig.od:
        od_matched, od_unmatched = od.match_classes(body.od_filter)
        od_warning = od.unmatched_warning(od_unmatched)
    # Only the siglip leg is subject to the 64-token window -- the ES legs'
    # own warnings are untouched by this.
    trunc_warning = None if image_query else siglip2_long_query_note(query)

    # A leg runs if it's shown on its own or feeds the RRF.
    dfs, warnings = {}, {}
    for name, search in sig.legs.items():
        dfs[name] = warnings[name] = None
        if getattr(body.legs, name) or body.legs.rrf:
            df, warnings[name] = search(query, fetch_k)
            df = apply_filters(df, body.video_filter, lot_filter)
            dfs[name] = md.apply_facet_filter(df, body.facet_field, body.facet_value)

    def results(df, score_col):
        df = sig.attach(df)
        if sig.od:
            df = od.apply_od_filter(df, od_matched)
        return df_to_results(df.head(top_k), score_col, "text")

    resp = TextSignalSearchResponse()
    for name in sig.legs:
        if getattr(body.legs, name):
            leg_warning = trunc_warning if name == "siglip" else warnings[name]
            setattr(resp, name, LegResult(warning=leg_warning or od_warning, results=results(dfs[name], "score")))
    if body.legs.rrf:
        if image_query:
            resp.rrf = LegResult(skipped=_SKIP_NOTHING_TO_FUSE)
        else:
            fused = sig.fuse(dfs, top_n=fetch_k)
            resp.rrf = LegResult(warning=od_warning, results=results(fused, "rrf_score"))
    return resp


@router.post("/api/search/asr", response_model=TextSignalSearchResponse)
def search_asr(body: TextSignalSearchRequest):
    return _run_text_signal(body, _ASR)


@router.post("/api/search/caption", response_model=TextSignalSearchResponse)
def search_caption(body: TextSignalSearchRequest):
    return _run_text_signal(body, _CAPTION)


@router.post("/api/search/summary", response_model=TextSignalSearchResponse)
def search_summary(body: TextSignalSearchRequest):
    return _run_text_signal(body, _SUMMARY)


# ---------------------------------------------------------------------------
# OCR: single leg by design, no embedding leg, no RRF.
# ---------------------------------------------------------------------------

class OcrSearchRequest(QuerySearchRequest):
    pass


class OcrSearchResponse(BaseModel):
    fuzzy: Optional[LegResult] = None
    image_query_unavailable: bool = False


@router.post("/api/search/ocr", response_model=OcrSearchResponse)
def search_ocr(body: OcrSearchRequest):
    query = resolve_query(body.query, body.image_id)
    if is_image_query(query):
        return OcrSearchResponse(image_query_unavailable=True)

    top_k = body.top_k
    fetch_k = max(config.FETCH_K, top_k)
    lot_filter = parse_lot_range(body.lot_filter, body.exclude_lot)
    od_matched, od_unmatched = od.match_classes(body.od_filter)
    od_warning = od.unmatched_warning(od_unmatched)

    df, warning = ocr_mod.search_ocr_fuzzy(query, k=fetch_k)
    df = apply_filters(df, body.video_filter, lot_filter)
    df = md.apply_facet_filter(df, body.facet_field, body.facet_value)
    filtered = od.apply_od_filter(ocr_mod.attach_keyframe_ocr(df), od_matched)
    results = df_to_results(filtered.head(top_k), "score", "text")
    return OcrSearchResponse(fuzzy=LegResult(warning=warning or od_warning, results=results))


# ---------------------------------------------------------------------------
# Mixed: many independent sub-queries, each with its own text and its own
# single signal (Keyframe/ASR/Caption/OCR -- no nested "Mixed", no Summary
# [video-level, always resolves to frame 1 -- reserved for TRAKE's context
# row instead, see backend/routes/search/trake.py], no reverse-image-search per
# sub-query), combined with a user-weighted RRF (0-3 per sub-query). Each
# sub-query is resolved via trake_search_event() -- the exact same
# per-signal search + internal RRF every standalone signal route and TRAKE
# event already use -- then a weighted rrf_fuse() combines them keyed by
# sub-query index (not signal name), so two sub-queries can share a signal
# without colliding. TRAKE's own per-event "Mixed" signal option (backed by
# the shared mixedConfig weights/legs) is unrelated and unchanged.
# ---------------------------------------------------------------------------

class MixedSubQuery(BaseModel):
    text: str
    signal: Literal["Keyframe", "ASR", "Caption", "OCR"]
    weight: int = 1


class MixedSearchRequest(SearchScope):
    queries: List[MixedSubQuery] = []
    od_filter: str = ""
    show_transcript: bool = False


class MixedSearchResponse(BaseModel):
    empty: bool = False
    warning: Optional[str] = None
    results: list = []


@router.post("/api/search/mixed", response_model=MixedSearchResponse)
def search_mixed(body: MixedSearchRequest):
    top_k = body.top_k
    fetch_k = max(config.FETCH_K, top_k)
    lot_filter = parse_lot_range(body.lot_filter, body.exclude_lot)
    od_matched, od_unmatched = od.match_classes(body.od_filter)
    od_warning = od.unmatched_warning(od_unmatched)

    sub_dfs, sub_weights = {}, {}
    # OCR sub-queries have no SigLIP2 leg at all (search/ocr.py is
    # fuzzy-only), so they're exempt from the token-window check below --
    # every other signal option here (Keyframe/ASR/Caption) always runs a
    # SigLIP2 leg internally, via trake_search_event().
    long_labels = []
    for i, q in enumerate(body.queries):
        text = q.text.strip()
        if not text or q.weight <= 0:
            continue
        n_tokens = None if q.signal == "OCR" else siglip2_long_query_tokens(text)
        if n_tokens:
            long_labels.append(f"#{i + 1} ({n_tokens} tokens)")
        df = trake_mod.trake_search_event(
            text, q.signal, fetch_k, body.video_filter, lot_filter,
            facet_field=body.facet_field, facet_value=body.facet_value,
        )
        if df is not None and not df.empty:
            sub_dfs[i] = df[["video_id", "n", "rank"]]
            sub_weights[i] = q.weight

    if not sub_dfs:
        return MixedSearchResponse(empty=True)

    trunc_warning = None
    if long_labels:
        trunc_warning = (
            f"Sub-quer{'y' if len(long_labels) == 1 else 'ies'} "
            f"{', '.join(long_labels)} over the 64-token window -- "
            f"'{get_query_chunk_strategy()}'."
        )

    # trake_search_event() already applies the facet filter per sub-query,
    # so only OD filtering (which it doesn't apply) needs to happen here,
    # post-fusion, same as every per-signal route above.
    fused = rrf_fuse(sub_dfs, ("video_id", "n"), weights=sub_weights, top_n=fetch_k)
    fused = od.apply_od_filter(fused, od_matched)
    results = df_to_results(fused.head(top_k), "rrf_score")
    if body.show_transcript:
        # Attaches ASR transcript text under every result regardless of
        # which sub-query actually ranked it (unlike the per-signal routes'
        # `text_col`, which only ever carries text a signal's own search
        # produced) -- opt-in since it's an extra per-row lookup.
        for r in results:
            r["text"] = asr_mod.transcript_for_frame(r["video_id"], r["n"])
    return MixedSearchResponse(warning=trunc_warning or od_warning, results=results)
