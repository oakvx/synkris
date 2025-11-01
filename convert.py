import jsonlines
import torch
from transformers import AutoTokenizer

# 1. Configura il tokenizer (es. GPT-2; sostituisci con il tuo modello se serve)
tokenizer = AutoTokenizer.from_pretrained("gpt2")
tokenizer.pad_token = tokenizer.eos_token  # necessario per il padding

max_length = 512  # o la lunghezza massima che preferisci

input_ids_list = []
attention_masks_list = []
labels_list = []

# 2. Leggi il JSONL e prepara input_ids e labels
with jsonlines.open("data.jsonl") as reader:
    for obj in reader:
        prompt = obj["prompt"]
        completion = obj["completion"]

        # concatena prompt e completion
        full_text = prompt + completion

        # tokenizza tutto
        enc = tokenizer(
            full_text,
            max_length=max_length,
            truncation=True,
            padding="max_length",
            return_tensors="pt"
        )

        input_ids = enc.input_ids.squeeze(0)           # [seq_len]
        attention_mask = enc.attention_mask.squeeze(0)

        # per il training autoregressivo, le label sono gli stessi token,
        # ma puoi mascherare (setto -100) i token del prompt se vuoi
        labels = input_ids.clone()
        prompt_tokens = tokenizer(prompt, return_tensors="pt")["input_ids"].size(1)
        labels[:prompt_tokens] = -100  # non far “contare” il prompt nella loss

        input_ids_list.append(input_ids)
        attention_masks_list.append(attention_mask)
        labels_list.append(labels)

# 3. Accumula in un unico tensor [N, seq_len]
input_ids = torch.stack(input_ids_list)
attention_mask = torch.stack(attention_masks_list)
labels = torch.stack(labels_list)

# 4. Salva tutto in un file .bin
torch.save({
    "input_ids":     input_ids,
    "attention_mask": attention_mask,
    "labels":        labels
}, "dataset.bin")

print("Salvato dataset.bin con", input_ids.size(0), "esempi.")
