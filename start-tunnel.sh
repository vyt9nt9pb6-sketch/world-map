#!/usr/bin/env bash
# 重新啟動 World Map 本機伺服器 + Cloudflare 臨時通道（quick tunnel，不需帳號），並印出新的公開網址。
# 用法：  ./start-tunnel.sh          重新啟動兩者
#         ./start-tunnel.sh stop     全部停止
#         ./start-tunnel.sh status   看目前狀態
# 需求：環境變數 AMAP_KEY（本腳本不會印出它）。
set -euo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"
PORT="${PORT:-8787}"
RUN="$ROOT/.run"
SERVER_LOG="$RUN/server.log"
TUNNEL_LOG="$ROOT/tunnel.log"
CLOUDFLARED="$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")"
mkdir -p "$RUN"

stop_pid() { # $1 = pid 檔
  if [[ -f "$1" ]]; then
    local pid; pid="$(cat "$1")"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
      kill -9 "$pid" 2>/dev/null || true
    fi
    rm -f "$1"
  fi
}
stop_all() {
  stop_pid "$RUN/tunnel.pid"
  stop_pid "$RUN/server.pid"
  # 清掉沒有 pid 檔的舊程序（只限本專案）
  pkill -f "cloudflared tunnel --no-autoupdate --protocol http2 --url http://127.0.0.1:$PORT" 2>/dev/null || true
  pkill -f "node $ROOT/server/server.mjs" 2>/dev/null || true
  pkill -f "^node server/server.mjs$" 2>/dev/null || true
}
status() {
  for n in server tunnel; do
    if [[ -f "$RUN/$n.pid" ]] && kill -0 "$(cat "$RUN/$n.pid")" 2>/dev/null; then echo "$n: 執行中 (PID $(cat "$RUN/$n.pid"))"; else echo "$n: 未執行"; fi
  done
  [[ -f "$RUN/url" ]] && echo "公開網址: $(cat "$RUN/url")"
  return 0
}

case "${1:-start}" in
  stop) stop_all; echo "已停止"; exit 0 ;;
  status) status; exit 0 ;;
  start|restart) ;;
  *) echo "用法: $0 [start|stop|status]"; exit 1 ;;
esac

if [[ -z "${AMAP_KEY:-}" && -f "$ROOT/.env" ]]; then set -a; . "$ROOT/.env"; set +a; fi
if [[ -z "${AMAP_KEY:-}" ]]; then
  echo "錯誤：環境變數 AMAP_KEY 未設定（請先 export AMAP_KEY=...，或放在 $ROOT/.env）" >&2
  exit 1
fi
if [[ ! -x "$CLOUDFLARED" ]]; then
  echo "安裝 cloudflared 到 ~/.local/bin ..."
  mkdir -p "$HOME/.local/bin"
  curl -fsSL -m 120 -o "$HOME/.local/bin/cloudflared" https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
  chmod +x "$HOME/.local/bin/cloudflared"
  CLOUDFLARED="$HOME/.local/bin/cloudflared"
fi

stop_all

# 1) 本機伺服器：只綁 127.0.0.1，外部只能經由通道進來
HOST=127.0.0.1 PORT="$PORT" setsid nohup node "$ROOT/server/server.mjs" >"$SERVER_LOG" 2>&1 </dev/null &
echo $! >"$RUN/server.pid"
for _ in $(seq 1 40); do
  curl -fs -o /dev/null "http://127.0.0.1:$PORT/" && break
  sleep 0.25
done
curl -fs -o /dev/null "http://127.0.0.1:$PORT/" || { echo "伺服器啟動失敗，請看 $SERVER_LOG" >&2; exit 1; }

# 2) Cloudflare quick tunnel（每次重新啟動網址都會改變）
#    這台機器的網路擋 UDP（QUIC），所以固定用 http2（TCP 443）
: >"$TUNNEL_LOG"
setsid nohup "$CLOUDFLARED" tunnel --no-autoupdate --protocol http2 --url "http://127.0.0.1:$PORT" >>"$TUNNEL_LOG" 2>&1 </dev/null &
echo $! >"$RUN/tunnel.pid"
URL=""
for _ in $(seq 1 120); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNNEL_LOG" | head -1 || true)"
  [[ -n "$URL" ]] && break
  sleep 0.5
done
if [[ -z "$URL" ]]; then echo "取不到通道網址，請看 $TUNNEL_LOG" >&2; exit 1; fi
echo "$URL" >"$RUN/url"

# 3) 確認通道真的連上 Cloudflare（log 出現 Registered tunnel connection）
REG=""
for _ in $(seq 1 45); do
  grep -q "Registered tunnel connection" "$TUNNEL_LOG" && { REG=1; break; }
  kill -0 "$(cat "$RUN/tunnel.pid")" 2>/dev/null || break
  sleep 2
done
if [[ -z "$REG" ]]; then
  echo "✘ 通道無法連上 Cloudflare（取得了網址 $URL，但連線沒有建立）。" >&2
  echo "  cloudflared 需要能對外連到 Cloudflare 的 7844 埠（TCP 或 UDP）；這台機器的網路可能擋住了。" >&2
  echo "  最後幾行錯誤：" >&2
  grep -E " ERR " "$TUNNEL_LOG" | tail -3 | cut -c1-200 >&2 || true
  stop_pid "$RUN/tunnel.pid"; rm -f "$RUN/url"
  echo "  本機伺服器仍在執行：http://127.0.0.1:$PORT （PID $(cat "$RUN/server.pid")）" >&2
  exit 2
fi

# 4) 等公開網址生效
code=""
for _ in $(seq 1 30); do
  code="$(curl -s -o /dev/null -w '%{http_code}' -m 10 "$URL/" || true)"
  [[ "$code" == "200" ]] && break
  sleep 2
done

echo "伺服器 PID: $(cat "$RUN/server.pid")"
echo "通道 PID:   $(cat "$RUN/tunnel.pid")"
echo "公開網址:   $URL"
[[ "$code" == "200" ]] || echo "（提醒：通道已連上，但網址暫時還打不開，通常再等 30 秒即可）"
