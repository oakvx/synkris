#!/usr/bin/env python3
import sys, os, json, datetime

# CORS + content-type
print("Content-Type: application/json")
print("Access-Control-Allow-Origin: *")
print("Access-Control-Allow-Headers: Content-Type")
print("Access-Control-Allow-Methods: POST, OPTIONS")
print()

if os.environ.get("REQUEST_METHOD","GET") == "OPTIONS":
    print(json.dumps({"ok": True}))
    sys.exit(0)

length = int(os.environ.get("CONTENT_LENGTH","0") or 0)
body = sys.stdin.read(length) if length > 0 else "{}"

try:
    data = json.loads(body or "{}")
except Exception as e:
    print(json.dumps({"ok": False, "error":"invalid json","detail":str(e)}))
    sys.exit(0)

# cartella di output accanto al server
outdir = os.path.join(os.path.dirname(__file__), "..", "data")
os.makedirs(outdir, exist_ok=True)

# dump completo
dump_path = os.path.join(outdir, "dashboard_dump.json")
with open(dump_path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)

# estratti utili
def write_section(name, default):
    path = os.path.join(outdir, f"{name}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data.get(name, default), f, ensure_ascii=False, indent=2)

for sec in ["coupons","waitlist","stock","haccp","promotions"]:
    write_section(sec, [])

with open(os.path.join(outdir, "settings.json"), "w", encoding="utf-8") as f:
    json.dump(data.get("settings",{}), f, ensure_ascii=False, indent=2)

print(json.dumps({"ok": True, "saved": dump_path, "ts": datetime.datetime.utcnow().isoformat()+"Z"}))
