# Publishing Mysti demos on GitHub

The README, feature gallery and release page use native GitHub video attachments.
Repository MP4 links open file pages and do not become inline players. GitHub's
[attachment guide](https://docs.github.com/en/github-cli/github-cli/attaching-files-with-github-cli)
describes the supported upload and Markdown syntax.

## Record and preserve the source

1. Record the relevant workflows with `npm run demo:record`, following the
   [capture guide](../DEMO_GALLERY.md#recording-and-validation-details).
2. Review the actual video, captions and sample-data labels. Keep H.264 MP4s
   below GitHub's applicable upload limit; the Beta 2 clips and tour are each
   below 10 MB.
3. Preserve the original files and capture hashes. Hosting a clip on GitHub does
   not change its evidence scope or establish native-provider acceptance.

## Upload once, then reuse the canonical URLs

Use a GitHub CLI version that supports `--attach` (2.99 or newer), with push
access to the repository. Prepare a PR body containing each local video as the
only content in its paragraph:

```markdown
### Complete feature tour

![](docs/releases/2.0.1-beta.2/media/mysti-feature-tour.mp4)
```

Attach the same exact path to the documentation PR:

```sh
gh pr edit PR_NUMBER --repo DeepMyst/Mysti \
  --body-file demo-review.md \
  --attach docs/releases/2.0.1-beta.2/media/mysti-feature-tour.mp4
```

Repeat `--attach` for additional clips. The CLI uploads the files and replaces
these references with canonical `https://github.com/user-attachments/assets/…`
URLs. Read back the PR body after upload; a partially failed batch can already
contain successful attachments, so do not blindly upload every file again.

Copy each canonical URL onto its own line, with blank lines around it, in the
README or gallery. Keep it outside tables, inline sentences and code blocks.
A standalone URL renders as a native GitHub player. Do not use a repository
`blob`/`raw` URL, Markdown image syntax pointing at an MP4, or a hand-written
video/iframe element as a substitute.

Update [github-videos.json](github-videos.json) with each source file's SHA-256,
size, duration, canonical URL and originating PR. Never save the renderer's
expiring signed CDN URL. If the recording changes, upload the new bytes and
update the mapping; do not reuse an old attachment as if it showed the new UI.

## Verify the reader's experience

- Open the actual public README, gallery and release page while signed out.
  Confirm the expected native players appear and the install/download actions
  remain easy to find.
- Play each clip. Check that metadata loads, the video has the expected
  dimensions and duration, and `currentTime` advances without a media error.
  Seek through the complete tour as well.
- Check a desktop and narrow viewport. Review caption legibility, image loading,
  table overflow, section navigation and the first installation action.
- A successful Markdown render or HTTP response alone is not playback proof.
  Keep environment/network failures separate from a passing result. If a local
  certificate issue prevents the check, use a clean runner with normal TLS
  validation rather than disabling certificate checks.
- Keep the original MP4 download and video kit available for offline use.
  Update the live release description to the working player and corrected
  gallery; an immutable release tag still contains its original Markdown.

The [opinions GIF](previews/README.md) is a lightweight inline motion preview
for image-only renderers. It complements the full native players. Promotional
media under `docs/` stays outside the extension package.
