import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));

const runtimeEn = readJson('l10n/bundle.l10n.json');
const manifestEn = readJson('package.nls.json');
const manifest = readJson('package.json');
const locales = ['ru'];
const runtimeLocales = Object.fromEntries(locales.map((locale) => [locale, readJson(`l10n/bundle.l10n.${locale}.json`)]));
const manifestLocales = Object.fromEntries(locales.map((locale) => [locale, readJson(`package.nls.${locale}.json`)]));

const errors = [];
const placeholders = (value) => [...String(value).matchAll(/\{\d+\}/g)].map((m) => m[0]).sort();

function compareCatalogs(name, en, localized, locale) {
  const enKeys = Object.keys(en).sort();
  const localizedKeys = Object.keys(localized).sort();
  const missing = enKeys.filter((key) => !(key in localized));
  const extra = localizedKeys.filter((key) => !(key in en));
  if (missing.length) errors.push(`${name}: missing ${locale.toUpperCase()} keys: ${missing.join(', ')}`);
  if (extra.length) errors.push(`${name}: extra ${locale.toUpperCase()} keys: ${extra.join(', ')}`);

  for (const key of enKeys) {
    if (!(key in localized)) continue;
    const enArgs = placeholders(en[key]);
    const localizedArgs = placeholders(localized[key]);
    if (JSON.stringify(enArgs) !== JSON.stringify(localizedArgs)) {
      errors.push(`${name}: placeholder mismatch for ${JSON.stringify(key)}: EN=${enArgs.join(',')} ${locale.toUpperCase()}=${localizedArgs.join(',')}`);
    }

    // Russian has an additional regression guard for accidental mixed-script suffixes.
    if (locale === 'ru') {
      const translated = String(localized[key]);
      if (/[А-Яа-яЁё][A-Za-z]|[A-Za-z][А-Яа-яЁё]/.test(translated)) {
        errors.push(`${name}: adjacent Cyrillic/Latin characters in ${JSON.stringify(key)} => ${JSON.stringify(translated)}`);
      }
      if (/[А-Яа-яЁё]s\b/.test(translated)) {
        errors.push(`${name}: suspicious English plural suffix in ${JSON.stringify(key)} => ${JSON.stringify(translated)}`);
      }
    }
  }
}

for (const locale of locales) {
  compareCatalogs('runtime', runtimeEn, runtimeLocales[locale], locale);
  compareCatalogs('manifest', manifestEn, manifestLocales[locale], locale);
}


// Any RU value identical to English must be an explicitly approved technical
// identifier/brand/model. This catches newly added untranslated UI strings.
const ruIdentityAllowlist = new Set(readJson('scripts/ru-identity-allowlist.json'));
const currentRuIdentities = Object.keys(runtimeEn).filter((key) => runtimeLocales.ru[key] === runtimeEn[key]);
for (const key of currentRuIdentities) {
  if (!ruIdentityAllowlist.has(key)) errors.push(`RU runtime string unexpectedly falls back to English: ${key}`);
}
for (const key of ruIdentityAllowlist) {
  if (!(key in runtimeEn)) errors.push(`stale RU identity allowlist key: ${key}`);
}

// High-visibility Russian strings must never silently fall back to English.
const criticalRuRuntime = [
  'Please select exactly 2 agents',
  'Setup Wizard',
  "You've been Mysting! {0}",
  'bronze',
  'silver',
  'gold',
  'platinum',
  'System Diagnostics',
  'Authentication Required',
  'Show details',
  'Select an approach',
  'Brainstorm Synthesis',
  'Taking longer than expected...',
  'Copy message as Markdown',
];
for (const key of criticalRuRuntime) {
  if (!(key in runtimeEn)) errors.push(`critical RU guard references missing EN runtime key: ${key}`);
  else if (!(key in runtimeLocales.ru)) errors.push(`critical RU runtime key missing: ${key}`);
  else if (runtimeLocales.ru[key] === runtimeEn[key]) errors.push(`critical RU runtime key is still English: ${key}`);
}

// Every %nls.key% reference in package.json must exist in every manifest catalog.
const manifestText = JSON.stringify(manifest);
const nlsRefs = [...manifestText.matchAll(/%([^%]+)%/g)].map((m) => m[1]);
for (const key of new Set(nlsRefs)) {
  if (!(key in manifestEn)) errors.push(`package.json references missing EN NLS key: ${key}`);
  for (const locale of locales) {
    if (!(key in manifestLocales[locale])) errors.push(`package.json references missing ${locale.toUpperCase()} NLS key: ${key}`);
  }
}

// Regression guard for the bug that produced Russian text ending in a stray Latin "s".
// Keep whitespace without regex escapes inside the injected template literal.
const localizationTs = fs.readFileSync(path.join(root, 'src/localization.ts'), 'utf8');
if (!localizationTs.includes('raw.trimStart()') || !localizationTs.includes('raw.trimEnd()')) {
  errors.push('src/localization.ts must preserve surrounding whitespace with trimStart()/trimEnd().');
}
if (localizationTs.includes("raw.match(/^\\s*/)") || localizationTs.includes("raw.match(/\\s*$/)")) {
  errors.push('src/localization.ts contains the old template-literal \\s regression pattern.');
}

// Russian translations belong in JSON resources, never in main TypeScript sources.
const srcRoot = path.join(root, 'src');
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.isFile() && entry.name.endsWith('.ts') ? [full] : [];
  });
}
for (const file of walk(srcRoot)) {
  const text = fs.readFileSync(file, 'utf8');
  if (/[А-Яа-яЁё]/.test(text)) {
    errors.push(`hardcoded Cyrillic found in TypeScript source: ${path.relative(root, file)}`);
  }
}

if (errors.length) {
  console.error(`Localization verification failed with ${errors.length} issue(s):`);
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Localization verification passed.');
console.log(`Runtime catalog: ${Object.keys(runtimeEn).length} EN keys.`);
console.log(`Manifest catalog: ${Object.keys(manifestEn).length} EN keys.`);
for (const locale of locales) {
  const runtimeTranslated = Object.keys(runtimeEn).filter((key) => runtimeLocales[locale][key] !== runtimeEn[key]).length;
  const manifestTranslated = Object.keys(manifestEn).filter((key) => manifestLocales[locale][key] !== manifestEn[key]).length;
  console.log(`${locale.toUpperCase()}: ${Object.keys(runtimeLocales[locale]).length} runtime keys (${runtimeTranslated} non-English), ${Object.keys(manifestLocales[locale]).length} manifest keys (${manifestTranslated} non-English).`);
}
console.log(`Manifest NLS references: ${new Set(nlsRefs).size}.`);
