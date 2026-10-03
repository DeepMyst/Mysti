/*
 * Mysti canvas sandbox — UI.* design-system primitives (Plan 05 M1).
 *
 * Runs inside the page iframe (sandbox="allow-scripts", no same-origin). Loaded
 * as a plain script BEFORE the harness, so it uses React.createElement directly
 * (no JSX). Components are self-styled via the theme CSS custom properties
 * (--theme-*) injected on :root, so screens stay on-brand without Tailwind.
 *
 * Oriented to APP & WEBSITE UI (not slides): app shell, nav bars, cards, forms,
 * lists, stats, empty states, hero/sections, charts.
 *
 * SPDX-License-Identifier: Apache-2.0
 */
(function () {
  var React = window.React;
  var h = React.createElement;
  var v = function (name, fallback) { return 'var(--theme-' + name + (fallback ? ', ' + fallback : '') + ')'; };

  function cx(base, style) { return Object.assign({}, base, style || {}); }

  // ── layout ───────────────────────────────────────────────────────────
  function Screen(p) {
    return h('div', { 'data-ui': 'Screen', style: cx({
      width: '100%', minHeight: '100%', display: 'flex', flexDirection: 'column',
      background: p.background || v('color-background'),
    }, p.style) }, p.children);
  }

  function Stack(p) {
    return h('div', { 'data-ui': 'Stack', style: cx({
      display: 'flex', flexDirection: 'column', gap: (p.gap != null ? p.gap : 12) + 'px',
      padding: p.padding != null ? p.padding : undefined, alignItems: p.align,
    }, p.style) }, p.children);
  }

  function Row(p) {
    return h('div', { 'data-ui': 'Row', style: cx({
      display: 'flex', flexDirection: 'row', gap: (p.gap != null ? p.gap : 12) + 'px',
      alignItems: p.align || 'center', justifyContent: p.justify,
    }, p.style) }, p.children);
  }

  // App shell for DESKTOP apps: sidebar + topbar + content.
  function AppShell(p) {
    return h('div', { 'data-ui': 'AppShell', style: cx({
      display: 'grid', gridTemplateColumns: (p.sidebar ? (p.sidebarWidth || 248) + 'px ' : '') + '1fr',
      gridTemplateRows: (p.topBar ? '56px ' : '') + '1fr', width: '100%', minHeight: '100%',
      gridTemplateAreas: p.sidebar
        ? (p.topBar ? '"side top" "side main"' : '"side main"')
        : (p.topBar ? '"top" "main"' : '"main"'),
      background: v('color-background'),
    }, p.style) }, [
      p.sidebar && h('div', { key: 's', style: { gridArea: 'side' } }, p.sidebar),
      p.topBar && h('div', { key: 't', style: { gridArea: 'top' } }, p.topBar),
      h('div', { key: 'm', style: { gridArea: 'main', overflow: 'auto', padding: p.padding != null ? p.padding : 24 } }, p.children),
    ]);
  }

  function Sidebar(p) {
    return h('aside', { 'data-ui': 'Sidebar', style: cx({
      height: '100%', background: v('color-surface'), borderRight: '1px solid ' + v('color-border'),
      padding: '16px 12px', display: 'flex', flexDirection: 'column', gap: '4px',
    }, p.style) }, [
      p.brand && h('div', { key: 'b', style: { fontWeight: v('weight-bold'), fontSize: 16, padding: '8px 10px 16px' } }, p.brand),
      p.children,
    ]);
  }

  function SidebarItem(p) {
    return h('a', { 'data-ui': 'SidebarItem', style: cx({
      display: 'flex', alignItems: 'center', gap: '10px', padding: '9px 10px', borderRadius: v('radius-md'),
      color: p.active ? v('color-primary') : v('color-text'), background: p.active ? v('color-surface') : 'transparent',
      fontWeight: p.active ? v('weight-medium') : v('weight-regular'), fontSize: 14, cursor: 'pointer', textDecoration: 'none',
    }, p.style) }, [p.icon, p.label || p.children]);
  }

  function TopBar(p) {
    return h('header', { 'data-ui': 'TopBar', style: cx({
      height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 20px', background: v('color-surface'), borderBottom: '1px solid ' + v('color-border'),
    }, p.style) }, [
      h('div', { key: 'l', style: { fontWeight: v('weight-medium') } }, p.title),
      h('div', { key: 'r', style: { display: 'flex', gap: 10, alignItems: 'center' } }, p.actions),
    ]);
  }

  // MOBILE chrome.
  function StatusBar(p) {
    return h('div', { 'data-ui': 'StatusBar', style: cx({
      height: 44, display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 18px', fontSize: 13, fontWeight: v('weight-medium'), color: v('color-text'),
    }, p.style) }, [h('span', { key: 't' }, p.time || '9:41'), h('span', { key: 'r' }, p.right || '●●● ◢ ▭')]);
  }

  function TabBar(p) {
    return h('nav', { 'data-ui': 'TabBar', style: cx({
      display: 'flex', justifyContent: 'space-around', alignItems: 'center', height: 64,
      borderTop: '1px solid ' + v('color-border'), background: v('color-surface'),
      position: 'sticky', bottom: 0,
    }, p.style) }, (p.items || []).map(function (it, i) {
      return h('div', { key: i, style: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, fontSize: 11, color: it.active ? v('color-primary') : v('color-text-secondary') } }, [it.icon, it.label]);
    }));
  }

  // ── surfaces ─────────────────────────────────────────────────────────
  function Card(p) {
    return h('div', { 'data-ui': 'Card', style: cx({
      background: v('color-surface'), border: '1px solid ' + v('color-border'),
      borderRadius: v('radius-lg'), boxShadow: v('shadow-sm'), padding: p.padding != null ? p.padding : 16,
    }, p.style) }, p.children);
  }

  function Section(p) {
    return h('section', { 'data-ui': 'Section', style: cx({ padding: p.padding != null ? p.padding : '64px 48px' }, p.style) }, [
      p.title && h('h2', { key: 't', style: { fontFamily: v('font-heading'), fontWeight: v('weight-bold'), fontSize: 32, margin: '0 0 8px' } }, p.title),
      p.subtitle && h('p', { key: 's', style: { color: v('color-text-secondary'), margin: '0 0 24px' } }, p.subtitle),
      p.children,
    ]);
  }

  function Hero(p) {
    return h('section', { 'data-ui': 'Hero', style: cx({
      padding: '96px 48px', textAlign: p.align || 'center', display: 'flex', flexDirection: 'column',
      alignItems: p.align === 'left' ? 'flex-start' : 'center', gap: 20,
      background: p.background || v('color-surface'),
    }, p.style) }, [
      p.eyebrow && h('div', { key: 'e', style: { color: v('color-primary'), fontWeight: v('weight-medium'), letterSpacing: 1, textTransform: 'uppercase', fontSize: 13 } }, p.eyebrow),
      h('h1', { key: 'h', style: { fontFamily: v('font-heading'), fontWeight: v('weight-bold'), fontSize: 56, lineHeight: 1.05, margin: 0, maxWidth: 820 } }, p.title),
      p.subtitle && h('p', { key: 's', style: { color: v('color-text-secondary'), fontSize: 20, maxWidth: 640, margin: 0 } }, p.subtitle),
      p.children,
    ]);
  }

  // ── controls ─────────────────────────────────────────────────────────
  function Button(p) {
    var variant = p.variant || 'primary';
    var styles = {
      primary: { background: v('color-primary'), color: '#fff', border: 'none' },
      secondary: { background: 'transparent', color: v('color-primary'), border: '1px solid ' + v('color-primary') },
      ghost: { background: 'transparent', color: v('color-text'), border: '1px solid ' + v('color-border') },
    }[variant];
    return h('button', { 'data-ui': 'Button', style: cx(Object.assign({
      padding: p.size === 'lg' ? '14px 24px' : '9px 16px', borderRadius: v('radius-md'),
      fontWeight: v('weight-medium'), fontSize: p.size === 'lg' ? 16 : 14, cursor: 'pointer',
      display: 'inline-flex', alignItems: 'center', gap: 8,
    }, styles), p.style) }, [p.icon, p.label || p.children]);
  }

  function Field(p) {
    return h('label', { 'data-ui': 'Field', style: cx({ display: 'flex', flexDirection: 'column', gap: 6 }, p.style) }, [
      p.label && h('span', { key: 'l', style: { fontSize: 13, fontWeight: v('weight-medium'), color: v('color-text-secondary') } }, p.label),
      h('input', { key: 'i', placeholder: p.placeholder, defaultValue: p.value, style: {
        padding: '10px 12px', borderRadius: v('radius-md'), border: '1px solid ' + v('color-border'),
        background: v('color-background'), color: v('color-text'), fontSize: 14, width: '100%',
      } }),
    ]);
  }

  function Badge(p) {
    var tone = p.tone || 'neutral';
    var color = { neutral: v('color-text-secondary'), success: v('color-success'), error: v('color-error'), primary: v('color-primary') }[tone];
    return h('span', { 'data-ui': 'Badge', style: cx({
      display: 'inline-block', padding: '2px 9px', borderRadius: v('radius-full'), fontSize: 12,
      fontWeight: v('weight-medium'), color: color, background: v('color-surface'), border: '1px solid ' + v('color-border'),
    }, p.style) }, p.children || p.label);
  }

  function Avatar(p) {
    var size = p.size || 36;
    return h('div', { 'data-ui': 'Avatar', style: cx({
      width: size, height: size, borderRadius: v('radius-full'), background: v('color-primary'),
      color: '#fff', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.4, fontWeight: v('weight-bold'), overflow: 'hidden',
    }, p.style) }, p.src ? h('img', { src: p.src, style: { width: '100%', height: '100%', objectFit: 'cover' } }) : (p.initials || '?'));
  }

  // ── data ─────────────────────────────────────────────────────────────
  function ListRow(p) {
    return h('div', { 'data-ui': 'ListRow', style: cx({
      display: 'flex', alignItems: 'center', gap: 12, padding: '12px 4px',
      borderBottom: '1px solid ' + v('color-border'),
    }, p.style) }, [
      p.leading && h('div', { key: 'l' }, p.leading),
      h('div', { key: 'm', style: { flex: 1, minWidth: 0 } }, [
        h('div', { key: 't', style: { fontWeight: v('weight-medium'), fontSize: 15 } }, p.title),
        p.subtitle && h('div', { key: 's', style: { color: v('color-text-secondary'), fontSize: 13 } }, p.subtitle),
      ]),
      p.trailing && h('div', { key: 'tr' }, p.trailing),
    ]);
  }

  function StatCard(p) {
    return h(Card, { 'data-ui': 'StatCard', style: cx({ minWidth: 160 }, p.style) }, h('div', null, [
      h('div', { key: 'l', style: { color: v('color-text-secondary'), fontSize: 13, fontWeight: v('weight-medium') } }, p.label),
      h('div', { key: 'v', style: { fontFamily: v('font-heading'), fontSize: 32, fontWeight: v('weight-bold'), margin: '4px 0' } }, p.value),
      p.delta && h('div', { key: 'd', style: { fontSize: 13, color: p.deltaUp === false ? v('color-error') : v('color-success') } }, p.delta),
    ]));
  }

  function EmptyState(p) {
    return h('div', { 'data-ui': 'EmptyState', style: cx({
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      textAlign: 'center', gap: 10, padding: 48, color: v('color-text-secondary'),
    }, p.style) }, [
      p.icon && h('div', { key: 'i', style: { fontSize: 40, opacity: 0.5 } }, p.icon),
      h('div', { key: 't', style: { fontWeight: v('weight-medium'), color: v('color-text'), fontSize: 16 } }, p.title),
      p.description && h('div', { key: 'd', style: { fontSize: 14, maxWidth: 360 } }, p.description),
      p.action && h('div', { key: 'a', style: { marginTop: 8 } }, p.action),
    ]);
  }

  function Chart(p) {
    // Lightweight bar chart from {data:[{label,value}]} — falls back gracefully
    // if Recharts is unavailable. Keeps a structural payload for export.
    var data = p.data || [];
    var max = data.reduce(function (m, d) { return Math.max(m, d.value || 0); }, 1);
    return h('div', { 'data-ui': 'Chart', 'data-chart': JSON.stringify({ type: p.type || 'bar', data: data }), style: cx({
      display: 'flex', alignItems: 'flex-end', gap: 8, height: p.height || 180, padding: 8,
    }, p.style) }, data.map(function (d, i) {
      return h('div', { key: i, style: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 } }, [
        h('div', { key: 'b', style: { width: '100%', height: (((d.value || 0) / max) * 100) + '%', background: v('color-primary'), borderRadius: v('radius-sm') } }),
        h('div', { key: 'l', style: { fontSize: 11, color: v('color-text-secondary') } }, d.label),
      ]);
    }));
  }

  function Heading(p) { return h(p.as || 'h2', { 'data-ui': 'Heading', style: cx({ fontFamily: v('font-heading'), fontWeight: v('weight-bold'), margin: 0 }, p.style) }, p.children); }
  function Text(p) { return h('p', { 'data-ui': 'Text', style: cx({ color: p.muted ? v('color-text-secondary') : v('color-text'), margin: 0 }, p.style) }, p.children); }

  window.UI = {
    Screen: Screen, Stack: Stack, Row: Row, AppShell: AppShell, Sidebar: Sidebar, SidebarItem: SidebarItem,
    TopBar: TopBar, StatusBar: StatusBar, TabBar: TabBar, Card: Card, Section: Section, Hero: Hero,
    Button: Button, Field: Field, Badge: Badge, Avatar: Avatar, ListRow: ListRow, StatCard: StatCard,
    EmptyState: EmptyState, Chart: Chart, Heading: Heading, Text: Text,
  };
})();
