"""
backend/routes/playback.py -- single-frame video playback, used by the
play button on every non-TRAKE signal's result row (TRAKE's marker-bar
playback also calls it, for fps). This endpoint only needs a single
frame's timestamp.

`n` is optional: the TRAKE Export tab's curation panel starts a video
playing from a bare video_id, before any keyframe/event is known yet (an
empty event list has no frame to seek to) -- omitting n skips the
keyframe_timestamp lookup and starts at 0:00 instead.
"""

from typing import Optional

from fastapi import APIRouter, HTTPException

from .. import config
from ..core.keyframes import keyframe_timestamp, video_fps_for_video, video_url

router = APIRouter()


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
