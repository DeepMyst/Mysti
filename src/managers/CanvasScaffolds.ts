/**
 * Mysti - AI Coding Agent
 * Copyright (c) 2025 DeepMyst Inc. All rights reserved.
 *
 * Author: Baha Abunojaim <baha@deepmyst.com>
 * Website: https://www.deepmyst.com/mysti
 *
 * This file is part of Mysti, licensed under the Apache License, Version 2.0.
 * See the LICENSE file in the project root for full license terms.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Curated app/website page scaffolds (Plan 05 — app/web focus). Each is a
 * complete `function Page()` JSX component built on the `UI.*` design-system
 * primitives + theme tokens, so the agent (or a user) starts a screen from a
 * strong, on-brand layout instead of a blank page, then refines it. Surfaced to
 * the agent via the `list_scaffolds` / `scaffold_page` tools.
 */

export type ScaffoldDevice = 'mobile' | 'tablet' | 'desktop' | 'web';

export interface PageScaffold {
  id: string;
  name: string;
  description: string;
  /** Device formats this scaffold suits best. */
  devices: ScaffoldDevice[];
  /** A single `function Page()` component using the global `UI.*` + JSX. */
  jsx: string;
}

const LOGIN = `function Page() {
  return (
    <UI.Screen style={{ alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <UI.Card style={{ width: 360, maxWidth: '100%' }}>
        <UI.Stack gap={16}>
          <UI.Heading as="h1" style={{ fontSize: 24 }}>Welcome back</UI.Heading>
          <UI.Text muted>Sign in to continue to your account.</UI.Text>
          <UI.Field label="Email" placeholder="you@example.com" />
          <UI.Field label="Password" placeholder="••••••••" />
          <UI.Button size="lg" label="Sign in" style={{ width: '100%', justifyContent: 'center' }} />
          <UI.Text muted style={{ textAlign: 'center', fontSize: 13 }}>
            Don't have an account? Sign up
          </UI.Text>
        </UI.Stack>
      </UI.Card>
    </UI.Screen>
  );
}`;

const MOBILE_HOME = `function Page() {
  return (
    <UI.Screen>
      <UI.StatusBar />
      <UI.Stack gap={16} padding={16} style={{ flex: 1 }}>
        <UI.Row justify="space-between">
          <UI.Heading as="h1" style={{ fontSize: 26 }}>Good morning</UI.Heading>
          <UI.Avatar initials="AB" />
        </UI.Row>
        <UI.Card>
          <UI.Text muted style={{ fontSize: 13 }}>Balance</UI.Text>
          <UI.Heading as="div" style={{ fontSize: 34, margin: '4px 0' }}>$12,480.00</UI.Heading>
          <UI.Row gap={8}>
            <UI.Button label="Send" />
            <UI.Button variant="secondary" label="Request" />
          </UI.Row>
        </UI.Card>
        <UI.Heading as="h2" style={{ fontSize: 17 }}>Recent activity</UI.Heading>
        <UI.Card padding={4}>
          <UI.ListRow leading={<UI.Avatar initials="SP" size={32} />} title="Spotify" subtitle="Subscription" trailing={<UI.Text>-$9.99</UI.Text>} />
          <UI.ListRow leading={<UI.Avatar initials="AC" size={32} />} title="Acme Co" subtitle="Salary" trailing={<UI.Badge tone="success">+$3,200</UI.Badge>} />
          <UI.ListRow leading={<UI.Avatar initials="UB" size={32} />} title="Uber" subtitle="Transport" trailing={<UI.Text>-$24.50</UI.Text>} />
        </UI.Card>
      </UI.Stack>
      <UI.TabBar items={[
        { label: 'Home', icon: '⌂', active: true },
        { label: 'Cards', icon: '▭' },
        { label: 'Activity', icon: '☰' },
        { label: 'Profile', icon: '◔' },
      ]} />
    </UI.Screen>
  );
}`;

const DASHBOARD = `function Page() {
  const sidebar = (
    <UI.Sidebar brand="◆ Acme">
      <UI.SidebarItem label="Overview" active />
      <UI.SidebarItem label="Customers" />
      <UI.SidebarItem label="Revenue" />
      <UI.SidebarItem label="Reports" />
      <UI.SidebarItem label="Settings" />
    </UI.Sidebar>
  );
  const topBar = <UI.TopBar title="Overview" actions={[<UI.Button key="n" variant="secondary" label="Export" />, <UI.Avatar key="a" initials="AB" />]} />;
  return (
    <UI.AppShell sidebar={sidebar} topBar={topBar}>
      <UI.Stack gap={20}>
        <UI.Row gap={16}>
          <UI.StatCard label="Revenue" value="$48.2k" delta="▲ 12.4% MoM" />
          <UI.StatCard label="Active users" value="3,914" delta="▲ 4.1%" />
          <UI.StatCard label="Churn" value="1.8%" delta="▼ 0.3%" deltaUp={false} />
          <UI.StatCard label="NPS" value="62" delta="▲ 5" />
        </UI.Row>
        <UI.Row gap={16} align="stretch">
          <UI.Card style={{ flex: 2 }}>
            <UI.Heading as="h3" style={{ fontSize: 16, marginBottom: 12 }}>Revenue by month</UI.Heading>
            <UI.Chart data={[
              { label: 'Jan', value: 22 }, { label: 'Feb', value: 30 }, { label: 'Mar', value: 28 },
              { label: 'Apr', value: 41 }, { label: 'May', value: 38 }, { label: 'Jun', value: 48 },
            ]} />
          </UI.Card>
          <UI.Card style={{ flex: 1 }}>
            <UI.Heading as="h3" style={{ fontSize: 16, marginBottom: 8 }}>Top customers</UI.Heading>
            <UI.ListRow title="Globex" subtitle="Enterprise" trailing={<UI.Text>$12.4k</UI.Text>} />
            <UI.ListRow title="Initech" subtitle="Growth" trailing={<UI.Text>$8.1k</UI.Text>} />
            <UI.ListRow title="Umbrella" subtitle="Growth" trailing={<UI.Text>$6.7k</UI.Text>} />
          </UI.Card>
        </UI.Row>
      </UI.Stack>
    </UI.AppShell>
  );
}`;

