"""
backend/search/caption.py -- Caption signal: SigLIP2-caption embeddings +
Elasticsearch fuzzy, RRF. Frame-level on
both legs (frame_id == map-keyframes.n directly), so RRF keys on frame_id
and `n` needs no time-based lookup at all.
"""

import faiss
import numpy as np
import pandas as pd
from cachetools import TTLCache

from .. import config
from ..core.es import ensure_caption_fuzzy_index
from ..core.models import siglip2_query_mat
from .common import (es_text_leg, faiss_search_pooled, l2_normalize, query_hash, rrf_fuse,
                     video_id_from_filename)

_index = None
_meta: pd.DataFrame = None


def build_siglip2_caption_index():
    global _index, _meta
    if not (config.SIGLIP_CAPTION_FAISS.exists() and config.SIGLIP_CAPTION_META.exists()):
        # 768embed/768caption/{video_id}.npy + {video_id}.csv (was siglip_caption/
        # {video_id}_caption_siglip768.npy + _frames.csv before the rename).
        npy_paths = sorted(config.SIGLIP_CAPTION_DIR.glob("*.npy"))
        index = faiss.IndexFlatIP(config.EMBED_DIM)
        rows = []
        gid = 0
        for npy_path in npy_paths:
            video_id = video_id_from_filename(str(npy_path), ("_caption_siglip768",))
            frames_path = config.SIGLIP_CAPTION_DIR / f"{video_id}.csv"
            if not frames_path.exists():
                continue
            vecs = l2_normalize(np.load(npy_path))
            frames = pd.read_csv(frames_path)
            if len(frames) != vecs.shape[0]:
                continue
            index.add(vecs)
            for _, r in frames.iterrows():
                rows.append((gid, video_id, int(r["frame_id"]), r["text"]))
                gid += 1
        faiss.write_index(index, str(config.SIGLIP_CAPTION_FAISS))
        pd.DataFrame(rows, columns=["global_id", "video_id", "frame_id", "text"]).to_csv(config.SIGLIP_CAPTION_META, index=False)

    _index = faiss.read_index(str(config.SIGLIP_CAPTION_FAISS))
    _meta = pd.read_csv(config.SIGLIP_CAPTION_META)
    return _index, _meta


def _get_index():
    if _index is None:
        build_siglip2_caption_index()
    return _index, _meta


_siglip_cache = TTLCache(maxsize=256, ttl=300)


def search_siglip2_caption(query, k: int = config.FETCH_K) -> pd.DataFrame:
    cache_key = (query_hash(query), k)
    if cache_key in _siglip_cache:
        return _siglip_cache[cache_key]
    index, meta = _get_index()
    ids, scores = faiss_search_pooled(index, siglip2_query_mat(query), k)
    rows = []
    for rank, (gid, score) in enumerate(zip(ids, scores), start=1):
        if gid == -1:
            continue
        row = meta.iloc[int(gid)]
        rows.append({"rank": rank, "score": float(score), "video_id": row["video_id"],
                      "frame_id": int(row["frame_id"]), "text": row["text"]})
    result = pd.DataFrame(rows)
    _siglip_cache[cache_key] = result
    return result


_fuzzy_cache = TTLCache(maxsize=256, ttl=300)
_EMPTY_FUZZY = pd.DataFrame(columns=["rank", "score", "video_id", "frame_id", "text"])


def search_caption_fuzzy(query, k: int = config.FETCH_K):
    return es_text_leg(query, k, index=config.ES_INDEX_CAPTION, ensure_index=ensure_caption_fuzzy_index,
                       es_query={"match": {"text": {"query": query, "fuzziness": "AUTO"}}},
                       fields=("video_id", "frame_id", "text"), cache=_fuzzy_cache,
                       empty=_EMPTY_FUZZY, label="Caption fuzzy")


def rrf_fuse_caption(named_dfs: dict, k: int = config.RRF_K, top_n: int = config.DISPLAY_N) -> pd.DataFrame:
    """Frame-level on both legs: keyed on (video_id, frame_id)."""
    return rrf_fuse(named_dfs, ("video_id", "frame_id"), ("text",), k=k, top_n=top_n)


def attach_keyframe_caption(df: pd.DataFrame) -> pd.DataFrame:
    """Captions are frame-level on both legs: frame_id == map-keyframes.n
    directly, no lookup needed."""
    if df is None or df.empty:
        return df
    out = df.copy()
    out["n"] = out["frame_id"].astype(int)
    return out
