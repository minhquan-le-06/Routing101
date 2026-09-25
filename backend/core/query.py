"""
backend/core/query.py -- picture-query store + the request-to-query
resolver every search route shares. The frontend posts a pasted/uploaded
image once (backend/routes/search/query_image.py), gets back a short-lived
`image_id`, then passes that id (instead of `query` text) to any search
endpoint; `resolve_query()` turns a request body's `query`/`image_id` into
the str-or-PIL.Image object every search_* function expects.
"""

import uuid

from cachetools import TTLCache
from fastapi import HTTPException
from PIL import Image

# image_id -> PIL.Image, 5-minute TTL -- long enough for a user to paste an
# image and fire a search, short enough not to leak memory over a long
# session (there's no per-session server state to hang it on instead).
_IMAGES: TTLCache = TTLCache(maxsize=64, ttl=300)


def store_query_image(image: Image.Image) -> str:
    image_id = uuid.uuid4().hex
    _IMAGES[image_id] = image
    return image_id


def resolve_query(query: str | None, image_id: str | None):
    """A picture query takes priority over typed text if both are somehow
    sent, matching the frontend's own precedence: a pasted image replaces
    the loaded text query in the UI, not additive."""
    if image_id:
        image = _IMAGES.get(image_id)
        if image is None:
            raise HTTPException(400, "That pasted image has expired -- please paste it again.")
        return image
    if query and query.strip():
        return query
    raise HTTPException(400, "Provide a `query` string or an `image_id`.")
