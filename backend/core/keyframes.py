"""
backend/core/keyframes.py -- per-video keyframe lookups over
AICData/map-keyframes (n <-> frame_idx <-> pts_time/fps) and the
thumbnail/video URLs the frontend loads through backend/main.py's /media
StaticFiles mounts.
"""

from pathlib import Path

import pandas as pd

from .. import config


def thumbnail_url(video_id: str, n) -> str:
    if n is None or pd.isna(n):
        return ""
    return f"/media/keyframes/{video_id}/{int(n):03d}.jpg"


def thumbnail_disk_path(video_id: str, n) -> Path:
    return config.THUMBNAIL_ROOT / video_id / f"{int(n):03d}.jpg"


def video_url(video_id: str) -> str:
    return f"/media/video/{video_id}.mp4"


_map_keyframes_cache: dict = {}


def load_map_keyframes(video_id: str):
    if video_id not in _map_keyframes_cache:
        path = config.MAP_KEYFRAMES_DIR / f"{video_id}.csv"
        if path.exists():
            df = pd.read_csv(path)
            # Defends against stray junk on the header row (seen on one file
            # in the wild: a leading backtick turned "n" into "`n", which
            # made every mk["n"] lookup below raise KeyError and 500 the
            # whole request) -- normalize instead of trusting the header
            # byte-for-byte, so a similarly mangled file degrades to working
            # rather than crashing.
            df.columns = [str(c).strip().strip("`") for c in df.columns]
            _map_keyframes_cache[video_id] = df
        else:
            _map_keyframes_cache[video_id] = None
    return _map_keyframes_cache[video_id]


def nearest_keyframe_n_by_time(video_id: str, t: float):
    """Nearest map-keyframes row (by pts_time) to timestamp t -- used for
    the ASR fuzzy leg, which is segment-level only (no direct frame_id)."""
    mk = load_map_keyframes(video_id)
    if mk is None or mk.empty or pd.isna(t):
        return None
    idx = (mk["pts_time"] - t).abs().idxmin()
    return int(mk.loc[idx, "n"])


def keyframe_timestamp(video_id: str, n):
    """Symmetric counterpart to nearest_keyframe_n_by_time: direct n ->
    (pts_time, fps) lookup, used by TRAKE to place a matched frame on the
    video timeline. Returns (None, None) if unresolvable."""
    mk = load_map_keyframes(video_id)
    if mk is None or mk.empty or n is None or pd.isna(n):
        return None, None
    hit = mk.loc[mk["n"] == int(n)]
    if hit.empty:
        return None, None
    row = hit.iloc[0]
    return float(row["pts_time"]), float(row["fps"])


def frame_idx_for_n(video_id: str, n):
    """n (1-indexed keyframe ordinal, the field every result carries) ->
    frame_idx (raw video frame index) -- used by backend/export.py, since
    AIC submission CSVs expect frame_idx, not n. Returns None if
    unresolvable."""
    mk = load_map_keyframes(video_id)
    if mk is None or mk.empty or n is None or pd.isna(n):
        return None
    hit = mk.loc[mk["n"] == int(n)]
    if hit.empty:
        return None
    return int(hit.iloc[0]["frame_idx"])


def valid_ns_for_video(video_id: str) -> set:
    """Every n that actually exists for video_id -- used by backend/export.py
    to filter out-of-range hedge offsets (n-1, n+2, ...) before they'd
    resolve to a nonexistent keyframe."""
    mk = load_map_keyframes(video_id)
    if mk is None or mk.empty:
        return set()
    return set(mk["n"].astype(int))


def n_for_frame_idx(video_id: str, frame_idx: int):
    """Reverse of frame_idx_for_n: native frame_idx -> keyframe n, only if
    frame_idx exactly matches an existing keyframe's frame_idx. Used by
    TRAKE row generation (backend/export.py::generate_trake_rows) to tell
    apart a keyframe-backed pick (neighbours ranked by keyframe-index
    distance) from a raw native-frame pick with no embedding behind it
    (neighbours ranked by plain frame-number distance instead). Returns
    None if frame_idx isn't any keyframe's, including when map-keyframes
    itself is missing for video_id."""
    mk = load_map_keyframes(video_id)
    if mk is None or mk.empty or frame_idx is None:
        return None
    hit = mk.loc[mk["frame_idx"] == int(frame_idx)]
    if hit.empty:
        return None
    return int(hit.iloc[0]["n"])


def nearest_keyframe_n_for_frame_idx(video_id: str, frame_idx: int):
    """Nearest keyframe n to a native frame_idx by |frame_idx - keyframe's
    own frame_idx| -- unlike n_for_frame_idx, always returns *some*
    keyframe (as long as the video has any indexed at all), not just an
    exact match. Used to seed a visual-similarity search, or a "Keyframes"
    checkbox re-check, from a raw native frame (Export tab, Keyframes
    unchecked) that has no embedding/n of its own. Returns None only if
    map-keyframes has no rows for video_id."""
    mk = load_map_keyframes(video_id)
    if mk is None or mk.empty or frame_idx is None:
        return None
    idx = (mk["frame_idx"] - int(frame_idx)).abs().idxmin()
    return int(mk.loc[idx, "n"])


def native_frame_range_for_video(video_id: str):
    """(lo, hi) bound on real frame_idx values for video_id, used by TRAKE
    row generation to keep interpolated/hedge frame numbers in range. Only
    as precise as map-keyframes' own frame_idx column (the true last video
    frame can run a little past the last keyframe's) -- good enough for a
    filler-row bound, not claimed to be the exact video length. Falls back
    to a generous synthetic range if map-keyframes is missing entirely, so
    callers never have to special-case "no data" themselves."""
    mk = load_map_keyframes(video_id)
    if mk is None or mk.empty:
        return (0, 10**7)
    return (0, int(mk["frame_idx"].max()))


def video_fps_for_video(video_id: str) -> float:
    """Any one row's fps for video_id -- map-keyframes stores the same fps
    on every row for a given video. Used to start TRAKE curation playback
    from a bare video_id, before any keyframe/timestamp is known yet.
    Falls back to the same 25.0 default backend/routes/media.py already
    uses when a specific frame's fps can't be resolved."""
    mk = load_map_keyframes(video_id)
    if mk is None or mk.empty:
        return 25.0
    return float(mk.iloc[0]["fps"])
