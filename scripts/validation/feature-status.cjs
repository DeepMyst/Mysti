#!/usr/bin/env node
// Validate and render the execution ledger; never infer PASS from test counts.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const ledger = JSON.parse(fs.readFileSync(path.join(root, 'plans/48-feature-test-status.json'), 'utf8'));
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'plans/47-feature-coverage.json'), 'utf8'));
const expected = inventory.features.map(feature => feature.id);
const actual = ledger.cases.map(feature => feature.id);
if (JSON.stringify(expected) !== JSON.stringify(actual)) { throw new Error('Execution ledger must match the complete ordered feature inventory.'); }
const counts = Object.fromEntries(Object.keys(ledger.statuses).map(status => [status, 0]));
for (const feature of ledger.cases) {
  if (!(feature.status in counts)) { throw new Error(`Unknown status for ${feature.id}`); }
  counts[feature.status]++;
  if (feature.status === 'PASS' && (!feature.acceptanceAudit?.allRequiredScenariosPassed || !feature.acceptanceAudit?.allRequiredProfilesPassed || feature.remaining.length)) {
    throw new Error(`${feature.id}: PASS requires complete acceptance evidence and no remaining work.`);
  }
}
const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const relative = file => file.startsWith('plans/') ? file.slice('plans/'.length) : file.startsWith('/') ? file : `../${file}`;
const lines = [
  '# Mysti feature testing status', '',
  `Updated: ${ledger.updatedAt}. Display timezone: ${ledger.timezone}.`, '',
  `[Test plan](47-comprehensive-feature-test-plan.md) · [Feature checklist](47-feature-inventory.md) · [Detailed execution ledger](48-feature-test-status.json)`, '',
  `Current case: **${ledger.activeCase || 'None'}**. ${ledger.nextCase ? `Next queued case: **${ledger.nextCase}**. ` : ''}` + Object.entries(counts).map(([status, count]) => `${status}: ${count}`).join(' · '), '',
  'PASS means the complete case, including required real-use and elapsed-time profiles, has acceptance evidence. Unit/browser/native checks can pass while the feature remains PARTIAL or IN_PROGRESS. Failed historical runs remain visible after successful reruns. Earlier campaign results are not silently carried forward.', '',
  '## Executed and active cases', '',
];
for (const feature of ledger.cases.filter(feature => feature.status !== 'NOT_RUN')) {
  lines.push(`### ${feature.id} — ${feature.feature}`, '', `**Status: ${feature.status}.** ${feature.outcome}`, '', `Plan: [detailed case](${relative(feature.plan)}).`, '');
  if (feature.runs.length) {
    lines.push('| Run | Layer | Status | Outcome / scope | Evidence |', '| --- | --- | --- | --- | --- |');
    for (const run of feature.runs) {
      const evidence = (run.evidence || []).map((file, i) => `[${i + 1}](${relative(file)})`).join(', ');
      lines.push(`| ${cell(run.id)} | ${cell(run.layer)} | ${cell(run.status)} | ${cell(run.outcome || run.scope || '')} | ${evidence} |`);
    }
    lines.push('');
  }
  if (feature.issues.length) {
    lines.push('Findings:', '');
    for (const issue of feature.issues) { lines.push(`- **${issue.id} (${issue.status}):** ${issue.summary || issue.description}`); }
    lines.push('');
  }
  if (feature.remaining.length) {
    lines.push('Still required:', '');
    for (const remaining of feature.remaining) { lines.push(`- ${remaining}`); }
    lines.push('');
  }
}
lines.push('## Complete queue', '', '| Case | Feature | Status |', '| --- | --- | --- |');
for (const feature of ledger.cases) { lines.push(`| ${feature.id} | ${cell(feature.feature)} | ${feature.status} |`); }
lines.push('', 'Generated from the execution ledger with `node scripts/validation/feature-status.cjs --write`. Raw logs/traces under `out-test/` are local ignored artifacts; preserve them with the release evidence before cleanup.', '');
if (process.argv.includes('--write')) { fs.writeFileSync(path.join(root, 'plans/48-feature-test-status.md'), lines.join('\n')); }
console.log(`Execution ledger validated: ${ledger.cases.length} cases; ${JSON.stringify(counts)}`);
