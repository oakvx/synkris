@echo off
:: Script di training LoRA con llama.cpp
:: Assicurati di avere compilato llama.cpp in ./llama.cpp/build/bin

set MODEL_PATH=.\models\llama3.gguf
set DATA_PATH=.\training_data.json
set LORA_OUT=.\lora-out
set THREADS=8
set EPOCHS=3
set BATCH=2

:: Avvia il training
.\llama.cpp\build\bin\llama-train ^
  --model %MODEL_PATH% ^
  --train-data %DATA_PATH% ^
  --lora-out %LORA_OUT% ^
  --epochs %EPOCHS% ^
  --batch-size %BATCH% ^
  --threads %THREADS%

pause
