"""
backend/routes/schemas.py -- request/response pieces shared across the
search routes (search.py, hierarchy.py, trake.py). Each route's own
request model extends one of these bases and adds only its own fields.
"""

from typing import Optional

from pydantic import BaseModel

from .. import config


class SearchScope(BaseModel):
    """Result count + the sidebar filters every search accepts."""
    top_k: int = config.DISPLAY_N
    video_filter: str = ""
    lot_filter: str = ""
    exclude_lot: bool = False
    facet_field: str = ""
    facet_value: str = ""


class QuerySearchRequest(SearchScope):
    """One query -- typed text, or a pasted image by its /api/query-image id
    (see backend/core/query.py) -- plus the object-detection filter."""
    query: Optional[str] = None
    image_id: Optional[str] = None
    od_filter: str = ""


class LegResult(BaseModel):
    skipped: Optional[str] = None
    warning: Optional[str] = None
    results: list = []
