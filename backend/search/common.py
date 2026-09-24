"""
backend/search/common.py -- helpers shared by the search/* signal modules:
query cache keys, pooled/fused FAISS search, embedding-file id parsing, and
the result-shape contract (df_to_results) every signal returns to the
frontend.
"""

import hashlib
from pathlib import Path

import faiss
import numpy as np
import pandas as pd
from PIL import Image

from .. import config
from ..core.keyframes import thumbnail_url


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
