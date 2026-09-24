"""
backend/filters/lot.py -- the sidebar's video-id and lot-range filter
("Search in collection" + its "Exclude" checkbox), applied to every leg's
result df right after search, before RRF/head truncation.
"""

import re

import pandas as pd


def parse_lot_range(text: str, exclude: bool = False):
    """'L21-L30' / 'L21' / '21-30' -> (lo, hi, exclude) lot range, or None if
    blank/unparsable. `exclude` flips apply_filters from "keep only this
    range" (the default) to "drop this range" -- the sidebar's "Exclude"
    checkbox next to "Search in collection"."""
    text = (text or "").strip().upper()
    if not text:
        return None
    m = re.match(r"^L?(\d+)\s*-\s*L?(\d+)$", text)
    if m:
        lo, hi = int(m.group(1)), int(m.group(2))
        lo, hi = (lo, hi) if lo <= hi else (hi, lo)
        return (lo, hi, exclude)
    m = re.match(r"^L?(\d+)$", text)
    if m:
        n = int(m.group(1))
        return (n, n, exclude)
    return None


def video_lot_num(video_id: str):
    m = re.match(r"^L(\d+)", str(video_id).upper())
    return int(m.group(1)) if m else None


def video_lot_str(video_id: str) -> str:
    lot = video_lot_num(video_id)
    return f"L{lot}" if lot is not None else str(video_id)


def apply_filters(df: pd.DataFrame, video_filter: str, lot_range) -> pd.DataFrame:
    """Restrict a leg's result df to a single video_id and/or a lot range
    (or, when that range's exclude flag is set, drop it instead of keeping
    only it), applied right after search (before RRF/head truncation) so
    both single-leg and RRF views respect the same filters."""
    if df is None or df.empty:
        return df
    out = df
    video_filter = (video_filter or "").strip().upper()
    if video_filter:
        out = out[out["video_id"].astype(str).str.upper() == video_filter]
    if lot_range:
        lo, hi, exclude = lot_range
        lots = out["video_id"].map(video_lot_num)
        in_range = lots.notna() & (lots >= lo) & (lots <= hi)
        out = out[~in_range] if exclude else out[in_range]
    return out.reset_index(drop=True)
