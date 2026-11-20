import { uiMessage, useLocale } from './i18n.ts';
export function Badge({ state }: { state: string }) {
  useLocale();
  return (
    <span className={`badge ${state}`}>
      <i />
      {uiMessage(state)}
    </span>
  );
}
