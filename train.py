import pandas as pd
import numpy as np
from datasets import Dataset
from sklearn.metrics import accuracy_score
from transformers import (
    DistilBertTokenizerFast,
    DistilBertForSequenceClassification,
    TrainingArguments,
    Trainer
)
from dotenv import load_dotenv
import os

load_dotenv()

TRAIN_DATA_PATH = os.getenv("TRAIN_DATA_PATH", "./data/emails.csv")

LABEL2ID = {
    "Spam": 0,
    "Work": 1,
    "Finance": 2,
    "Newsletter": 3,
    "Personal": 4,
    "Promotions": 5
}
ID2LABEL = {v: k for k, v in LABEL2ID.items()}

def prepare_dataframe(path):
    df = pd.read_csv(path)
    df["label"] = df["label"].map(LABEL2ID)
    df = df.dropna(subset=["label"])
    df["label"] = df["label"].astype(int)
    return df[["text", "label"]]

def load_data():
    train_df = prepare_dataframe(TRAIN_DATA_PATH)
    dataset = Dataset.from_pandas(train_df, preserve_index=False)
    split = dataset.train_test_split(test_size=0.2, seed=42)
    return split["train"], split["test"]

def tokenize(batch):
    return tokenizer(
        batch["text"],
        truncation=True,
        padding=True,
        max_length=256
    )

def compute_metrics(pred):
    labels = pred.label_ids
    preds = np.argmax(pred.predictions, axis=1)
    return {"accuracy": accuracy_score(labels, preds)}

if __name__ == "__main__":
    tokenizer = DistilBertTokenizerFast.from_pretrained("distilbert-base-uncased")

    model = DistilBertForSequenceClassification.from_pretrained(
        "distilbert-base-uncased",
        num_labels=len(LABEL2ID),
        id2label=ID2LABEL,
        label2id=LABEL2ID
    )

    train_dataset, eval_dataset = load_data()
    train_dataset = train_dataset.map(tokenize, batched=True)
    eval_dataset = eval_dataset.map(tokenize, batched=True)

    args = TrainingArguments(
        output_dir="./email-classifier",
        num_train_epochs=4,
        per_device_train_batch_size=16,
        per_device_eval_batch_size=16,
        eval_strategy="epoch",
        save_strategy="epoch",
        load_best_model_at_end=True,
        logging_dir="./logs",
        logging_steps=10,
    )

    trainer = Trainer(
        model=model,
        args=args,
        train_dataset=train_dataset,
        eval_dataset=eval_dataset,
        compute_metrics=compute_metrics,
    )

    trainer.train()

    print("Saving model...")
    model.save_pretrained("./email-classifier-final")
    tokenizer.save_pretrained("./email-classifier-final")
