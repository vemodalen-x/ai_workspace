import { t, useLocale, setLocale } from './i18n.ts';

export function LanguageSelector() {
  const locale = useLocale();
  return (
    <label className="language-switch">
      <span>{t('Language')}</span>
      <select
        aria-label="Language / 语言"
        value={locale}
        onChange={(event) => setLocale(event.target.value === 'zh' ? 'zh' : 'en')}
      >
        <option value="en" lang="en">
          English
        </option>
        <option value="zh" lang="zh-CN">
          中文
        </option>
      </select>
    </label>
  );
}
