import { useSyncExternalStore } from 'react';
import { readPreference, writePreference } from './preferences.ts';
import en from './locales/en.json';
import zh from './locales/zh.json';

export type Locale = 'en' | 'zh';
export type MessageKey = keyof typeof en;
export const localeStorageKey = 'aw.locale';
export function browserLocale(languages: readonly string[]): Locale {
  return /^zh(?:-|$)/i.test(languages[0] ?? '') ? 'zh' : 'en';
}
const validLocale = (value: unknown): value is Locale => value === 'en' || value === 'zh';
let locale = readPreference(
  localeStorageKey,
  browserLocale(
    typeof navigator === 'undefined'
      ? []
      : navigator.languages.length
        ? navigator.languages
        : [navigator.language],
  ),
  validLocale,
);
const listeners = new Set<() => void>();
export function getLocale(): Locale {
  return locale;
}
export function setLocale(next: Locale) {
  if (!validLocale(next)) return;
  locale = next;
  writePreference(localeStorageKey, next);
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next === 'zh' ? 'zh-CN' : 'en';
    document.title = translate(next, 'AI Agent Workspace');
  }
  listeners.forEach((listener) => listener());
}
export function useLocale() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getLocale,
    () => 'en' as Locale,
  );
}
export function translate(
  language: Locale,
  key: MessageKey,
  values: Record<string, string | number> = {},
): string {
  const message = (language === 'zh' ? zh : en)[key];
  return message.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(values, name) ? String(values[name]) : match,
  );
}
export function t(key: MessageKey, values?: Record<string, string | number>): string {
  return translate(locale, key, values);
}
if (typeof document !== 'undefined') {
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  document.title = translate(locale, 'AI Agent Workspace');
}

/** Only use for application-owned status/reason fields, never user text or raw output. */
export function uiMessage(message: string): string {
  if (Object.hasOwn(en, message)) return t(message as MessageKey);
  // Toasts and form errors may have been captured before the language changed.
  const key = (Object.keys(zh) as MessageKey[]).find((key) => zh[key] === message);
  if (key) return t(key);
  for (const { pattern, key, names } of messagePatterns) {
    const match = pattern.exec(message);
    if (match) {
      const values = Object.fromEntries(
        names.map((name, index) => [
          name,
          name === 'state' ? uiMessage(match[index + 1]) : match[index + 1],
        ]),
      );
      return t(key, values);
    }
  }
  return message;
}
/** Unknown server/provider diagnostics remain available after a localized error label. */
export function errorText(message: string): string {
  const translated = uiMessage(message);
  return translated !== message || Object.hasOwn(en, message) || Object.values(zh).includes(message)
    ? translated
    : `${t('Request failed')}: ${message}`;
}

// The API currently sends these application messages as English prose. Translate
// only these known templates at the display boundary; keep captured values intact.
const patternKeys: MessageKey[] = [
  'Last run {state}. Review before choosing to continue.',
  'Waiting for: {dependencies}',
  'Dependency {dependency} has a newer or incomplete execution.',
  'Dependency {dependency} has {state} input evidence.',
  'Session-wide history, not attributed to individual resumed runs. {count} malformed/oversized records skipped. Tool calls are requests, not proof of success.',
  'Native history unavailable: {error}. Stored run evidence remains available.',
  'Step {step} vs {base}',
];
const messagePatterns = patternKeys.map((key) => {
  const names: string[] = [];
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const source = escaped.replace(/\\\{(\w+)\\\}/g, (_, name: string) => {
    names.push(name);
    return '([\\s\\S]*?)';
  });
  return { key, names, pattern: new RegExp('^' + source + '$') };
});
