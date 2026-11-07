// ============== LLM Output Sanitization ==============
const CHATML_STOPS = [
  "<|im_start|>system",
  "<|im_start|>user",
  "<|im_start|>assistant",
  "</s>",
  "<think>",
  "</think>",
];

export function stripStopsAndTags(raw) {
  if (!raw) return "";
  let s = String(raw);
  // rimuovi codefence esterno (se presente)
  s = s.replace(/^```[a-zA-Z0-9]*\n?/, "").replace(/```$/, "");
  for (const tok of CHATML_STOPS) s = s.split(tok).join("");
  s = s.replace(/<\|im_end\|>/g, "");
  return s.trim();
}

export function stripThinkBlocks(s) {
  s = String(s || "");
  // tutte le varianti note di "pensiero"
  s = s
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```think[\s\S]*?```/gi, "")
    .replace(/\[think\][\s\S]*?\[\/think\]/gi, "")
    // extra robustness per altri tag usati da alcuni modelli
    .replace(
      /<(analysis|reasoning|scratchpad|chain_of_thought)>[\s\S]*?<\/\1>/gi,
      ""
    );
  return s;
}

export function extractJSONObject(text) {
  const s = stripStopsAndTags(stripThinkBlocks(text));
  let start = -1,
    depth = 0,
    inStr = false,
    esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) {
        esc = false;
        continue;
      }
      if (ch === "\\") {
        esc = true;
        continue;
      }
      if (ch === '"') {
        inStr = false;
        continue;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) return s.slice(start, i + 1);
    }
  }
  return "";
}

export function parseJsonMessage(raw) {
  const json = extractJSONObject(raw);
  if (!json) return "";
  try {
    const o = JSON.parse(json);
    const msg =
      o?.message ??
      o?.response ??
      o?.answer ??
      o?.content ??
      o?.text ??
      o?.output;
    return (msg || "").toString().trim();
  } catch {
    return "";
  }
}

export function sanitizeLLM(raw) {
  const s = stripStopsAndTags(stripThinkBlocks(raw || ""));
  const parsed = parseJsonMessage(s);
  return (parsed || s).trim();
}
