export function log(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.log(`[bot-worker] ${message}`);
    return;
  }

  console.log(`[bot-worker] ${message}`, payload);
}

export function warn(message: string, payload?: unknown) {
  if (payload === undefined) {
    console.warn(`[bot-worker] ${message}`);
    return;
  }

  console.warn(`[bot-worker] ${message}`, payload);
}
