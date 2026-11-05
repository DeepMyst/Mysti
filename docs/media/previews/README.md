# Inline README preview

`agent-opinions.gif` is a lightweight, looping preview of the existing
[Beta 2 agent-opinions recording](../../releases/2.0.1-beta.2/media/agent-opinions.mp4).
It preserves the complete frame and the visible **sample data** banner. The
recording uses scripted responses in the shipped interface; it is not evidence
of live provider execution.

The GIF is 840 × 630 at 8 fps, with a 192-color palette. There is no crop or
intentional playback-speed change. GIF frame timing is rounded to centiseconds.
[manifest.json](manifest.json) records source/output SHA-256, size, duration,
frame count, FFmpeg version and verification.

Run from the repository root with FFmpeg installed:

```sh
ffmpeg -hide_banner -loglevel error -threads 1 -filter_complex_threads 1 -y \
  -i docs/releases/2.0.1-beta.2/media/agent-opinions.mp4 \
  -filter_complex 'fps=8,scale=840:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle' \
  -loop 0 docs/media/previews/agent-opinions.gif
```

Before replacing the preview, decode the whole GIF, inspect its start/middle/end
frames at README size, and update the manifest from the resulting bytes.
