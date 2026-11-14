import { useEffect, useState, type SetStateAction } from 'react';

export function readPreference<T>(
  key: string,
  initial: T,
  valid?: (value: unknown) => value is T,
): T {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    if (valid ? valid(parsed) : parsed !== null && typeof parsed === typeof initial)
      return parsed as T;
  } catch {
    /* Storage can be unavailable in private contexts. */
  }
  return initial;
}
export function writePreference(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* In-memory UI still works. */
  }
}
export function usePreference<T>(key: string, initial: T, valid?: (value: unknown) => value is T) {
  const [state, setState] = useState(() => ({ key, value: readPreference(key, initial, valid) }));
  const value = state.key === key ? state.value : readPreference(key, initial, valid);
  useEffect(() => writePreference(key, value), [key, value]);
  const setValue = (next: SetStateAction<T>) =>
    setState((previous) => {
      const current = previous.key === key ? previous.value : readPreference(key, initial, valid);
      return { key, value: typeof next === 'function' ? (next as (value: T) => T)(current) : next };
    });
  return [value, setValue] as const;
}
