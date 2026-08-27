"""
backend/routes/routing.py -- LLM-based query routing endpoints. Job store
modeled on backend/routes/query_image.py's TTLCache pattern, but guarded
by a Lock: unlike query_image.py's _IMAGES (touched only from async route
handlers on the single event-loop thread), _JOBS is also mutated from a
FastAPI BackgroundTasks worker thread, so concurrent dict/TTLCache
mutation across threads is a real possibility here.
"""

import threading
import time
import uuid
from typing import Optional

from cachetools import TTLCache
from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel

from .. import config
from ..common import parse_lot_range
from ..search import routing as routing_mod

router = APIRouter()

_JOBS: TTLCache = TTLCache(maxsize=config.ROUTING_JOB_CACHE_MAXSIZE, ttl=config.ROUTING_JOB_TTL_SEC)
_LOCK = threading.Lock()


def _active_job_count() -> int:
    with _LOCK:
        return sum(1 for j in _JOBS.values() if j["status"] == "running")


class RoutingSearchRequest(BaseModel):
    query: str
    video_filter: str = ""
    lot_filter: str = ""
    exclude_lot: bool = False
    top_k: int = config.ROUTING_FINAL_TOP_N


class RoutingJobStatus(BaseModel):
    job_id: str
    status: str  # "running" | "done" | "error"
    query: str
    created_at: float
    step1: Optional[dict] = None
    results: Optional[list] = None
    run_summary: Optional[list] = None
    n_runs: Optional[int] = None
    warnings: Optional[list] = None
    error: Optional[str] = None


@router.post("/api/routing/search", response_model=RoutingJobStatus)
def start_routing_job(body: RoutingSearchRequest, background_tasks: BackgroundTasks):
    query = (body.query or "").strip()
    if not query:
        raise HTTPException(400, "Provide a query.")
    if _active_job_count() >= config.ROUTING_MAX_CONCURRENT_JOBS:
        raise HTTPException(
            429,
            f"{config.ROUTING_MAX_CONCURRENT_JOBS} routing jobs are already running -- "
            "wait for one to finish (or check the job list) before starting another.",
        )

    # Step 1 runs synchronously -- one fast LLM call, so the operator sees
    # keywords/paraphrasings/modalities in this same response rather than
    # having to poll just to see Step 1's output.
    try:
        step1 = routing_mod.preprocess_query(query)
    except routing_mod.RoutingLLMError as e:
        raise HTTPException(502, f"[Routing] Step 1 (Gemini) failed: {e}")

    job_id = uuid.uuid4().hex
    lot_filter = parse_lot_range(body.lot_filter, body.exclude_lot)
    final_top_n = max(1, min(body.top_k or config.ROUTING_FINAL_TOP_N, 200))
    job = {
        "job_id": job_id, "status": "running", "query": query, "created_at": time.time(),
        "step1": step1, "results": None, "run_summary": None, "n_runs": None,
        "warnings": None, "error": None,
    }
    with _LOCK:
        _JOBS[job_id] = job

    background_tasks.add_task(_run_job_background, job_id, step1, body.video_filter, lot_filter, final_top_n)
    return RoutingJobStatus(**job)


def _run_job_background(job_id: str, step1: dict, video_filter: str, lot_filter, final_top_n: int):
    try:
        outcome = routing_mod.execute_routing_job(step1, video_filter, lot_filter,
                                                    config.ROUTING_PER_RUN_TOP_K, final_top_n)
        update = {"status": "done", **outcome}
    except Exception as e:
        update = {"status": "error", "error": str(e)}
    with _LOCK:
        job = _JOBS.get(job_id)
        if job is not None:  # may have been evicted by TTL already -- fine, just drop the update
            job.update(update)


@router.get("/api/routing/jobs/{job_id}", response_model=RoutingJobStatus)
def get_routing_job(job_id: str):
    with _LOCK:
        job = _JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "That routing job has expired or doesn't exist -- start a new search.")
    return RoutingJobStatus(**job)


@router.get("/api/routing/jobs")
def list_routing_jobs():
    with _LOCK:
        jobs = sorted(_JOBS.values(), key=lambda j: j["created_at"], reverse=True)
    return {"jobs": [{"job_id": j["job_id"], "status": j["status"], "query": j["query"],
                       "created_at": j["created_at"]} for j in jobs]}