const SETTINGS = `function Page() {
  return (
    <UI.Screen>
      <UI.StatusBar />
      <UI.Stack gap={16} padding={16}>
        <UI.Heading as="h1" style={{ fontSize: 26 }}>Settings</UI.Heading>
        <UI.Card padding={4}>
          <UI.ListRow leading={<UI.Avatar initials="AB" />} title="Baha Abunojaim" subtitle="baha@deepmyst.com" trailing={<UI.Text muted>›</UI.Text>} />
        </UI.Card>
        <UI.Text muted style={{ fontSize: 12, textTransform: 'uppercase' }}>Account</UI.Text>
        <UI.Card padding={4}>
          <UI.ListRow title="Notifications" trailing={<UI.Badge tone="primary">On</UI.Badge>} />
          <UI.ListRow title="Privacy" trailing={<UI.Text muted>›</UI.Text>} />
          <UI.ListRow title="Security" trailing={<UI.Text muted>›</UI.Text>} />
        </UI.Card>
        <UI.Text muted style={{ fontSize: 12, textTransform: 'uppercase' }}>About</UI.Text>
        <UI.Card padding={4}>
          <UI.ListRow title="Help & support" trailing={<UI.Text muted>›</UI.Text>} />
          <UI.ListRow title="Terms & privacy" trailing={<UI.Text muted>›</UI.Text>} />
        </UI.Card>
        <UI.Button variant="ghost" label="Sign out" style={{ justifyContent: 'center' }} />
      </UI.Stack>
    </UI.Screen>
  );
}`;

const LANDING = `function Page() {
  return (
    <UI.Screen>
      <UI.TopBar title="◆ Acme" actions={[<UI.Button key="s" variant="ghost" label="Sign in" />, <UI.Button key="g" label="Get started" />]} />
      <UI.Hero
        eyebrow="New"
        title="Ship beautiful products, faster"
        subtitle="The all-in-one platform that helps teams design, build, and launch — without the busywork."
      >
        <UI.Row gap={12} justify="center">
          <UI.Button size="lg" label="Start free" />
          <UI.Button size="lg" variant="secondary" label="Book a demo" />
        </UI.Row>
      </UI.Hero>
      <UI.Section title="Everything you need" subtitle="Powerful building blocks, thoughtfully designed.">
        <UI.Row gap={20} align="stretch">
          <UI.Card style={{ flex: 1 }}>
            <UI.Heading as="h3" style={{ fontSize: 18, marginBottom: 6 }}>Design</UI.Heading>
            <UI.Text muted>On-brand components and themes out of the box.</UI.Text>
          </UI.Card>
          <UI.Card style={{ flex: 1 }}>
            <UI.Heading as="h3" style={{ fontSize: 18, marginBottom: 6 }}>Build</UI.Heading>
            <UI.Text muted>From idea to working screens in minutes.</UI.Text>
          </UI.Card>
          <UI.Card style={{ flex: 1 }}>
            <UI.Heading as="h3" style={{ fontSize: 18, marginBottom: 6 }}>Launch</UI.Heading>
            <UI.Text muted>Export, share, and ship with confidence.</UI.Text>
          </UI.Card>
        </UI.Row>
      </UI.Section>
    </UI.Screen>
  );
}`;

export const PAGE_SCAFFOLDS: readonly PageScaffold[] = [
  { id: 'login', name: 'Login', description: 'Centered sign-in card with email/password.', devices: ['mobile', 'tablet', 'desktop', 'web'], jsx: LOGIN },
  { id: 'mobile-home', name: 'Mobile home', description: 'A finance-style mobile home screen with balance, activity, and a tab bar.', devices: ['mobile'], jsx: MOBILE_HOME },
  { id: 'dashboard', name: 'Desktop dashboard', description: 'App shell with sidebar, stat cards, a chart, and a list.', devices: ['desktop', 'tablet'], jsx: DASHBOARD },
  { id: 'settings', name: 'Settings', description: 'Grouped settings list with profile header.', devices: ['mobile', 'desktop'], jsx: SETTINGS },
  { id: 'landing', name: 'Landing page', description: 'Marketing page with hero, CTAs, and a feature section.', devices: ['web', 'desktop'], jsx: LANDING },
] as const;

const BY_ID = new Map(PAGE_SCAFFOLDS.map(s => [s.id, s]));

export function getScaffold(id: string): PageScaffold | undefined {
  return BY_ID.get(id);
}

/** List scaffolds, optionally filtered to those suiting a device. */
export function listScaffolds(device?: ScaffoldDevice): Array<Omit<PageScaffold, 'jsx'>> {
  return PAGE_SCAFFOLDS
    .filter(s => !device || s.devices.includes(device))
    .map(({ jsx: _jsx, ...meta }) => meta);
}
