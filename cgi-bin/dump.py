
import os, json, threading, urllib.parse
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

ROOT = os.path.abspath(os.path.dirname(__file__))
DATA_DIR = os.path.join(ROOT, "data")
DUMP_PATH = os.path.join(DATA_DIR, "dashboard_dump.json")
os.makedirs(DATA_DIR, exist_ok=True)

LOCK = threading.Lock()

def skeleton():
    return {
        "settings": {},
        "coupons": [],
        "waitlist": [],
        "stock": [],
        "haccp": [],
        "promotions": [],
        "promoRule": "",
        "goals": [],
        "clientsMeta": {},
        "i18n": {},
        "bookingsLite": []
    }

def read_dump():
    if not os.path.exists(DUMP_PATH):
        return skeleton()
    try:
        with open(DUMP_PATH, "r", encoding="utf-8") as f:
            obj = json.load(f)
        if not isinstance(obj, dict):
            return skeleton()
        base = skeleton()
        base.update(obj)
        return base
    except Exception:
        return skeleton()

def write_dump(obj):
    tmp = DUMP_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, indent=2)
    os.replace(tmp, DUMP_PATH)

    # Also write shards for convenience
    shards = {
        "coupons": "coupons.json",
        "waitlist": "waitlist.json",
        "stock": "stock.json",
        "promotions": "promotions.json",
        "settings": "settings.json",
        "clientsMeta": "clients.json"
    }
    for k, fname in shards.items():
        path = os.path.join(DATA_DIR, fname)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(obj.get(k, {} if k in ("settings", "clientsMeta") else []), f, ensure_ascii=False, indent=2)

KEYS = {
    "coupons": ["id", "code"],
    "waitlist": ["id", "phone"],
    "stock": ["sku", "name", "id"],
    "promotions": ["id", "name"],
    "goals": ["k", "id", "name"],
    "bookingsLite": ["eventId"]
}

def _key_for(item, keys):
    for k in keys:
        if isinstance(item, dict) and k in item and item[k] is not None:
            return str(item[k])
    return json.dumps(item, sort_keys=True, ensure_ascii=False)

def merge_list(a, b, key_names=None):
    if not isinstance(a, list): a = []
    if not isinstance(b, list): b = []
    if not key_names:
        return a + [x for x in b if x not in a]
    seen = { _key_for(x, key_names): x for x in a }
    for x in b:
        k = _key_for(x, key_names)
        if k in seen and isinstance(seen[k], dict) and isinstance(x, dict):
            seen[k].update(x)
        else:
            seen[k] = x
    return list(seen.values())

def deep_merge(old, new):
    if isinstance(old, dict) and isinstance(new, dict):
        out = dict(old)
        for k, v in new.items():
            if k in KEYS and isinstance(v, list):
                out[k] = merge_list(old.get(k, []), v, KEYS[k])
            elif isinstance(v, dict):
                out[k] = deep_merge(old.get(k, {}), v)
            elif isinstance(v, list):
                out[k] = merge_list(old.get(k, []), v, None)
            else:
                out[k] = v
        return out
    return new if new is not None else old

class Handler(BaseHTTPRequestHandler):
    server_version = "DumpServer/1.0"

    def _set_cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(200)
        self._set_cors()
        self.end_headers()
        self.wfile.write(b"{}")

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/dump":
            self.send_response(404); self._set_cors(); self.end_headers(); return
        qs = urllib.parse.parse_qs(parsed.query or "")
        part = (qs.get("part") or [None])[0]

        with LOCK:
            obj = read_dump()

        payload = obj.get(part, None) if part else obj
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self._set_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path != "/dump":
            self.send_response(404); self._set_cors(); self.end_headers(); return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length > 0 else b"{}"
        try:
            incoming = json.loads(body.decode("utf-8") or "{}")
        except Exception as e:
            self.send_response(400)
            self._set_cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": False, "error": "invalid json", "detail": str(e)}).encode("utf-8"))
            return

        with LOCK:
            cur = read_dump()
            merged = deep_merge(cur, incoming)
            write_dump(merged)

        resp = {"ok": True, "path": DUMP_PATH, "bytes": os.path.getsize(DUMP_PATH)}
        data = json.dumps(resp).encode("utf-8")
        self.send_response(200)
        self._set_cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

def main():
    addr = ("0.0.0.0", 8001)
    httpd = ThreadingHTTPServer(addr, Handler)
    print(f"Dump server running on http://{addr[0]}:{addr[1]}/dump")
    print(f"Data dir: {DATA_DIR}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass

if __name__ == "__main__":
    main()
