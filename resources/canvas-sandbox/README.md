<!--
 Mysti - AI Coding Agent
 Copyright (c) 2025 DeepMyst Inc. All rights reserved.

 Author: Baha Abunojaim <baha@deepmyst.com>
 Website: https://www.deepmyst.com/mysti

 This file is part of Mysti, licensed under the Apache License, Version 2.0.
 See the LICENSE file in the project root for full license terms.

 SPDX-License-Identifier: Apache-2.0
-->

# Canvas Sandbox Runtime

Locally bundled third-party runtime for the Canvas v2 sandboxed page iframes
(Plan 05 Phase 0, finding F-6 — sandbox hardening).

These files replace the previous `unpkg.com` CDN `<script src>` references. They
are fetched by the parent canvas webview (same-origin to itself) and **inlined
as `<script>` text** into the `srcdoc` of each page iframe. Because the iframes
run with `sandbox="allow-scripts"` and **no `allow-same-origin`**, generated /
Stitch code executes in a unique opaque origin and cannot reach the parent
webview, `vscodeApi`, or the workspace.

## Bundled files (third-party — NOT Apache-2.0)

| File | Package | Version | License |
|---|---|---|---|
| `react.production.min.js` | `react` | 18.3.1 | MIT (Meta) |
| `react-dom.production.min.js` | `react-dom` | 18.3.1 | MIT (Meta) |
| `babel.min.js` | `@babel/standalone` | 7.26.4 | MIT (The Babel project) |

The original per-file license headers are preserved at the top of each minified
bundle. Each package retains its own MIT license; Mysti's Apache-2.0 license
applies only to Mysti's own source, not to these vendored artifacts.

## Mysti runtime (Apache-2.0, Plan 05 M1)

| File | Purpose |
|---|---|
| `ui-primitives.js` | The `UI.*` design-system primitives, oriented to **app & website UI** (AppShell, Sidebar, TopBar, StatusBar, TabBar, Card, Section, Hero, Button, Field, Badge, Avatar, ListRow, StatCard, EmptyState, Chart, Stack/Row, Heading/Text). Self-styled via the `--theme-*` CSS vars so screens stay on-brand without Tailwind. Plain `React.createElement` (loaded before the harness, so no JSX here). |
| `harness.js` | Runs last: Babel-compiles a `jsx` page's `function Page()` and mounts it (wrapped in an error boundary); `html` pages are already in the DOM. Tags elements with DOM-index `data-el` paths, reports content size to the parent, and posts `page_render_error` on failure. Talks to the parent only via `postMessage`. |

The iframe document is assembled by [`src/managers/CanvasSandbox.ts`](../../src/managers/CanvasSandbox.ts)
(`buildPageDocument`) — it injects the theme as `--theme-*` custom properties,
sizes a fixed design-px page box from the format (real device px for app/web
screens), and inlines the scripts in this load order:

`React` → `ReactDOM` → `Recharts` (optional, not yet vendored — `UI.Chart`
falls back to a CSS bar chart) → `Babel` (jsx only) → `ui-primitives.js` →
page source → `harness.js`.

**Next (M1 webview / F5):** wire the canvas webview to load these via
`asWebviewUri`, set the iframe `srcdoc` from `buildPageDocument`, and position
the page-frame overlay; then the agent's `write_page_jsx` output renders live at
device size.

## Updating

Re-fetch matching versions from a CDN, e.g.:

```sh
curl -sSL -o resources/canvas-sandbox/react.production.min.js \
  https://unpkg.com/react@18.3.1/umd/react.production.min.js
curl -sSL -o resources/canvas-sandbox/react-dom.production.min.js \
  https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js
curl -sSL -o resources/canvas-sandbox/babel.min.js \
  https://unpkg.com/@babel/standalone@7.26.4/babel.min.js
```
