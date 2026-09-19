# Minimum extension-host declarations

`npm run typecheck:minimum` checks both shipped Node entry graphs (extension and
Desk worker) against Node 18.17 declarations. The normal source and editor checks
retain the main TypeScript compiler; all project commands select it explicitly
because npm aliases can otherwise change which compiler owns the `tsc` bin link.

The minimum project uses pinned `node18-types` (an alias of `@types/node`
18.17.19) and `typescript-minimum` (TypeScript 5.6.3). The contemporary Buffer
declarations predate TypeScript 5.7's generic typed arrays; the separate compiler
keeps that type-system mismatch from masquerading as a runtime incompatibility.
Neither dependency is shipped or used to generate production JavaScript.

The compiler host resolves every transitive `node` type reference to that pinned
package. It rejects newer Node declarations and `lib.dom` entering the host graph.
Compiled positive/negative controls verify native fetch/streams/abort APIs while
rejecting newer `util.styleText`, global `File`, and browser `document`. The
webview keeps its separate browser target and normal source check.

Node 18.17.1 exposes fetch APIs omitted by its contemporary DefinitelyTyped
package. `globals.d.ts` supplies their global names using the declaration files
from the **Undici 5.22.1 actually bundled in that Node release**. The `undici/`
directory contains only upstream declaration files and its MIT license; no
Undici runtime code is installed or executed. `vendor.json` records provenance,
distribution integrity and hashes checked before compilation.

Sources:

- [Node 18.17.1 global APIs](https://nodejs.org/download/release/v18.17.1/docs/api/globals.html)
- [Its bundled Undici version](https://github.com/nodejs/node/blob/v18.17.1/deps/undici/src/package.json)
- [Its Undici declarations](https://github.com/nodejs/node/tree/v18.17.1/deps/undici/src/types)

Declarations do not establish runtime behavior or third-party runtime support.
The exact Node 18.17.1 executable and installed-editor gates remain required.
Adding a new host bundle or changing these pins requires updating and validating
this project; the checker fails if a webpack Node entry is absent.
