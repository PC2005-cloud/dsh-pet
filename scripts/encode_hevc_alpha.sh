#!/bin/zsh
# ============================================================================
# HEVC-with-Alpha 批量编码（sunkeycn 方案，macOS 原生 AVFoundation）
#
# 原理：ffmpeg 只负责把 VP9-alpha webm 解码成原始 BGRA 帧（stdin 管道），
#       真正的 HEVC-with-Alpha 编码交给 swift 程序（AVAssetWriter +
#       AVVideoCodecType.hevcWithAlpha）——苹果原生 API，产物由 Safari 原生
#       验证支持（issue 贡献者已在 Safari 实测）。
#
# 用法：
#   ./encode_hevc_alpha.sh [素材目录] [输出目录]
#   默认素材 = .（兼容流水线 clone 主仓库后的 assets/webm 或 assets/thumb）
#   默认输出 = ./dist
#
# 依赖（macOS runner）：
#   - ffmpeg（解码 webm：本脚本优先用 $FFMPEG_BIN，其次 PATH 中的 ffmpeg）
#   - xcrun + swiftc（系统自带，编译编码器）
#   - hevc_alpha_encoder.swift（与本脚本同目录）
#
# 断点续跑：输出 mov 比源 webm 新则跳过（与主仓库素材链脚本同款模式）。
# ============================================================================

set -euo pipefail

# ---- 参数：素材目录 / 输出目录 ----
# 兼容两种素材布局：直接给目录，或相对 main-repo/（流水线 clone 主仓库后）
if [[ -n "$1" ]]; then
  asset_dir=$1
else
  if [[ -d "main-repo/dsh-pet/assets/webm" ]]; then
    asset_dir="main-repo/dsh-pet/assets/webm"
  elif [[ -d "main-repo/dsh-pet/assets/thumb" ]]; then
    asset_dir="main-repo/dsh-pet/assets/thumb"
  elif [[ -d "dsh-pet/assets/webm" ]]; then
    asset_dir="dsh-pet/assets/webm"
  elif [[ -d "dsh-pet/assets/thumb" ]]; then
    asset_dir="dsh-pet/assets/thumb"
  else
    print -u2 "no asset dir found; pass it as \$1 (e.g. main-repo/dsh-pet/assets/webm)"
    exit 1
  fi
fi
out_dir=${2:-dist}

script_dir=${0:A:h}
encoder_src="$script_dir/hevc_alpha_encoder.swift"
encoder_bin=$(mktemp /tmp/dsh-pet-hevc-alpha.XXXXXX)
temp_output=''

cleanup() {
  rm -f "$encoder_bin"
  if [[ -n "$temp_output" ]]; then
    rm -f "$temp_output"
  fi
}
trap cleanup EXIT INT TERM

# ---- ffmpeg 定位 ----
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

# ---- 编译 Swift 编码器（macOS 原生 AVFoundation + VideoToolbox）----
xcrun swiftc -O -suppress-warnings \
  -framework AVFoundation \
  -framework CoreVideo \
  -framework VideoToolbox \
  "$encoder_src" \
  -o "$encoder_bin"

# ---- 批量编码 ----
mkdir -p "$out_dir"
webm_files=("$asset_dir"/*.webm(N))
if (( ${#webm_files} == 0 )); then
  print -u2 "no WebM assets found: $asset_dir"
  exit 1
fi

converted=0
skipped=0
for source_file in "${webm_files[@]}"; do
  output_file="$out_dir/${source_file:t:r}.mov"
  if [[ -f "$output_file" && "$output_file" -nt "$source_file" ]]; then
    (( skipped += 1 ))
    continue
  fi

  temp_output="$out_dir/${source_file:t:r}.tmp.mov"
  rm -f "$temp_output"
  print "[$(( converted + skipped + 1))/${#webm_files}] ${source_file:t}"
  # ffmpeg：libvpx-vp9 解码（保留 alpha）→ 原始 BGRA 帧 → swift 编码器
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

print "done: converted=$converted skipped=$skipped total=${#webm_files} out=$out_dir"