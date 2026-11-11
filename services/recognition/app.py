"""Local, memory-only YOLO-World inference. Start with one Uvicorn worker."""
import asyncio
from contextlib import asynccontextmanager
from io import BytesIO
import logging
import json
import os
from pathlib import Path
import threading
import warnings

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from PIL import Image, ImageOps, UnidentifiedImageError

ROOT = Path(__file__).resolve().parent
CACHE = ROOT / ".cache"
CACHE.mkdir(exist_ok=True)
os.environ.setdefault("YOLO_CONFIG_DIR", str(CACHE))
os.environ.setdefault("YOLO_AUTOINSTALL", "false")
os.environ.setdefault("TORCH_HOME", str(CACHE / "torch"))
MAX_BYTES = 10 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 20_000_000
INGREDIENTS = json.loads((ROOT.parents[1] / "shared" / "recognition-ingredients.json").read_text(encoding="utf-8"))
CLASSES = [item["prompt"] for item in INGREDIENTS]
NAMES = [item["name"] for item in INGREDIENTS]
if len(set(CLASSES)) != len(CLASSES) or len(set(NAMES)) != len(NAMES):
    raise ValueError("Recognition names and prompts must be unique")
MODEL_PATH = Path(os.environ.get("YOLO_MODEL_PATH", str(CACHE / "ingredients-worldv2-l.pt")))
DEVICE = os.environ.get("YOLO_DEVICE", "cpu")
logger = logging.getLogger("recognition")


class Detector:
    def __init__(self):
        self.model = None
        self.lock = threading.Lock()

    def load(self, model_path=MODEL_PATH):
        from ultralytics import YOLOWorld
        # Download weights explicitly during setup, never silently at request time.
        if not model_path.is_file():
            raise FileNotFoundError("Run services/recognition/setup_model.py first.")
        model = YOLOWorld(str(model_path))
        if list(model.names.values()) != CLASSES:
            raise ValueError("Prepared vocabulary is outdated. Run setup_model.py and restart.")
        model.predict(Image.new("RGB", (640, 640)), device=DEVICE, verbose=False)
        self.model = model

    def predict(self, image):
        if self.model is None:
            raise RuntimeError("Model unavailable")
        result = self.model.predict(image, conf=0.45, iou=0.5, imgsz=640,
                                    agnostic_nms=True, max_det=50, device=DEVICE, verbose=False)[0]
        return [{"name": NAMES[int(box.cls.item())],
                 "confidence": round(float(box.conf.item()), 4),
                 "box": [round(float(value), 2) for value in box.xyxy[0].tolist()]}
                for box in result.boxes]


detector = Detector()


@asynccontextmanager
async def lifespan(app):
    try:
        await asyncio.to_thread(detector.load)
    except Exception:
        detector.model = None
        logger.exception("YOLO-World could not load; run setup_model.py and restart.")
    yield


app = FastAPI(title="Friend's Fridge recognition", lifespan=lifespan)


def error(status, code, message):
    return JSONResponse(status_code=status, content={"error": {"code": code, "message": message}})


def decode_image(data, content_type):
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(BytesIO(data)) as source:
            expected = {"image/jpeg": "JPEG", "image/png": "PNG"}[content_type]
            if source.format != expected:
                raise ValueError("Image format does not match Content-Type")
            if source.width * source.height > 20_000_000:
                raise ValueError("Image exceeds 20 megapixels")
            source.load()
            return ImageOps.exif_transpose(source).convert("RGB")


@app.get("/health")
async def health():
    ready = detector.model is not None
    return JSONResponse(status_code=200 if ready else 503, content={"status": "ready" if ready else "unavailable", "model": MODEL_PATH.name, "device": DEVICE, "class_count": len(NAMES)})


@app.post("/recognize")
async def recognize(request: Request):
    content_type = request.headers.get("content-type", "").split(";")[0].strip()
    if content_type not in ("image/jpeg", "image/png"):
        return error(415, "INVALID_IMAGE_TYPE", "Choose a JPG or PNG image.")
    # Reject excess work rather than building an unbounded inference queue.
    if not detector.lock.acquire(blocking=False):
        return error(503, "RECOGNITION_BUSY", "Recognition is busy. Please try again shortly.")
    try:
        data = bytearray()
        async for chunk in request.stream():
            if len(data) + len(chunk) > MAX_BYTES:
                return error(413, "IMAGE_TOO_LARGE", "Image must be 10 MB or smaller.")
            data.extend(chunk)
        if not data:
            return error(400, "EMPTY_IMAGE", "Choose a non-empty image.")
        try:
            image = await asyncio.to_thread(decode_image, data, content_type)
        except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError, Image.DecompressionBombWarning):
            return error(400, "INVALID_IMAGE", "Cannot read this image. Use a valid JPG or PNG up to 20 megapixels.")
        if detector.model is None:
            return error(503, "MODEL_UNAVAILABLE", "Recognition model is unavailable. Start the model service after running setup.")
        try:
            detections = await asyncio.to_thread(detector.predict, image)
        except Exception:
            logger.exception("Inference failed")
            return error(503, "INFERENCE_FAILED", "Recognition failed. Try another photo or add ingredients manually.")
        return {"data": {"model": MODEL_PATH.name, "source": "model", "image": {"width": image.width, "height": image.height}, "detections": detections}}
    finally:
        detector.lock.release()
