// Text normalization and small formatting helpers extracted from core util.

export function escapeReg(s) {
  return (s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function listToOptions(arr) {
  return arr.map((v, i) => `${i + 1}) ${v}`).join("\n");
}

export function simpleNorm(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function _normIncomingForDedup(s) {
  const raw = String(s || "");
  const cleaned = raw.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
  const base = typeof norm === "function" ? norm(cleaned) : cleaned.toLowerCase();
  return String(base).replace(/\s+/g, " ").trim();
}

export function _norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");
}

export function norm(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}
