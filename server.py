import logging
import os
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import pipeline
from dotenv import load_dotenv

load_dotenv()

MODEL_PATH = os.getenv("MODEL_PATH")
HOST = os.getenv("HOST")
PORT = int(os.getenv("PORT"))

LOG_DIR = Path("./logs")
LOG_DIR.mkdir(exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(message)s",
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(LOG_DIR / "server.log", encoding="utf-8"),
    ],
)
logger = logging.getLogger("mailblock.server")

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def log_requests(request: Request, call_next):
    start = time.perf_counter()
    logger.info("Request started: %s %s", request.method, request.url.path)
    try:
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - start) * 1000, 1)
        logger.info(
            "Request finished: %s %s -> %s in %sms",
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
        )
        return response
    except Exception:
        duration_ms = round((time.perf_counter() - start) * 1000, 1)
        logger.exception(
            "Request failed: %s %s after %sms",
            request.method,
            request.url.path,
            duration_ms,
        )
        raise

try:
    logger.info("Loading classifier from %s", MODEL_PATH)
    classifier = pipeline(
        "text-classification",
        model=MODEL_PATH,
        top_k=None
    )
    logger.info("Model loaded successfully")
except Exception as e:
    logger.exception("Error loading model: %s", e)
    classifier = None

class EmailRequest(BaseModel):
    subject: str
    sender: str
    body: str = ""

@app.get("/health")
def health():
    logger.info("Health check requested; model_loaded=%s", classifier is not None)
    return {
        "status": "ok",
        "model_loaded": classifier is not None
    }

@app.post("/classify")
def classify(req: EmailRequest):
    if classifier is None:
        logger.warning("Classification requested but model is not loaded")
        raise HTTPException(status_code=503, detail="Model not loaded")

    text = f"From: {req.sender} Subject: {req.subject} {req.body[:500]}"
    logger.info(
        "Classify request: sender=%r subject=%r body_chars=%s",
        req.sender[:120],
        req.subject[:160],
        len(req.body),
    )

    try:
        raw_output = classifier(text)
        scores = raw_output[0] if raw_output and isinstance(raw_output[0], list) else raw_output
        if not isinstance(scores, list):
            raise ValueError(f"Unexpected classifier output: {raw_output!r}")

        top = max(scores, key=lambda x: x["score"])

        label = top["label"]
        if label.startswith("LABEL_"):
            id2label = {
                "LABEL_0": "Spam",
                "LABEL_1": "Work",
                "LABEL_2": "Finance",
                "LABEL_3": "Newsletter",
                "LABEL_4": "Personal",
                "LABEL_5": "Promotions"
            }
            label = id2label.get(label, label)

        spam_score = next(
            (s["score"] for s in scores if s["label"] in ["LABEL_0", "Spam"]),
            0.0
        )

        result = {
            "category": label,
            "confidence": round(top["score"], 3),
            "spamScore": round(spam_score, 3),
            "isSpam": spam_score > 0.7
        }
        logger.info(
            "Classify result: category=%s confidence=%.3f spam_score=%.3f",
            result["category"],
            result["confidence"],
            result["spamScore"],
        )
        logger.debug("Raw classifier scores: %s", scores)
        return result
    except Exception as e:
        logger.exception("Classification failed: %s", e)
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    logger.info("Starting server on %s:%s", HOST, PORT)
    uvicorn.run(app, host=HOST, port=PORT)
