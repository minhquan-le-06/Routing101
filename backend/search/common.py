"""
backend/search/common.py -- helpers shared by the search/* signal modules:
query cache keys, pooled/fused FAISS search, embedding-file id parsing, and
the result-shape contract (df_to_results) every signal returns to the
frontend.
"""

import hashlib
import threading
from pathlib import Path

import faiss
import numpy as np
import pandas as pd
from PIL import Image

from .. import config
from ..core.es import get_es_client
from ..core.keyframes import thumbnail_url
from ..core.models import is_image_query

# Every FAISS search that overlaps another one gets its own OpenMP team of
# CPU_BUDGET workers, and each worker keeps its BLAS scratch buffers (~125 MB)
# for the life of the process -- so N simultaneous searches permanently cost
# N x ~2.5 GB, which is what ran the machine out of memory under concurrent
# load. One search at a time reuses the single team; a flat search is a few
# milliseconds, so the wait is negligible next to the rest of a request.
_FAISS_LOCK = threading.Lock()


def query_hash(query) -> str:
    """Cache-key fragment for a query -- a text query is already hashable
    as-is, but a picture query (PIL.Image) isn't, so hash its raw pixel
    bytes instead.

    The active query-chunking strategy (core/models.py) is folded in because it
    changes what a long query's embedding legs return, and every leg's TTL
    cache keys on this -- without it, flipping the setting would keep serving
    the previous strategy's ranking until the entries aged out. The ES legs
    aren't affected by the strategy at all; they just pay one extra miss
    after a switch, which is cheaper than giving them a second key shape."""
    from ..core.models import get_query_chunk_strategy

    prefix = get_query_chunk_strategy() + "|"
    if isinstance(query, Image.Image):
        return prefix + "img:" + hashlib.sha1(query.tobytes()).hexdigest()
    return prefix + "txt:" + query


def faiss_search_pooled(index, qmat: np.ndarray, k: int, per_vec_k: int = None):
    """Search `index` with one or more query vectors; return (ids, scores)
    for the top-k rows, at most one entry per row.

    One query vector -- an image query, a short text query, or any query
    under truncate/mean_chunks -- is FAISS's own result handed straight back,
    scores and all, so those paths rank exactly as they did before chunking
    existed.

    Several vectors (chunks_separate, one per chunk of a long query) each get
    their own ranked list, and the lists are fused with **RRF**, the same
    reciprocal-rank fusion every signal already uses to combine its legs:
    a row's score is the sum of 1/(RRF_K + rank) over the chunks that
    retrieved it. That rewards a row for placing well against *several*
    chunks, which is what makes a long query behave like a conjunction of its
    clauses -- a max-pool would instead let one strongly-matching clause
    carry a row that ignored the rest of the query.

    Two consequences of fusing rather than pooling:

    * The returned scores are RRF scores (order 1/RRF_K, so ~0.016 and down),
      not cosine similarities. Only their order is meaningful, and only
      relative to each other -- so a long query's leg shows a different scale
      of number than a short one's. Everything downstream fuses on `rank`
      rather than `score`, so nothing but the displayed figure changes.
    * Ties are common (one appearance at the same rank in different chunks
      scores identically), so they're broken by best cosine, then by id --
      deterministic, and it prefers the row that actually matched harder.

    `per_vec_k` sets how deep each chunk's own list goes, separately from the
    `k` distinct rows returned, for the caller that overfetches for its own
    reasons (search/summary.py fetches extra chunk rows so its per-video
    max-pool has enough to work with).
    """
    qmat = l2_normalize(np.asarray(qmat, dtype="float32").reshape(-1, index.d))
    n = min(per_vec_k or k, index.ntotal)
    with _FAISS_LOCK:
        scores, ids = index.search(qmat, n)
    if qmat.shape[0] == 1:
        return ids[0], scores[0]
    fused, best = {}, {}
    for row_ids, row_scores in zip(ids, scores):
        rank = 0
        for gid, score in zip(row_ids, row_scores):
            gid = int(gid)
            if gid == -1:
                continue
            # Rank counts only the hits actually returned, so a short list
            # padded with -1 doesn't shift the ranks after the gap.
            rank += 1
            fused[gid] = fused.get(gid, 0.0) + 1.0 / (config.RRF_K + rank)
            score = float(score)
            if score > best.get(gid, float("-inf")):
                best[gid] = score
    out_ids = sorted(fused, key=lambda g: (-fused[g], -best[g], g))[:k]
    return (np.asarray(out_ids, dtype="int64"),
            np.asarray([fused[g] for g in out_ids], dtype="float32"))


def video_id_from_filename(path_str: str, suffixes: tuple) -> str:
    stem = Path(path_str).stem
    for suffix in suffixes:
        if stem.endswith(suffix):
            return stem[: -len(suffix)]
    return stem


