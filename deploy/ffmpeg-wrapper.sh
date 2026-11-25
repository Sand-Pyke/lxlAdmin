#!/bin/sh
# Private copy of the existing Debian FFmpeg and its loader; no host library replacement.
runtime=/opt/lxl-ffmpeg/debian-runtime
exec "$runtime/lib64/ld-linux-x86-64.so.2" \
  --library-path "$runtime/lib/x86_64-linux-gnu:$runtime/usr/lib/x86_64-linux-gnu:$runtime/usr/lib/x86_64-linux-gnu/pulseaudio" \
  "$runtime/usr/bin/ffmpeg" "$@"
