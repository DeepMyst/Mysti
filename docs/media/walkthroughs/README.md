# Walkthrough screenshot provenance

[Visual Test walkthrough](../../walkthroughs/visual-test.md) uses
[visual-test-config.png](visual-test-config.png), a fresh capture of the shipped
Visual Test configuration form with synthetic localhost inputs. Its visible
banner identifies the interface version and sample data.

The capture loads the actual `media/vt-dashboard/` HTML, CSS and JavaScript with
a mock VS Code bridge and the release recorder's editor-theme variables. It
captures the idle form, then checks that Start sends exactly one expected
configuration message to that mock. It does not start a server, call a model,
inspect an app or produce an acceptance verdict. Network requests are blocked.
The production webview CSP is omitted only in this isolated composition, as in
the existing release recorder; extension files and policy are unchanged.

From the repository root, with the Node version in `.nvmrc`, locked dependencies
and the matching Playwright Chromium installed:

```sh
node docs/media/walkthroughs/capture-visual-test.cjs
```

[visual-test-config.json](visual-test-config.json) records the capture command,
tool versions, viewport, source hashes, checks and resulting PNG hash. Review
the image and provenance together after regeneration. No image editing or
synthetic UI drawing is used.
