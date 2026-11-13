import { READONLY_LIVE_RESPONSE_EXTENSION_LIMITS as limits } from '../domain/readonly-live.js';
import { canonicalReadonlyJson } from './readonly-investigation-policy.js';
import { containsSensitiveText } from './redaction.js';

type ExtensionReason = 'extension-key' | 'extension-limit' | 'extension-value' | 'extension-sensitive' | 'extension-control';
interface Projection { value: unknown; reason: ExtensionReason | null }
const controlKeys = new Set(['type', 'role', 'content', 'input', 'tool_calls', 'function_call', 'function', 'refusal',
  'actions', 'commands', 'command', 'execution', 'tool_results', '__proto__', 'constructor', 'prototype']);
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const failures = new WeakMap<object, ExtensionReason>();
const reject: (reason: ExtensionReason) => never = (reason) => {
  const error = new Error('Response extension rejected'); failures.set(error, reason); throw error;
};
const validString = (value: string): boolean => Buffer.from(value).toString('utf8') === value;
const ownData = (value: object): Map<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) reject('extension-value');
  const fields = new Map<string, unknown>();
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !validString(key)) reject('extension-value');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject('extension-value');
    fields.set(key, descriptor.value);
  }
  return fields;
};
const allowedNames = (value: readonly string[]): Set<string> => {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) reject('extension-key');
  const length = Object.getOwnPropertyDescriptor(value, 'length');
  if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value)
    || length.value < 0 || length.value > 128 || Reflect.ownKeys(value).length !== length.value + 1) reject('extension-key');
  const names = new Set<string>();
  for (let index = 0; index < length.value; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable
      || typeof descriptor.value !== 'string' || descriptor.value.length > limits.keyCharacters
      || !identifier.test(descriptor.value) || names.has(descriptor.value)) reject('extension-key');
    names.add(descriptor.value);
  }
  return names;
};

/** The extension bag is node one at depth zero; nested values consume the shared budget. */
const snapshotExtensions = (fields: Map<string, unknown>): Record<string, unknown> => {
  let nodes = 1; const ancestors = new Set<object>();
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > limits.nodes || depth > limits.depth) reject('extension-limit');
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : reject('extension-value');
    if (typeof value === 'string') {
      if (!validString(value)) reject('extension-value');
      if (Buffer.byteLength(value) > limits.bytes) reject('extension-limit');
      return value;
    }
    if (!value || typeof value !== 'object') return reject('extension-value');
    if (ancestors.has(value)) reject('extension-value');
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) reject('extension-value');
        const length = Object.getOwnPropertyDescriptor(value, 'length');
        if (!length || !Object.hasOwn(length, 'value') || !Number.isSafeInteger(length.value) || length.value < 0) reject('extension-value');
        if (length.value > limits.nodes - nodes) reject('extension-limit');
        if (Reflect.ownKeys(value).length !== length.value + 1) reject('extension-value');
        const result: unknown[] = [];
        for (let index = 0; index < length.value; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) reject('extension-value');
          result.push(copy(descriptor.value, depth + 1));
        }
        return result;
      }
      const result: Record<string, unknown> = Object.create(null);
      for (const [key, child] of ownData(value)) {
        if (Buffer.byteLength(key) > limits.bytes) reject('extension-limit');
        result[key] = copy(child, depth + 1);
      }
      return result;
    } finally { ancestors.delete(value); }
  };
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of fields) result[key] = copy(value, 1);
  return result;
};

/** Only unused extensions are inspected and discarded; known values retain their original validation path. */
export const projectReadonlyLiveResponseExtensions = (value: unknown, allowedKeys: readonly string[]): Projection => {
  try {
    const allowed = allowedNames(allowedKeys);
    // Keep malformed Response roots for the existing strict object validator to reject.
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { value, reason: null };
    const fields = ownData(value);
    const extras = new Map([...fields].filter(([key]) => !allowed.has(key)));
    if (extras.size === 0) return { value, reason: null };
    if (extras.size > limits.fields) reject('extension-limit');
    for (const key of extras.keys()) {
      if (controlKeys.has(key)) reject('extension-control');
      if (key.length > limits.keyCharacters || !identifier.test(key)) reject('extension-key');
    }
    const snapshot = snapshotExtensions(extras);
    const canonical = canonicalReadonlyJson(snapshot);
    if (Buffer.byteLength(canonical) > limits.bytes) reject('extension-limit');
    // No count aliases: collision-prone normalization cannot hide strings in discarded material.
    if (containsSensitiveText(canonical)) reject('extension-sensitive');
    const projected = Object.create(Object.getPrototypeOf(value)) as Record<string, unknown>;
    for (const [key, child] of fields) if (allowed.has(key)) {
      Object.defineProperty(projected, key, { value: child, enumerable: true, writable: true, configurable: true });
    }
    return { value: projected, reason: null };
  } catch (error) {
    return { value: null, reason: error !== null && (typeof error === 'object' || typeof error === 'function')
      ? failures.get(error) ?? 'extension-value' : 'extension-value' };
  }
};
