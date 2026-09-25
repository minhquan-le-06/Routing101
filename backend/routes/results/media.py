"""
backend/routes/media.py -- per-frame media lookups behind the result-row
popups: nearby keyframes ("Show more") and single-frame video playback.

/api/neighbors: the dialog's window (its base size per tile-size setting,
plus its expand counters) is pure frontend state, so this endpoint is
stateless: `before`/`after` are the total frames wanted on each side, and
the frontend passes whatever it's currently showing.

/api/playback: used by the play button on every non-TRAKE signal's result
row (TRAKE's marker-bar playback also calls it, for fps); only needs a
single frame's timestamp. `n` is optional: the TRAKE Export tab's curation
panel starts a video playing from a bare video_id, before any
keyframe/event is known yet (an empty event list has no frame to seek to)
-- omitting n skips the keyframe_timestamp lookup and starts at 0:00.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException

from .. import config
from ..core.keyframes import (keyframe_timestamp, thumbnail_disk_path, thumbnail_url,
                              video_fps_for_video, video_url)

router = APIRouter()


@router.get("/api/neighbors")
def get_neighbors(
    video_id: str,
    center_n: int,
    before: int = config.NEIGHBOR_WINDOW,
    after: int = config.NEIGHBOR_WINDOW,
):
    lo = max(0, before)
    hi = max(0, after)
    candidates = [center_n + d for d in range(-lo, hi + 1) if center_n + d >= 1]
    return {
        "video_id": video_id,
        "center_n": center_n,
        "frames": [
            {
                "n": n,
                "thumbnail_url": thumbnail_url(video_id, n),
                "exists": thumbnail_disk_path(video_id, n).exists(),
                "is_center": n == center_n,
            }
            for n in candidates
        ],
    }


@router.get("/api/playback")
def get_playback(video_id: str, n: Optional[int] = None):
    if not (config.VIDEO_DIR / f"{video_id}.mp4").exists():
        raise HTTPException(404, f"Video file not found for {video_id}.")
    if n is None:
        ts, fps = 0, video_fps_for_video(video_id)
    else:
        ts, fps = keyframe_timestamp(video_id, n)
    return {
        "video_id": video_id,
        "video_url": video_url(video_id),
        "start_time": ts if ts is not None else 0,
        # Live frame-timer support (frontend computes round(currentTime * fps)
        # on every timeupdate) -- falls back to a sane default if this
        # particular frame's fps couldn't be resolved.
        "fps": fps if fps is not None else 25.0,
    }
