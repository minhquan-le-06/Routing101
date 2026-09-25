"""
backend/routes/search/query_image.py -- picture-query upload endpoint. Decodes the
pasted/uploaded image and hands it to backend/core/query.py's short-lived
store; search routes later resolve the returned `image_id` through
core.query.resolve_query().
"""

import io

from fastapi import APIRouter, HTTPException, UploadFile
from PIL import Image

from ...core.query import store_query_image

router = APIRouter()


@router.post("/api/query-image")
async def upload_query_image(file: UploadFile):
    raw = await file.read()
    try:
        image = Image.open(io.BytesIO(raw)).convert("RGB")
    except Exception as e:
        raise HTTPException(400, f"Couldn't decode the pasted image ({e}).")
    return {"image_id": store_query_image(image)}
