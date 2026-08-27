"""
backend/search/routing.py -- LLM-based query routing.
Step 1: Gemini preprocessing (raw Vietnamese -> structured English keywords/
paraphrasings). Step 2: retry-loop dispatch, one independent search per
(paraphrasing, modality) pair across all 4 must-search modalities (visual,
asr, caption, ocr), no RRF. Step 3: frame-level rank-weighted point
aggregation across all N runs.
"""

import json
import re

import pandas as pd

from .. import config
from ..common import apply_filters, thumbnail_url
from . import asr as asr_mod
from . import caption as cap_mod
from . import keyframe as kf
from . import ocr as ocr_mod

ALL_MODALITIES = config.ROUTING_ALL_MODALITIES


class RoutingLLMError(Exception):
    """Step 1 failed (no API key, network, bad/empty JSON, failed schema
    validation after one retry) -- always surfaced as a clear error, never
    a silently-degraded/hallucinated fallback."""


# ---------------------------------------------------------------------------
# Step 1 -- Gemini preprocessing
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = """You are a query-understanding assistant for a video
retrieval system. You will receive ONE raw search query written in
Vietnamese. Produce a JSON object (and NOTHING else -- no markdown, no
commentary) with exactly these two keys:

- "keywords": a list of up to 10 distinct English keywords or short phrases
  capturing the key concepts, entities, actions, and objects in the query.
  Each keyword must be something the query literally says or literally
  implies -- never invent an object, attribute, action, or entity that is
  not present in the source query.
- "paraphrasings": a JSON object keyed by each string in "keywords". Each
  value is a list of up to 10 English search phrasings for that keyword
  (the keyword's own direct translation plus synonyms/rewordings/different
  granularity, e.g. "red motorbike" -> also "red scooter", "motorbike").
  Do not introduce objects/attributes not implied by the keyword itself.

Translate faithfully -- extraction and translation only, no invented
details. Output strict JSON only, no surrounding text or code fences."""

_client = None


def _client_or_raise():
    global _client
    if not config.GEMINI_API_KEY:
        raise RoutingLLMError("GEMINI_API_KEY is not set -- export it before starting the backend.")
    if _client is None:
        from google import genai
        _client = genai.Client(api_key=config.GEMINI_API_KEY)
    return _client


def _call_gemini(raw_query: str) -> str:
    from google.genai import types  # deferred import, mirrors the lazy client above
    client = _client_or_raise()
    resp = client.models.generate_content(
        model=config.GEMINI_MODEL_NAME,
        contents=[_SYSTEM_PROMPT, f"Vietnamese query: {raw_query}"],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            temperature=0.0,
        ),
    )
    return resp.text


_FENCE_RE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


def _strip_code_fence(text: str) -> str:
    return _FENCE_RE.sub("", text or "").strip()


def _validate_and_clip(parsed: dict, raw_query: str) -> dict:
    if not isinstance(parsed, dict):
        raise RoutingLLMError("Gemini did not return a JSON object.")

    keywords_raw = parsed.get("keywords")
    paraphr_raw = parsed.get("paraphrasings")
    if not isinstance(keywords_raw, list) or not keywords_raw:
        raise RoutingLLMError("Gemini returned no keywords.")
    if not isinstance(paraphr_raw, dict):
        paraphr_raw = {}

    seen, keywords = set(), []
    for kw in keywords_raw:
        kw = str(kw).strip()
        if not kw or kw.lower() in seen:
            continue
        seen.add(kw.lower())
        keywords.append(kw)
        if len(keywords) >= config.ROUTING_MAX_KEYWORDS:
            break
    if not keywords:
        raise RoutingLLMError("No usable keywords after cleanup.")

    paraphrasings = {}
    for kw in keywords:
        variants_raw = paraphr_raw.get(kw, [])
        if not isinstance(variants_raw, list):
            variants_raw = []
        seen_v, variants = set(), []
        for v in variants_raw:
            v = str(v).strip()
            if not v or v.lower() in seen_v:
                continue
            seen_v.add(v.lower())
            variants.append(v)
            if len(variants) >= config.ROUTING_MAX_PARAPHRASINGS:
                break
        if not variants:
            # A keyword with zero usable paraphrasings would contribute 0
            # searches -- fall back to searching the keyword itself rather
            # than silently dropping the whole keyword.
            variants = [kw]
        paraphrasings[kw] = variants

    # Modality selection removed -- all 4 are must-search signals, every run,
    # not something the LLM opts in/out of.
    modalities = list(ALL_MODALITIES)

    return {"raw_query": raw_query, "keywords": keywords, "paraphrasings": paraphrasings, "modalities": modalities}


