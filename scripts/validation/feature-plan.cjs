#!/usr/bin/env node
/* Read-only traceability audit. This validates the test PLAN, not product behavior. */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const manifest = JSON.parse(read('plans/47-feature-coverage.json'));
const pkg = JSON.parse(read('package.json'));
const unique = values => [...new Set(values)].sort();
const captures = (text, pattern) => [...text.matchAll(pattern)].map(match => match[1]);
const errors = [];
function equalSets(label, expected, actual) {
  const missing = expected.filter(key => !actual.includes(key));
  const extra = actual.filter(key => !expected.includes(key));
  if (missing.length || extra.length) {
    errors.push(`${label}: missing=[${missing.join(', ')}], obsolete=[${extra.join(', ')}]`);
  }
}

const chat = read('src/providers/ChatViewProvider.ts');
const handler = chat.slice(chat.indexOf('private async _handleMessage(message:'), chat.indexOf('private async _initTeamWorkspace('));
const providerSource = read('src/providers/base/ProviderManifest.ts');
const providers = providerSource.split('export const PROVIDER_DISPLAY_META:')[1].split('\n};')[0];
const slashSource = read('src/managers/SlashCommandManager.ts');
const aliases = slashSource.split('private static readonly _legacyCommandMap')[1]?.split('\n  };')[0];
if (!handler || !providers || !aliases) { throw new Error('Inventory source boundary changed; review the extractor.'); }
const assets = ['personas', 'skills', 'roles'].flatMap(kind =>
  fs.readdirSync(path.join(root, 'resources/agents/core', kind))
    .filter(file => file.endsWith('.md')).map(file => `${kind}/${file}`));
const sourceInventory = {
  commands: pkg.contributes.commands.map(command => command.command),
  settings: Object.keys(pkg.contributes.configuration.properties),
  chatActions: unique(captures(handler, /^      case '([^']+)':/gm)),
  providers: unique(captures(providers, /^  '([^']+)':/gm)),
  canvasOperations: unique(captures(read('src/canvas/CanvasOps.ts'), /\| \{ op: '([^']+)'/g)),
  sessionShapes: unique(captures(read('src/managers/sessionShapes.ts'), /^    id: '([^']+)'/gm)),
  slashAliases: unique(captures(aliases, /^    '([^']+)':/gm)),
  coreAssets: assets,
};

const featureIds = manifest.features.map(feature => feature.id);
if (unique(featureIds).length !== featureIds.length) { errors.push('Duplicate feature IDs.'); }
for (const [category, inventory] of Object.entries(sourceInventory)) {
  const mapping = manifest.coverage[category] || {};
  equalSets(category, unique(inventory), Object.keys(mapping).sort());
  for (const [entry, ids] of Object.entries(mapping)) {
    if (!Array.isArray(ids) || !ids.length || ids.some(id => !featureIds.includes(id))) {
      errors.push(`${category}.${entry}: missing or unknown case ID`);
    }
  }
}

const catalogIds = [];
const catalogFeatures = new Map();
for (const file of manifest.catalogs) {
  const text = read(file);
  for (const match of text.matchAll(/^## ((?:PC|AR|EW|CI)-\d+) — (.+)$/gm)) {
    catalogIds.push(match[1]);
    catalogFeatures.set(match[1], { catalog: file, title: match[2].replaceAll('`', '') });
  }
  for (const match of text.matchAll(/\*\*(PB-\d+) — ([^*]+)\*\*/g)) {
    catalogIds.push(match[1]);
    catalogFeatures.set(match[1], { catalog: file, title: match[2] });
  }
}
equalSets('feature catalog', unique(catalogIds), unique(featureIds));
if (unique(catalogIds).length !== catalogIds.length) { errors.push('Duplicate catalog case headings.'); }
for (const feature of manifest.features) {
  const source = catalogFeatures.get(feature.id);
  if (source?.catalog !== feature.catalog || source?.title !== feature.title || feature.executionStatus !== 'NOT_RUN') {
    errors.push(`${feature.id}: invalid catalog or execution status; this artifact describes a plan.`);
  }
}

// Check repository-local links in the plan and catalogs. Directories count as
// suite references; existence does not imply those tests execute the new case.
const docs = ['plans/47-comprehensive-feature-test-plan.md', 'plans/47-feature-inventory.md', ...manifest.catalogs];
for (const file of docs) {
  for (const target of captures(read(file), /\]\(([^)]+)\)/g)) {
    if (/^(https?:|mailto:|#)/.test(target)) { continue; }
    const destination = target.split('#')[0];
    if (!fs.existsSync(path.resolve(root, path.dirname(file), destination))) {
      errors.push(`${file}: broken local link ${target}`);
    }
  }
}

if (errors.length) {
  for (const error of errors) { console.error(error); }
  process.exitCode = 1;
} else {
  console.log(`Plan traceability passed: ${featureIds.length} cases; ` +
    Object.entries(sourceInventory).map(([name, values]) => `${values.length} ${name}`).join(', ') + '.');
  console.log('Local links and mapped case IDs verified. No product, live-account or soak tests were run.');
}
