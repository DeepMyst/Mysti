(() => {
  'use strict';
  const api = acquireVsCodeApi();
  const $ = id => document.getElementById(id);
  const send = (type, args = {}) => { $('error').hidden = true; api.postMessage({ type, ...args }); };
  const node = (tag, text, className) => { const el = document.createElement(tag); if (text) {el.textContent = text;} if (className) {el.className = className;} return el; };
  const button = (text, action, disabled = false) => { const el = node('button', text); el.type = 'button'; el.disabled = disabled; el.addEventListener('click', action); return el; };
  const when = value => value ? new Date(value).toLocaleString() : 'Not checked yet';
  $('refresh').onclick = () => send('refresh');
  $('add-local').onclick = () => send('addLocal');
  $('sign-in').onclick = () => send('signIn');
  $('connections').onclick = () => send('connections');
  $('notifications').onchange = event => send('notifications', { enabled: event.target.checked });
  $('cloud-form').onsubmit = event => { event.preventDefault(); send('addCloud', { title: $('title').value, connectionId: $('connection').value, resource: $('resource').value, keywords: $('keywords').value }); };
  let taskRequest = 0;
  let wasSignedIn = false;
  $('task-form').onsubmit = event => { event.preventDefault(); send('taskBriefing', { requestId: ++taskRequest, id: $('task-responsibility').value, summary: $('task-summary').value }); };
  const clearBriefing = () => { taskRequest++; $('task-briefing').replaceChildren(); send('clearBriefing'); };
  $('task-summary').oninput = clearBriefing;
  $('task-responsibility').onchange = clearBriefing;
  function render(state) {
    $('refresh').disabled = state.busy || state.pending;
    $('add-local').disabled = !!state.pending;
    $('cloud-form').querySelector('button[type=submit]').disabled = !!state.pending;
    $('refresh').textContent = state.pending ? 'Applying…' : state.busy ? 'Checking…' : 'Refresh inbox';
    $('notifications').checked = state.local.notifications;
    const watches = $('local-watches'); watches.replaceChildren();
    state.local.watches.forEach(w => {
      const card = node('article', '', 'card');
      card.append(node('h3', w.name), node('p', `${w.active ? 'Watching' : 'Paused'} · ${w.health}`), node('p', `${w.root} · ${when(w.snapshot?.observedAt)}`, 'meta'));
      const actions = node('div', '', 'actions');
      actions.append(button(w.active ? 'Pause' : 'Resume', () => send('localState', { id: w.root, active: !w.active })), button('Remove watch and insights', () => send('removeLocal', { id: w.root })));
      card.append(actions); watches.append(card);
    });
    if (!state.local.watches.length) {watches.append(node('p', 'No local repositories watched.'));}
    $('sign-in').hidden = state.signedIn;
    const cloud = state.cloud;
    if (wasSignedIn && !state.signedIn) { $('task-summary').value = ''; }
    wasSignedIn = state.signedIn;
    const taskSelection = $('task-responsibility').value;
    const responsibilities = cloud?.responsibilities || [];
    $('task-responsibility').replaceChildren(...responsibilities.map(r => { const option = node('option', `${r.title} · ${r.source} / ${r.resource}`); option.value = r.id; return option; }));
    if (responsibilities.some(r => r.id === taskSelection)) { $('task-responsibility').value = taskSelection; }
    $('task-check').disabled = !state.signedIn || !responsibilities.length || !!state.pending || !!state.busy;
    $('task-status').textContent = !responsibilities.length ? 'Enable a connected responsibility to check its context.' : 'Checks use the latest accessible inbox window. Ordinary chat remains available if monitoring is unavailable.';
    const briefing = $('task-briefing'); briefing.replaceChildren();
    if (state.briefing?.requestId === taskRequest && state.briefing && state.briefing.responsibilityId === $('task-responsibility').value) {
      briefing.append(node('h3', state.briefing.title), node('p', `Inbox checked: ${when(state.briefing.checkedAt)}`, 'meta'));
      state.briefing.notices.forEach(notice => briefing.append(node('p', notice)));
      state.briefing.insights.forEach(i => {
        const card = node('article', '', 'card');
        card.append(node('h3', i.title), node('blockquote', i.evidence.excerpt), node('p', `Observed: ${when(i.created_at)} · Source version: ${i.evidence.version || 'unknown'}`, 'meta'), button('Review source', () => send('evidence', { id: i.id })));
        if (i.evidence.author) { card.append(node('p', `Source author: ${i.evidence.author} · ${i.evidence.status || ''}`, 'meta')); }
        briefing.append(card);
      });
    }
    $('cloud-status').textContent = state.cloudError || (!state.signedIn ? 'Sign in to connect a cloud responsibility.' : !cloud ? 'Checking DeepMyst availability…' : !cloud.available ? 'Cloud monitoring is not configured on this server.' : 'DeepMyst monitoring is available. Checks run approximately every 5 minutes; see each watch’s last successful check.');
    const supported = cloud?.connections.filter(c => c.supported) || [];
    $('cloud-form').hidden = !cloud?.available || cloud.read_only || !supported.length;
    const selected = $('connection').value;
    const options = supported.map(c => { const el = node('option', `${c.name} · ${c.source}`); el.value = c.id; return el; });
    $('connection').replaceChildren(...options);
    if (supported.some(c => c.id === selected)) {$('connection').value = selected;}
    const remote = $('cloud-watches'); remote.replaceChildren();
    if (cloud?.available && !supported.length) {remote.append(node('p', 'Connect a GitHub or Slack account to add a watch. Other connections do not yet support monitoring.'));}
    if (cloud?.read_only) {remote.append(node('p', 'Your account has read-only access.'));}
    (cloud?.responsibilities || []).forEach(r => {
      const card = node('article', '', 'card');
      const stale = r.state === 'active' && Date.now() - Date.parse(r.last_checked_at || r.next_check_at) > 15 * 60_000;
      if (stale) { card.append(node('p', 'Stale: no successful check within 15 minutes. Source access or the DeepMyst worker may need attention.')); }
      card.append(node('h3', r.title), node('p', `${r.state} · ${r.source} / ${r.resource}`), node('p', r.health), node('p', `Last successful check: ${when(r.last_checked_at)}`, 'meta'));
      const actions = node('div', '', 'actions');
      actions.append(button(r.state === 'active' ? 'Pause' : 'Resume', () => send('cloudState', { id: r.id, state: r.state === 'active' ? 'paused' : 'active' }), cloud.read_only), button('Remove watch and insights', () => send('removeCloud', { id: r.id }), cloud.read_only));
      card.append(actions); remote.append(card);
    });
    const inbox = $('inbox'); inbox.replaceChildren();
    const insights = state.local.watches.flatMap(w => w.insights.filter(i => i.state !== 'dismissed').map(i => ({ ...i, root: w.root, origin: w.name })))
      .concat((cloud?.insights || []).map(i => ({ ...i, createdAt: i.created_at, origin: `${i.evidence.source} · ${i.evidence.resource}` })))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    insights.forEach(i => {
      const card = node('article', '', `card ${i.state}`);
      card.append(node('h3', i.title), node('p', `${i.origin} · ${when(i.createdAt)} · ${i.state}`, 'meta'), node('p', i.summary));
      if (i.evidence) {card.append(node('blockquote', i.evidence.excerpt));}
      const mark = status => send(i.root ? 'markLocal' : 'markCloud', { id: i.id, root: i.root, state: status });
      const actions = node('div', '', 'actions');
      if (i.evidence) {actions.append(button('Open source', () => send('evidence', { id: i.id })));}
      if (i.state === 'unread') {actions.append(button('Mark read', () => mark('read'), !i.root && cloud.read_only));}
      actions.append(button('Dismiss', () => mark('dismissed'), !i.root && cloud.read_only));
      card.append(actions); inbox.append(card);
    });
    if (!insights.length) {inbox.append(node('p', 'No insights yet. Enabled watches will add relevant changes here.'));}
  }
  window.addEventListener('message', event => {
    if (event.data.type === 'state') {render(event.data);}
    if (event.data.type === 'error') { $('error').textContent = event.data.message; $('error').hidden = false; }
  });
  send('ready');
})();
