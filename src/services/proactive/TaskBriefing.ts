import type { CloudState, CloudInsight } from './ProactiveClient';

export interface TaskBriefing {
  requestId?: number;
  responsibilityId: string;
  title: string;
  checkedAt: string;
  notices: string[];
  insights: CloudInsight[];
}

/** Uses only already-authorized inbox evidence. The summary is never uploaded or persisted. */
export function taskBriefing(cloud: CloudState, responsibilityId: string, summary = '', now = new Date()): TaskBriefing {
  const row = cloud.responsibilities.find(r => r.id === responsibilityId);
  if (!row) { throw new Error('Choose a current responsibility and try again.'); }
  if (summary.length > 2000) { throw new Error('Keep your task summary under 2,000 characters.'); }
  const notices = ['Related terms suggest relevance; they do not establish task ownership or duplicate work.', row.health];
  if (!cloud.available) { notices.push('Cloud monitoring is unavailable. This is retained evidence only.'); }
  if (row.state !== 'active') { notices.push('This watch is paused. New changes are not being checked.'); }
  const checked = Date.parse(row.last_checked_at ?? '');
  if (!Number.isFinite(checked) || now.getTime() - checked > 15 * 60_000) {
    notices.push('Source evidence may be stale: no successful check within 15 minutes.');
  }
  const terms = Array.from(new Set(summary.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{3,80}/gu) ?? []));
  const candidates = cloud.insights.filter(i => i.responsibility_id === row.id);
  const score = (i: CloudInsight) => {
    const text = `${i.title} ${i.evidence.excerpt}`.toLocaleLowerCase();
    return terms.reduce((n, term) => n + (text.includes(term) ? 1 : 0), 0);
  };
  const ranked = [...candidates].sort((a, b) => score(b) - score(a) || Date.parse(b.created_at) - Date.parse(a.created_at));
  if (terms.length) { notices.push('Your summary orders the existing evidence locally; it does not search the source or send your summary to DeepMyst.'); }
  if (!ranked.length) { notices.push('No accessible inbox evidence for this responsibility. This does not establish that nobody else is working on your task.'); }
  if (ranked.length > 20) { notices.push('Showing the 20 most relevant items from the latest inbox window.'); }
  notices.push('Inbox coverage is bounded. Check the source before making a decision; source edits or deletions may not yet be reflected.');
  return { responsibilityId: row.id, title: row.title, checkedAt: now.toISOString(), notices, insights: ranked.slice(0, 20) };
}
