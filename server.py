from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from transformers import pipeline
from dotenv import load_dotenv
import os

load_dotenv()

MODEL_PATH = os.getenv("MODEL_PATH")
HOST = os.getenv("HOST")
PORT = int(os.getenv("PORT"))

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
try:
    classifier = pipeline(
        "text-classification",
        model=MODEL_PATH,
        return_all_scores=True
    )
    print("Model loaded successfully")
except Exception as e:
    print(f"Error loading model: {e}")
    classifier = None

class EmailRequest(BaseModel):
    subject: str
    sender: str
    body: str = ""

@app.get("/health")
def health():
    return {
        "status": "ok",
        "model_loaded": classifier is not None
    }

@app.post("/classify")
def classify(req: EmailRequest):
    if classifier is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    text = f"From: {req.sender} Subject: {req.subject} {req.body[:500]}"

    try:
        scores = classifier(text)[0]
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

        return {
            "category": label,
            "confidence": round(top["score"], 3),
            "spamScore": round(spam_score, 3),
            "isSpam": spam_score > 0.7
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host=HOST, port=PORT)

