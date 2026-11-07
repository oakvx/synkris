/** Bounded, non-identifying process telemetry. No message contents or phone numbers. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
const context = new AsyncLocalStorage();
const counters = new Map();
export function withTrace(fn) { return context.run({ traceId: randomUUID() }, fn); }
export function getTraceId() { return context.getStore()?.traceId || null; }
export function count(name, amount = 1) {
  if (!/^[a-z_]{1,64}$/.test(name) || !Number.isFinite(amount)) throw new Error('Invalid metric');
  counters.set(name, (counters.get(name) || 0) + amount);
}
export function getMetrics() { return Object.fromEntries(counters); }