def l2_normalize(mat: np.ndarray) -> np.ndarray:
    mat = mat.astype("float32", copy=True)
    faiss.normalize_L2(mat)
    return mat


# ---------------------------------------------------------------------------
# Result-shape contract -- every leg/signal normalizes to this dict shape
# before it's returned to the frontend.
# ---------------------------------------------------------------------------

def df_to_results(df: pd.DataFrame, score_col: str, text_col: str = None) -> list:
    if df is None or df.empty:
        return []
    out = []
    for _, r in df.iterrows():
        n = r.get("n")
        if n is None or pd.isna(n):
            continue
        n = int(n)
        text = r.get(text_col) if text_col else None
        out.append({
            "video_id": r["video_id"], "n": n, "rank": int(r["rank"]),
            "score_label": score_col, "score_val": float(r[score_col]),
            "text": text if isinstance(text, str) else None,
            "thumbnail_url": thumbnail_url(r["video_id"], n),
        })
    return out


# ---------------------------------------------------------------------------
# Reciprocal-rank fusion -- every signal's RRF over its own legs, and Mixed's
# weighted RRF across sub-queries, is this one function with a different key.
# ---------------------------------------------------------------------------

def rrf_fuse(named_dfs: dict, key_cols: tuple, extra_cols: tuple = (), *, weights: dict = None,
             backfill: tuple = (), k: int = config.RRF_K, top_n: int = config.DISPLAY_N) -> pd.DataFrame:
    """Fuse already-ranked dfs: a row's score is the sum over the dfs that
    contain it of weight / (k + rank), keyed on `key_cols` (video_id as-is,
    every other key column as int).

    `extra_cols` are carried over from the first df a key appears in (dict
    order of `named_dfs` = leg priority). `backfill` columns are the
    exception: if that first value is NaN, a later df's non-NaN value fills
    it in (ASR's frame_id, which only the SigLIP2 leg carries).

    `weights` (by `named_dfs` key) makes it a weighted RRF, skipping any df
    whose weight is 0/missing; without it every df counts once.

    Returns the fused rows sorted by `rrf_score`, re-ranked 1..n, top `top_n`
    -- or an empty df with no columns if nothing was fused."""
    scores, extra = {}, {}
    for name, df in named_dfs.items():
        w = 1 if weights is None else weights.get(name, 0)
        if not w or df is None or df.empty:
            continue
        for _, row in df.iterrows():
            key = tuple(row[c] if c == "video_id" else int(row[c]) for c in key_cols)
            scores[key] = scores.get(key, 0.0) + w * (1.0 / (k + row["rank"]))
            e = extra.setdefault(key, {c: row.get(c) for c in extra_cols})
            for c in backfill:
                if pd.isna(e.get(c)) and not pd.isna(row.get(c, np.nan)):
                    e[c] = row[c]
    rows = [{**dict(zip(key_cols, key)), "rrf_score": s, **extra[key]} for key, s in scores.items()]
    out = pd.DataFrame(rows)
    if out.empty:
        return out
    out = out.sort_values("rrf_score", ascending=False).reset_index(drop=True)
    out["rank"] = np.arange(1, len(out) + 1)
    return out.head(top_n)


# ---------------------------------------------------------------------------
# Elasticsearch text legs -- ASR fuzzy/exact, Caption/OCR/Summary fuzzy all
# wrap their query body in the same cache / ensure-index / degrade-on-error
# shell, so it lives once here.
# ---------------------------------------------------------------------------

ES_DOWN_OTHER_LEGS = "showing other legs only."


def es_text_leg(query, k: int, *, index: str, ensure_index, es_query: dict, fields: tuple,
                cache, empty: pd.DataFrame, label: str, down_note: str = ES_DOWN_OTHER_LEGS):
    """Returns (df, warning). warning is a user-facing str if ES was
    unreachable, else None -- these legs need text, so an image query
    short-circuits to `empty` with no warning. Each hit becomes a row of
    rank, score, then `fields` straight off its `_source`."""
    if is_image_query(query):
        return empty, None
    cache_key = (query_hash(query), k)
    if cache_key in cache:
        return cache[cache_key], None
    try:
        ensure_index()
        es = get_es_client()
        resp = es.search(index=index, size=k, query=es_query)
    except Exception as e:
        return empty, f"[{label}] Elasticsearch not reachable at {config.ES_HOST} ({e}) — {down_note}"

    rows = []
    for rank, hit in enumerate(resp["hits"]["hits"], start=1):
        src = hit["_source"]
        rows.append({"rank": rank, "score": float(hit["_score"]), **{f: src[f] for f in fields}})
    result = pd.DataFrame(rows)
    cache[cache_key] = result
    return result, None
