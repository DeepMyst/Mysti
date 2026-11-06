#!/usr/bin/env node
/** Offline documentation integrity checks. SPDX-License-Identifier: Apache-2.0 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { generate, anchor } = require('./docs-reference.cjs');
const root = path.resolve(__dirname, '..');
const rawBase = 'https://raw.githubusercontent.com/DeepMyst/Mysti/main/';
const webBase = 'https://github.com/DeepMyst/Mysti/blob/main/';
const readJson = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));

function plain(text) {
  return text.replace(/<[^>]*>/g, '').replace(/!?\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*`~]/g, '').replaceAll('&amp;', '&').replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>');
}

function headingIds(tokens, marked) {
  const ids = new Set();
  const counts = new Map();
  marked.walkTokens(tokens, token => {
    if (token.type === 'heading') {
      const base = anchor(plain(token.text));
      let id = base;
      let index = counts.get(base) || 0;
      while (ids.has(id)) { id = `${base}-${++index}`; }
      counts.set(base, index); ids.add(id);
    } else if (token.type === 'html') {
      for (const match of token.text.matchAll(/\b(?:id|name)=["']([^"']+)["']/g)) { ids.add(match[1]); }
    }
  });
  return ids;
}

function settingTableErrors(tokens, marked, properties) {
  const errors = [];
  marked.walkTokens(tokens, token => {
    if (token.type !== 'table') { return; }
    const headers = token.header.map(item => plain(item.text).trim().toLowerCase());
    const settingColumn = headers.findIndex(value => value === 'setting' || value === 'setting key');
    if (settingColumn === -1) { return; }
    const defaultColumn = headers.findIndex(value => value === 'default' || value === 'declared default');
    for (const row of token.rows) {
      const id = plain(row[settingColumn].text).trim();
      if (!/^mysti\.[\w.-]+$/.test(id)) { continue; }
      const spec = properties[id];
      if (!spec) { errors.push(`Undeclared setting ${id}`); continue; }
      if (defaultColumn === -1 || !Object.hasOwn(spec, 'default')) { continue; }
      const literal = /^`([^`]*)`$/.exec(row[defaultColumn].text.trim());
      if (!literal) { continue; } // Explanatory prose is not a declared literal.
      const value = literal[1].replaceAll('&#124;', '|');
      let actual;
      try { actual = JSON.parse(value); } catch { actual = value; }
      if (JSON.stringify(actual) !== JSON.stringify(spec.default)) {
        errors.push(`${id}: documented default ${JSON.stringify(actual)} differs from manifest ${JSON.stringify(spec.default)}`);
      }
    }
  });
  return errors;
}

async function checkDocs() {
  generate(false);
  const { marked } = await import('marked');
  const pkg = readJson('package.json');
  const catalog = readJson('docs/navigation.json');
  const configs = Array.isArray(pkg.contributes.configuration) ? pkg.contributes.configuration : [pkg.contributes.configuration];
  const properties = Object.assign({}, ...configs.map(item => item.properties));
  const errors = [];
  if (catalog.schemaVersion !== 1 || catalog.productVersion !== pkg.version) {
    errors.push('Navigation schema or product version does not match the current manifest.');
  }
  const ids = new Set(); const paths = new Set();
  for (const doc of catalog.documents) {
    if (!doc.id || ids.has(doc.id)) { errors.push(`Duplicate or missing catalog id: ${doc.id}`); }
    if (!doc.path || paths.has(doc.path)) { errors.push(`Duplicate or missing catalog path: ${doc.path}`); }
    ids.add(doc.id); paths.add(doc.path);
    if (!doc.title || !doc.summary || !doc.audiences?.length || !doc.topics?.length || !['current', 'release-specific', 'historical'].includes(doc.status)) {
      errors.push(`Incomplete discovery metadata for ${doc.id}`);
    }
    if (!doc.path || path.isAbsolute(doc.path) || doc.path.split('/').includes('..') || !fs.existsSync(path.join(root, doc.path))) {
      errors.push(`Invalid or missing catalog document: ${doc.path}`);
    }
  }
  for (const directory of ['docs', 'docs/walkthroughs']) {
    for (const filename of fs.readdirSync(path.join(root, directory))) {
      if (!filename.endsWith('.md') || filename === 'README.md') { continue; }
      const file = `${directory}/${filename}`;
      if (!paths.has(file)) { errors.push(`Document is missing from navigation.json: ${file}`); }
    }
  }
  const docs = [...new Set(['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs/README.md', 'llms.txt', ...paths])];
  const cache = new Map();
  function load(file) {
    if (!cache.has(file)) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      const tokens = marked.lexer(text);
      cache.set(file, { text, tokens, ids: headingIds(tokens, marked) });
    }
    return cache.get(file);
  }
  let links = 0; let fragments = 0;
  function checkLink(file, target) {
    const original = target;
    target = target.replaceAll('&amp;', '&');
    if (target.startsWith(rawBase)) { target = '/' + target.slice(rawBase.length); }
    else if (target.startsWith(webBase)) { target = '/' + target.slice(webBase.length); }
    else if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) { return; }
    const hash = target.indexOf('#');
    let fragment = hash === -1 ? '' : target.slice(hash + 1);
    let destination = (hash === -1 ? target : target.slice(0, hash)).split('?')[0];
    try { destination = decodeURIComponent(destination); fragment = decodeURIComponent(fragment); }
    catch { errors.push(`${file}: invalid URL encoding ${original}`); return; }
    const resolved = destination ? path.resolve(destination.startsWith('/') ? root : path.dirname(path.join(root, file)), '.' + (destination.startsWith('/') ? destination : '/' + destination)) : path.join(root, file);
    const local = path.relative(root, resolved).split(path.sep).join('/');
    if (local === '..' || local.startsWith('../') || !fs.existsSync(resolved)) { errors.push(`${file}: missing local target ${original}`); return; }
    links++;
    if (fragment && /\.(?:md|txt)$/i.test(local)) {
      fragments++;
      if (!load(local).ids.has(fragment)) { errors.push(`${file}: missing heading #${fragment} in ${local}`); }
    }
  }
  for (const file of docs) {
    if (!fs.existsSync(path.join(root, file))) { continue; }
    const { tokens } = load(file);
    marked.walkTokens(tokens, token => {
      if (token.type === 'link' || token.type === 'image') { checkLink(file, token.href); }
      else if (token.type === 'html') {
        for (const match of token.text.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) { checkLink(file, match[1]); }
      }
    });
    // Historical documents and changelog entries retain their recorded declarations.
    if (file !== 'CHANGELOG.md' && !catalog.documents.some(doc => doc.path === file && doc.status !== 'current')) {
      errors.push(...settingTableErrors(tokens, marked, properties).map(error => `${file}: ${error}`));
    }
  }
  if (errors.length) { throw new Error(errors.join('\n')); }
  console.log(`Documentation verified: ${docs.length} entry/reference pages, ${catalog.documents.length} catalog entries, ${links} local links and ${fragments} heading targets; generated references are current.`);
  console.log('Offline structural checks only; external services, visual quality and native behavior require separate review.');
}

if (require.main === module) {
  checkDocs().catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { plain, headingIds, settingTableErrors, checkDocs };