def preprocess_query(raw_query: str) -> dict:
    """One (or, on a parse/validation failure, two) Gemini call(s).
    Returns {"raw_query", "keywords", "paraphrasings", "modalities"},
    already capped/deduped/validated. Raises RoutingLLMError on total
    failure -- never returns a partial or fabricated structure."""
    raw_query = (raw_query or "").strip()
    if not raw_query:
        raise RoutingLLMError("Empty query.")

    last_err = None
    for _attempt in range(2):
        try:
            text = _call_gemini(raw_query)
            parsed = json.loads(_strip_code_fence(text))
            return _validate_and_clip(parsed, raw_query)
        except RoutingLLMError:
            raise  # missing key etc. -- retrying won't help
        except Exception as e:
            last_err = e
            continue
    raise RoutingLLMError(f"Gemini call/parse failed after retry: {last_err}")


# ---------------------------------------------------------------------------
# Step 2 -- search retry loop (one independent search per (paraphrasing,
# modality) pair; no RRF, no cross-modality fusion)
# ---------------------------------------------------------------------------

_EMPTY_RUN = pd.DataFrame(columns=["video_id", "n", "rank", "score"])


def _finish(df: pd.DataFrame) -> pd.DataFrame:
    """Common tail for every branch below: select the 4 columns Step 3
    needs, and drop any row whose `n` didn't resolve -- attach_keyframe_asr
    can set `n = None` for a fuzzy-ASR hit whose video has no resolvable
    map-keyframes timestamp (backend/common.py's nearest_keyframe_n_by_time
    returns None on a miss). df_to_results() elsewhere guards this with
    `if n is None or pd.isna(n): continue`; aggregate_frame_appearances
    below needs the same guard, since `int(None)` raises."""
    if df is None or df.empty:
        return _EMPTY_RUN
    df = df[df["n"].notna()]
    if df.empty:
        return _EMPTY_RUN
    return df[["video_id", "n", "rank", "score"]]


def _dispatch_one(paraphrasing: str, modality: str, top_k: int,
                   video_filter: str, lot_filter) -> tuple:
    """One search. Returns (df[video_id, n, rank, score], warning|None)."""
    if modality == "visual":
        df = apply_filters(kf.search_siglip2_frame(paraphrasing, k=top_k), video_filter, lot_filter)
        return _finish(df), None
    if modality == "asr":
        raw, warning = asr_mod.search_asr_fuzzy(paraphrasing, k=top_k)
        df = asr_mod.attach_keyframe_asr(apply_filters(raw, video_filter, lot_filter))
        return _finish(df), warning
    if modality == "caption":
        df = cap_mod.attach_keyframe_caption(apply_filters(cap_mod.search_siglip_caption(paraphrasing, k=top_k), video_filter, lot_filter))
        return _finish(df), None
    if modality == "ocr":
        raw, warning = ocr_mod.search_ocr_fuzzy(paraphrasing, k=top_k)
        df = ocr_mod.attach_keyframe_ocr(apply_filters(raw, video_filter, lot_filter))
        return _finish(df), warning
    raise ValueError(f"unknown routing modality: {modality!r}")


def run_search_retry_loop(step1_output: dict, video_filter: str, lot_filter,
                           top_k: int = config.ROUTING_PER_RUN_TOP_K) -> list:
    """Step 2. Returns a list of run records:
    {"keyword", "paraphrasing", "modality", "df", "warning", "hit_count"}."""
    runs = []
    for kw in step1_output["keywords"]:
        for paraphrasing in step1_output["paraphrasings"][kw]:
            for modality in step1_output["modalities"]:
                df, warning = _dispatch_one(paraphrasing, modality, top_k, video_filter, lot_filter)
                runs.append({
                    "keyword": kw, "paraphrasing": paraphrasing, "modality": modality,
                    "df": df, "warning": warning, "hit_count": 0 if df is None else len(df),
                })
    return runs


