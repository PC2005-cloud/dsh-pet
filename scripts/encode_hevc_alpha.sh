#!/bin/zsh
set -euo pipefail

script_dir=${0:A:h}
asset_dir="$script_dir/../dsh-pet/assets/thumb"
encoder_bin=$(mktemp /tmp/dsh-pet-hevc-alpha.XXXXXX)
temp_output=''

cleanup() {
  rm -f "$encoder_bin"
  if [[ -n "$temp_output" ]]; then
    rm -f "$temp_output"
  fi
}
trap cleanup EXIT INT TERM

if [[ -n ${FFMPEG_BIN:-} ]]; then
  ffmpeg_bin=$FFMPEG_BIN
elif command -v ffmpeg >/dev/null 2>&1; then
  ffmpeg_bin=$(command -v ffmpeg)
else
  print -u2 'ffmpeg not found; install it or set FFMPEG_BIN=/absolute/path/to/ffmpeg'
  exit 1
fi

if [[ ! -x "$ffmpeg_bin" ]]; then
  print -u2 "ffmpeg is not executable: $ffmpeg_bin"
  exit 1
fi

xcrun swiftc -O -suppress-warnings \
  -framework AVFoundation \
  -framework CoreVideo \
  -framework VideoToolbox \
  "$script_dir/hevc_alpha_encoder.swift" \
  -o "$encoder_bin"

webm_files=("$asset_dir"/*.webm(N))
if (( ${#webm_files} == 0 )); then
  print -u2 "no WebM assets found: $asset_dir"
  exit 1
fi

converted=0
skipped=0
for source_file in "${webm_files[@]}"; do
  output_file=${source_file:r}.mov
  if [[ -f "$output_file" && "$output_file" -nt "$source_file" ]]; then
    (( skipped += 1 ))
    continue
  fi

  temp_output="$output_file.tmp.mov"
  rm -f "$temp_output"
  print "[$(( converted + skipped + 1))/${#webm_files}] ${source_file:t}"
  "$ffmpeg_bin" \
    -hide_banner \
    -loglevel error \
    -c:v libvpx-vp9 \
    -i "$source_file" \
    -an \
    -f rawvideo \
    -pix_fmt bgra \
    pipe:1 \
    | "$encoder_bin" "$temp_output" 640 360 24
  mv -f "$temp_output" "$output_file"
  temp_output=''
  (( converted += 1 ))
done

print "done: converted=$converted skipped=$skipped total=${#webm_files}"
