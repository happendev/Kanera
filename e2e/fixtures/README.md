# Media preview fixtures

These tiny generated files exercise audio/video decoding and playback across attachment surfaces.
They contain no external media. The committed bytes let CI run without FFmpeg; regenerate locally:

```bash
ffmpeg -f lavfi -i testsrc2=size=64x64:rate=10 -t 0.5 -c:v libvpx -b:v 30k -an -y e2e/fixtures/preview.webm
ffmpeg -f lavfi -i sine=frequency=440:sample_rate=8000 -t 0.5 -c:a pcm_s16le -y e2e/fixtures/preview.wav
```
