export function toIsoString(value: Date | null | undefined): string | null {
  return value ? value.toISOString() : null;
}

export function stringifyId(value: bigint | number | string): string {
  return String(value);
}

export function normalizeDigits(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits || null;
}