# ---------------------------------------------------------------------------
# Step 3 -- frame-level rank-weighted point aggregation (new code, NOT a
# reuse of trake.trake_rank_videos -- different key (video_id, n) not
# video_id, different formula (rank-bucketed points, not coverage*mean(
# score)); same manual-dict-grouping style since the aggregation isn't a
# plain column sum)
# ---------------------------------------------------------------------------

def _rank_points(rank: int) -> int:
    """A frame ranked 1-30 within a run's own top-k earns 2 points, 31-100
    earns 1 point, and anything beyond that (shouldn't happen given
    ROUTING_PER_RUN_TOP_K=100, but kept defensive) earns 0."""
    if rank <= 30:
        return 2
    if rank <= 100:
        return 1
    return 0


def aggregate_frame_appearances(run_dfs: list, top_n: int = config.ROUTING_FINAL_TOP_N) -> list:
    """PRIMARY key: points, the sum across all N runs of each run's
    rank-bucketed contribution for this (video_id, n) frame (see
    _rank_points). Tiebreak 1: appearance_count (how many of the N runs
    this frame appeared in at all). Tiebreak 2: best (lowest) rank achieved
    across the runs it appeared in. Tiebreak 3: best (highest) score
    achieved across those runs. Note: scores are NOT normalized across
    modalities (SigLIP2 cosine similarity vs. Elasticsearch Lucene
    relevance score are different scales) -- this is acceptable since
    tiebreak 3 only breaks ties within an already-equal points/
    appearance_count/best_rank tier."""
    agg: dict = {}
    for df in run_dfs:
        if df is None or df.empty:
            continue
        for _, row in df.iterrows():
            key = (row["video_id"], int(row["n"]))
            rank, score = int(row["rank"]), float(row["score"])
            points = _rank_points(rank)
            entry = agg.get(key)
            if entry is None:
                agg[key] = {"video_id": row["video_id"], "n": int(row["n"]), "points": points,
                            "appearance_count": 1, "best_rank": rank, "best_score": score}
            else:
                entry["points"] += points
                entry["appearance_count"] += 1
                entry["best_rank"] = min(entry["best_rank"], rank)
                entry["best_score"] = max(entry["best_score"], score)

    rows = list(agg.values())
    rows.sort(key=lambda r: (-r["points"], -r["appearance_count"], r["best_rank"], -r["best_score"]))
    return rows[:top_n]


def to_final_results(agg_rows: list) -> list:
    """Normalizes Step 3's output to the same {video_id, n, rank,
    score_label, score_val, text, thumbnail_url} shape df_to_results()
    produces everywhere else, so the frontend's renderGrid() needs no
    special-casing for Routing. score_val = points (the primary ranking
    signal); appearance_count/best_rank/best_score are carried as extra
    fields for the details panel, harmlessly ignored by renderGrid()."""
    out = []
    for i, r in enumerate(agg_rows, start=1):
        out.append({
            "video_id": r["video_id"], "n": r["n"], "rank": i,
            "score_label": "points", "score_val": float(r["points"]),
            "text": None, "thumbnail_url": thumbnail_url(r["video_id"], r["n"]),
            "appearance_count": r["appearance_count"],
            "best_rank": r["best_rank"], "best_score": r["best_score"],
        })
    return out


def execute_routing_job(step1_output: dict, video_filter: str, lot_filter,
                         per_run_k: int = config.ROUTING_PER_RUN_TOP_K,
                         final_top_n: int = config.ROUTING_FINAL_TOP_N) -> dict:
    """Step 2 + Step 3 combined -- what the background task calls."""
    runs = run_search_retry_loop(step1_output, video_filter, lot_filter, per_run_k)
    agg = aggregate_frame_appearances([r["df"] for r in runs], top_n=final_top_n)
    results = to_final_results(agg)
    run_summary = [{"keyword": r["keyword"], "paraphrasing": r["paraphrasing"], "modality": r["modality"],
                     "hit_count": r["hit_count"], "warning": r["warning"]} for r in runs]
    warnings = sorted({r["warning"] for r in runs if r["warning"]})
    return {"results": results, "n_runs": len(runs), "run_summary": run_summary, "warnings": warnings}
