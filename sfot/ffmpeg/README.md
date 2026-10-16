FFmpeg is built from the official 8.0.3 release, verified against the SHA-256 in
the Dockerfile. That release includes upstream fix
380a518c439d4e5e3cf17b97e4a06259e8048f99 for seeking in HLS with fragmented MP4.
The Debian bookworm FFmpeg package lacks this fix.

Both build and runtime retain Python 3.11 on bookworm. FFmpeg's libraries link
statically into `/opt/ffmpeg/bin/ffmpeg` and `ffprobe`; the executables use
bookworm's GnuTLS, dav1d, x264 and zlib shared libraries. No newer-distribution
libraries replace Python/Paddle's libraries. The prefix is first on `PATH`.

All default native codecs, demuxers, muxers, filters and CPU detection remain
enabled. Explicit external dependencies preserve HTTPS via GnuTLS, software AV1
decoding via dav1d, and H.264 encoding via x264 for local integration fixtures.
H.264, HEVC/H.265 and VP9 decoding remain native; MJPEG output and lavfi fixture
generation remain enabled. Optional external libraries from Debian's broader
build are not included, and ffplay, documentation and debug symbols are omitted.
This build retains GPL licensing through x264, as did Debian's FFmpeg package.

From this directory's parent, build the dependency alone with
`docker build --target ffmpeg -t bazaar-ffmpeg:8.0.3 .`.
The `ffmpeg-test` target runs `ffmpeg/verify.py` against the shipped binary using
local HTTP MP4, MPEG-TS HLS and fragmented-MP4 HLS controls. It checks off-keyframe
seeking, sampled timestamps, frame counts and identical ordered JPEG hashes.
