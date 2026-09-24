"""
backend/search/ocr.py -- OCR signal: Elasticsearch fuzzy over per-frame OCR
text only. Single leg by design (no
embedding leg, no RRF).
"""

import pandas as pd
from cachetools import TTLCache

from .. import config
from ..core.es import ensure_ocr_fuzzy_index
from .common import es_text_leg

_fuzzy_cache = TTLCache(maxsize=256, ttl=300)
_EMPTY_FUZZY = pd.DataFrame(columns=["rank", "score", "video_id", "frame_id", "text"])


def search_ocr_fuzzy(query, k: int = config.FETCH_K):
    # OCR has no other leg to fall back on, hence its own ES-down note.
    return es_text_leg(query, k, index=config.ES_INDEX_OCR, ensure_index=ensure_ocr_fuzzy_index,
                       es_query={"match": {"text": {"query": query, "fuzziness": "AUTO"}}},
                       fields=("video_id", "frame_id", "text"), cache=_fuzzy_cache,
                       empty=_EMPTY_FUZZY, label="OCR fuzzy", down_note="showing no results.")


def attach_keyframe_ocr(df: pd.DataFrame) -> pd.DataFrame:
    """OCR is frame-level: frame_id == map-keyframes.n directly, no lookup needed."""
    if df is None or df.empty:
        return df
    out = df.copy()
    out["n"] = out["frame_id"].astype(int)
    return out
