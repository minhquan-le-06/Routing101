"""backend/routes/ -- FastAPI endpoints, grouped by what the frontend uses
them for:
  search/   everything the sidebar/search box talks to (/api/search/*,
            /api/query-image, /api/facets)
  results/  what you do with a result (nearby frames, playback, export)
  settings.py  /api/profile + /api/settings
  schemas.py   request/response models shared across the search routes

ROUTERS is the one list backend/main.py registers, in this order.
"""

from .results import export, media
from .search import facets, hierarchy, query_image, signals, trake
from . import settings

ROUTERS = [
    signals.router,
    facets.router,
    media.router,
    query_image.router,
    trake.router,
    hierarchy.router,
    export.router,
    settings.router,
]
