# Media preview fixtures

These tiny generated files exercise audio/video decoding and playback across attachment surfaces.
They contain no external media. The committed bytes let CI run without FFmpeg; regenerate locally:

```bash
ffmpeg -f lavfi -i testsrc2=size=64x64:rate=10 -t 0.5 -c:v libvpx -b:v 30k -an -y e2e/fixtures/preview.webm
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=8000 -t 0.5 -c:a pcm_s16le -y e2e/fixtures/preview.wav
```

## Images and documents

`sample.png`, `sample.jpg`, `sample.pdf` and `sample.docx` are committed E2E-owned samples.
They were copied from the demo assets when separating the suites; tests read only these copies.
Demo renames, replacement media and deletions must not change these fixtures. The two distinct
images exercise editor reordering; the PDF and DOCX exercise preview bytes and download behaviour.
