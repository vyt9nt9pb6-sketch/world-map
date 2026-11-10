#!/bin/sh
# 把約 500 m（f）與約 100 m（n）的人口圖磚上傳到 R2。
# 需要已登入的 wrangler，以及已建立的 bucket。
# 綁定名稱必須是 WM_POP（Worker → Settings → Bindings → R2）。
# 下次用 deploy 腳本重新部署前，請在 keep_bindings 加上 r2_bucket，否則綁定會被拿掉。
set -eu
BUCKET="${1:-world-map-pop}"
ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)/public/data/pop"
for level in m f n; do
  DIR="$ROOT/$level"
  if [ ! -d "$DIR" ]; then
    echo "找不到 $DIR 。先跑 python3 scripts/build-pop-tiles.py" >&2
    exit 1
  fi
  find "$DIR" -name '*.bin.gz' | while IFS= read -r f; do
    key="data/pop/$level/$(basename "$f")"
    echo "put $key"
    npx --yes wrangler r2 object put "$BUCKET/$key" --file "$f" --content-type application/gzip --cache-control "public, max-age=86400"
  done
done
