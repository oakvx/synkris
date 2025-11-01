#!/usr/bin/env python
import sys
import subprocess
import importlib

# --- Installazione dipendenze ---
def install(pkg):
    subprocess.check_call([sys.executable, "-m", "pip", "install", pkg])

required = {
    "torch": "torch",
    "transformers": "transformers",
    "peft": "peft"
}
for name, module in required.items():
    try:
        importlib.import_module(module)
    except ImportError:
        print(f"[INFO] Installo '{name}'...")
        install(name)

# --- Import librerie ---
import os
import json
from pathlib import Path
import torch
from torch.utils.data import Dataset, Subset
from transformers import (
    AutoTokenizer,
    AutoModelForCausalLM,
    Trainer,
    TrainingArguments,
    DataCollatorForLanguageModeling
)
from peft import LoraConfig, get_peft_model

# --- Offline ---
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

# --- Caricamento modello ---
MODEL_DIR = Path("C:/Users/gaming/Documenti/whatsapp-ai/38-llama-1.4")
model = AutoModelForCausalLM.from_pretrained(
    str(MODEL_DIR),
    torch_dtype=torch.bfloat16,
    local_files_only=True,
)
tokenizer = AutoTokenizer.from_pretrained(
    str(MODEL_DIR),
    use_fast=True,
    local_files_only=True,
)

# --- Dataset JSONL ---
class JSONLDataset(Dataset):
    def __init__(self, path, tokenizer, max_length=512):
        self.tokenizer = tokenizer
        self.max_length = max_length
        with open(path, "r", encoding="utf-8") as f:
            self.data = [json.loads(line) for line in f]
    def __len__(self):
        return len(self.data)
    def __getitem__(self, idx):
        item = self.data[idx]
        text = item["prompt"] + " " + item["completion"]
        enc = self.tokenizer(
            text,
            truncation=True,
            padding="max_length",
            max_length=self.max_length,
            return_tensors="pt"
        )
        return {k: v.squeeze(0) for k, v in enc.items()}

dataset = JSONLDataset("data.jsonl", tokenizer)
val_size = int(0.05 * len(dataset))
train_dataset = Subset(dataset, list(range(len(dataset) - val_size)))
eval_dataset  = Subset(dataset, list(range(len(dataset) - val_size, len(dataset))))

# --- Collator ---
data_collator = DataCollatorForLanguageModeling(
    tokenizer=tokenizer, mlm=False
)

# --- LoRA ---
lora_config = LoraConfig(
    r=16,
    lora_alpha=32,
    target_modules=["q_proj", "v_proj"],
    lora_dropout=0.05,
    bias="none",
    task_type="CAUSAL_LM"
)
model = get_peft_model(model, lora_config)

# --- Device ---
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
model.to(device)

# --- Metriche ---
def compute_metrics(eval_pred):
    import math
    loss = eval_pred.metrics.get("eval_loss")
    return {"perplexity": math.exp(loss)} if loss is not None else {}

# --- TrainingArguments ---
training_args = TrainingArguments(
    output_dir="./outputs",
    per_device_train_batch_size=2,
    gradient_accumulation_steps=8,
    num_train_epochs=3,
    do_eval=True,
    eval_steps=100,
    logging_steps=10,
    save_steps=500,
    save_total_limit=2,
    fp16=torch.cuda.is_available(),
    report_to="none",
    logging_dir="./logs",
    dataloader_pin_memory=False
)

# --- Trainer senza label_names ---
trainer = Trainer(
    model=model,
    args=training_args,
    train_dataset=train_dataset,
    eval_dataset=eval_dataset,
    data_collator=data_collator,
    compute_metrics=compute_metrics
)

if __name__ == "__main__":
    trainer.train()
