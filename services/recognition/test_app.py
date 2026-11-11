"""Validation/contract tests use a labelled stub, not model accuracy results."""
from io import BytesIO
from fastapi.testclient import TestClient
from PIL import Image
import app as service


def png():
    buffer = BytesIO()
    Image.new("RGB", (32, 24), "white").save(buffer, format="PNG")
    return buffer.getvalue()


def test_invalid_images(monkeypatch):
    client = TestClient(service.app)
    assert client.post("/recognize", content=b"bad", headers={"Content-Type": "text/plain"}).status_code == 415
    assert client.post("/recognize", content=b"", headers={"Content-Type": "image/png"}).status_code == 400
    assert client.post("/recognize", content=b"not an image", headers={"Content-Type": "image/png"}).status_code == 400
    assert client.post("/recognize", content=png(), headers={"Content-Type": "image/jpeg"}).status_code == 400
    assert client.post("/recognize", content=b"x" * (service.MAX_BYTES + 1), headers={"Content-Type": "image/png"}).status_code == 413
    # Exercise decompression-bomb protection without allocating a huge image.
    monkeypatch.setattr(Image, "MAX_IMAGE_PIXELS", 100)
    assert client.post("/recognize", content=png(), headers={"Content-Type": "image/png"}).status_code == 400


def test_model_failure_empty_results_and_busy(monkeypatch):
    client = TestClient(service.app)
    monkeypatch.setattr(service.detector, "model", None)
    assert client.get("/health").status_code == 503
    assert client.post("/recognize", content=png(), headers={"Content-Type": "image/png"}).status_code == 503
    monkeypatch.setattr(service.detector, "model", object())
    monkeypatch.setattr(service.detector, "predict", lambda image: [])
    result = client.post("/recognize", content=png(), headers={"Content-Type": "image/png"})
    assert result.status_code == 200
    assert result.json()["data"]["detections"] == []
    assert result.json()["data"]["image"] == {"width": 32, "height": 24}
    def fail(image):
        raise RuntimeError("test-only failure")
    monkeypatch.setattr(service.detector, "predict", fail)
    assert client.post("/recognize", content=png(), headers={"Content-Type": "image/png"}).status_code == 503
    service.detector.lock.acquire()
    try:
        assert client.post("/recognize", content=png(), headers={"Content-Type": "image/png"}).json()["error"]["code"] == "RECOGNITION_BUSY"
    finally:
        service.detector.lock.release()


def test_dimensions_and_exif():
    data = BytesIO()
    image = Image.new("RGB", (40, 20))
    exif = image.getexif(); exif[274] = 6
    image.save(data, format="JPEG", exif=exif)
    assert service.decode_image(data.getvalue(), "image/jpeg").size == (20, 40)
