"""
backend/main.py -- FastAPI app entry point. One process serves the JSON
API, the static frontend, and the thumbnail/video media directories --
single-process on purpose, so the loaded model weights (GBs) are never
duplicated across processes.

Run with:
    uvicorn backend.main:app --reload
Then open http://localhost:8000/app/
"""

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from . import config
from .core.es import ensure_all_fuzzy_indices
from .core.models import DEVICE, load_siglip2
from .routes import ROUTERS
from .search import asr as asr_mod
from .search import caption as cap_mod
from .search import keyframe as kf
from .search import summary as sum_mod


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Eager build, once, before the first request is served.
    config.tune_thread_pools(DEVICE)
    print(f"[startup] device={DEVICE} cpu_budget={config.CPU_BUDGET}")
    # Which embedding profile this process is (backend/config.py). Printed
    # first and loudly: two profiles can run side by side on two ports, and
    # nothing downstream of here says which one you're looking at.
    print(f"[startup] profile={config.EMBED_PROFILE} dim={config.EMBED_DIM} "
          f"model={config.SIGLIP2_MODEL_ID}")
    print(f"[startup] indices={config.INDEX_DIR}")

    print("[startup] loading SigLIP2 text/image tower…")
    load_siglip2()

    # Vector counts per index -- a profile whose upstream embedding job only
    # partly finished still starts and searches fine, just over fewer videos,
    # which is otherwise invisible until rankings look off for no reason.
    print("[startup] Keyframe — SigLIP2 frame index")
    frame_index, frame_lookup = kf.build_siglip2_frame_index(config.FRAME_SIGLIP2_GLOB)
    print(f"[startup]   {frame_index.ntotal} frames over "
          f"{frame_lookup['video_id'].nunique()} videos")

    print("[startup] ASR — SigLIP2 index")
    asr_index, asr_meta = asr_mod.build_siglip2_asr_index()
    print(f"[startup]   {asr_index.ntotal} segments over "
          f"{asr_meta['video_id'].nunique()} videos")
    print("[startup] Caption — SigLIP2 index")
    cap_index, cap_meta = cap_mod.build_siglip2_caption_index()
    print(f"[startup]   {cap_index.ntotal} captions over "
          f"{cap_meta['video_id'].nunique()} videos")
    print("[startup] Summary — embeddings + SigLIP2 index")
    sum_index, sum_meta = sum_mod.build_siglip2_summary_index()
    print(f"[startup]   {sum_index.ntotal} "
          f"{'chunks' if config.SUMMARY_CHUNKED else 'summaries'} over "
          f"{sum_meta['video_id'].nunique()} videos")

    print("[startup] ASR/Caption/OCR/Summary — Elasticsearch")
    ensure_all_fuzzy_indices()

    print("[startup] all signals ready")
    yield


class NoCacheStaticFiles(StaticFiles):
    """Forces revalidation (not a no-store -- ETag/Last-Modified still let
    a genuinely-unchanged file 304) on every response this mount serves.
    Plain StaticFiles sets no explicit Cache-Control, so a browser's
    default heuristic freshness (RFC 7234 4.2.2, computed from each
    response's own Last-Modified) can keep serving an old JS/CSS file for
    a while after a real edit, with no visible error: the tab just
    silently keeps running stale frontend code against the live
    (already-updated) backend -- this bit us during TRAKE export UI work,
    a tab kept rendering the pre-edit layout with zero indication anything
    was wrong. Used for /app only, not /media -- those files are large and
    genuinely immutable per video_id/frame, unlike frontend source that
    changes underneath an already-open tab during development."""
    def file_response(self, *args, **kwargs):
        response = super().file_response(*args, **kwargs)
        response.headers["Cache-Control"] = "no-cache"
        return response


app = FastAPI(title="Routing101 by MiLF", lifespan=lifespan)

for router in ROUTERS:  # see backend/routes/__init__.py
    app.include_router(router)

# Media: served directly from the existing AICData* directories, no copying.
app.mount("/media/keyframes", StaticFiles(directory=config.THUMBNAIL_ROOT), name="keyframes")
app.mount("/media/video", StaticFiles(directory=config.VIDEO_DIR), name="video")

# Frontend: static HTML/CSS/JS, served under /app so it doesn't collide
# with /api and /media routes above.
app.mount("/app", NoCacheStaticFiles(directory=config.REPO_ROOT / "frontend", html=True), name="frontend")


@app.get("/")
def root():
    from fastapi.responses import RedirectResponse
    return RedirectResponse("/app/")
