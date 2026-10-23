# World Map v1

給長途自駕用的網頁地圖：高德高清底圖、搜尋、駕車路線（含過路費）、一鍵交給高德地圖／Apple 地圖導航。
手機（iPhone Safari）優先，桌機也能用；之後可以包成 App。

## 功能

| 功能 | 說明 |
|---|---|
| 底圖 | 高德標準地圖（GCJ-02），可切換**衛星圖**，衛星圖可開關**道路標註**。高解析度螢幕（Retina）自動使用 512px 高清圖磚。 |
| 定位 | 右下角按鈕。瀏覽器回傳 WGS-84，程式轉成 GCJ-02 再顯示（中國境外不轉換）。 |
| 搜尋 | 關鍵字搜尋地點（以地圖中心 50 公里內優先；附近找不到完全符合的名稱時改搜全國），同時做地址解析。結果有清單與地圖編號標記；點一下可設為起點／終點／途經點。長按（或桌機右鍵）地圖也能選點。 |
| 駕車路線 | 起點預設「我的位置」，可加最多 16 個途經點。顯示距離、時間、**過路費**、收費路段長度、紅綠燈數、主要道路；最多 3 條候選路線。偏好：推薦／速度優先／避免收費／高速優先／不走高速。 |
| 導航 | 「高德地圖導航」：iPhone 先開高德 App（`iosamap://path`），沒裝 App 就改開高德網頁版（`uri.amap.com/navigation`）。「Apple 地圖」：開 `maps.apple.com` 駕車導航。 |

介面文字是繁體中文；地名、道路名照高德回傳的原樣顯示（多為簡體）。

## 架構

```
public/                 前端（純靜態檔，無需編譯）
  index.html  css/app.css  js/app.js
  js/lib/coords.js      WGS-84 ⇄ GCJ-02 轉換
  js/lib/layers.js      高德圖磚網址與高清策略
  js/lib/navlinks.js    高德／Apple 導航連結
  js/lib/api.js         呼叫自家 /api（前端完全沒有金鑰）
  vendor/leaflet/       Leaflet 1.9.4（地圖引擎）
core/                   後端邏輯（平台無關：標準 Fetch Request → Response）
  handlers.js           /api/search、/api/geocode、/api/route
  validate.js           參數白名單與驗證
  mapping.js            高德回應 → 精簡 JSON
  ratelimit.js          每個 IP 的限流
server/server.mjs       本機 Node 伺服器（靜態檔＋/api）
api/*.js + vercel.json  Vercel 部署用
worker/index.js + wrangler.toml  Cloudflare Workers 部署用
tests/                  單元測試（node --test）
scripts/                驗證腳本（API、圖磚、金鑰檢查、截圖）
start-tunnel.sh         重新啟動本機伺服器＋Cloudflare 臨時通道
```

### 金鑰安全
- 高德 Web 服務 Key 只放在伺服器的環境變數 `AMAP_KEY`，只在 `core/handlers.js` 的 `callAmap()` 加到上游請求。
- 前端只呼叫自家的 `/api/search`、`/api/geocode`、`/api/route`；其他 `/api/*` 一律 404，只接受 GET。
- 每個參數都經過白名單驗證（型別、長度、座標範圍、POI ID 格式）；使用者自己帶的 `key`、`callback` 等參數會被丟掉。
- 只會轉送到固定的 `https://restapi.amap.com` 四個路徑；錯誤訊息與日誌都不含上游網址或金鑰（日誌只記方法、路徑、狀態碼）。
- 限流：每個 IP 突發 30 次、之後每 2 秒 1 次；全站突發 200 次、之後每 50 秒 1 次（保護每日配額）。數值可用環境變數 `RATE_BURST`、`RATE_PER_SEC`、`GLOBAL_BURST`、`GLOBAL_PER_SEC` 調整。
- 選填 `ALLOWED_ORIGINS`：只允許指定網域的網頁呼叫 /api（擋別人的網站直接盜用；擋不住刻意偽造的程式）。
- `npm run check:secrets` 會比對前端檔案、git 追蹤檔案、git 歷史（可加線上網址）裡是否出現金鑰的值，但不會印出金鑰。

### 座標系
- 全程使用 **GCJ-02**（高德座標）：圖磚、搜尋結果、路線都是 GCJ-02，直接當作 Leaflet 的經緯度使用，所以線和地圖完全對齊。
- 只有瀏覽器定位是 WGS-84，用標準轉換公式（Krasovsky 橢球）轉成 GCJ-02；中國範圍外不轉換。
- **交給 Apple 地圖時傳 GCJ-02**：Apple 地圖在中國大陸使用高德資料、以 GCJ-02 顯示與解讀座標（中國大陸的 Apple 地圖分享連結帶的就是 GCJ-02 座標）。這一點尚未在實機上驗證，所以起點是「我的位置」時不傳起點座標，讓 Apple 地圖自己用 GPS 定位，降低風險。
- 交給高德時明確標示 `dev=0`（iOS URI，表示座標已是 GCJ-02）與 `coordinate=gaode`（網頁版）。

### 高清圖磚（重要發現）
高德網頁圖磚加 `scale=2` 實際上仍回傳 256px。實測結果：
- `wprd0{1-4}…&scl=2&style=7` → 512px 高清底圖，但**沒有文字標註**。
- `wprd0{1-4}…&scl=1&style=8&ltype=4` → 只有文字標註的透明圖層（256px）。

所以高解析度螢幕（devicePixelRatio ≥ 1.5）的做法是：**512px 無字底圖＋256px 標註圖層疊加**。道路與區塊非常清晰，文字是正常大小但略軟。一般螢幕使用標準 256px 圖磚。衛星圖在高解析度螢幕上用「放大一級的圖磚」換取清晰度。

## 在本機執行

需要 Node.js 20 以上。

```bash
cd /workspace/world-map
export AMAP_KEY=你的高德Web服務Key     # 或複製 .env.example 成 .env
npm start                              # http://127.0.0.1:8787
```

注意：手機定位（以及 iPhone 上開啟 App）需要 https；用 `127.0.0.1` 在電腦上測試時定位可用，用區域網路 IP 從手機打開時定位會被瀏覽器拒絕。

### 測試與驗證
```bash
npm test                   # 單元測試：座標轉換、參數驗證、回應轉換、API 處理器、限流、導航連結
npm run check:api          # 用真實查詢呼叫本機 /api（伺服器需先啟動）
npm run check:tiles        # 檢查所有圖磚網址回 200 圖片
npm run check:secrets      # 檢查金鑰沒有外洩（可加網址：node scripts/check-secrets.mjs https://…）
npm run screenshots        # 無頭 Chrome 截圖（iPhone 390×844@3x、桌機 1440×900）→ screenshots/
```

## 臨時公開網址（Cloudflare quick tunnel，不需帳號）

```bash
./start-tunnel.sh          # 重新啟動伺服器＋通道，印出 https://xxxx.trycloudflare.com
./start-tunnel.sh status   # 看 PID 與網址
./start-tunnel.sh stop     # 全部停止
```
- 伺服器只綁 `127.0.0.1:8787`，外部只能透過通道進入。伺服器日誌在 `.run/server.log`，通道日誌在 `tunnel.log`。
- 每次重新啟動網址都會變；Cloudflare 對 quick tunnel 不保證穩定與速度，只適合試用。
- cloudflared 需要能對外連到 Cloudflare 的 **7844 埠**；有些網路（包括目前這台開發機）會擋，這時腳本會明確報錯並保留本機伺服器。
- 想要固定網址：改用下面的正式部署，或用 Cloudflare 帳號建立「具名通道」。

## 正式部署選項

兩種都不需要改程式碼，只要設定 `AMAP_KEY`。

### A. Vercel
- 需要：Vercel 帳號（可用 GitHub 登入）、把這個資料夾放到 GitHub（或用 Vercel CLI 上傳）。
- 步驟：匯入專案 → Settings → Environment Variables 加 `AMAP_KEY`（以及建議的 `ALLOWED_ORIGINS=https://你的網域`）→ Deploy。
- `vercel.json` 已設定：`public/` 為靜態網站、`api/*.js` 為 Serverless Functions、安全標頭。
- 注意：Vercel Functions 是多個短暫執行個體，記憶體內的限流只是「盡力而為」；要嚴格限流需另加 Vercel KV／Upstash。
- 免費方案（Hobby）限個人非商業使用。

### B. Cloudflare Workers（建議）
- 需要：Cloudflare 帳號（免費方案即可）。
- 步驟：
  ```bash
  npx wrangler login
  npx wrangler secret put AMAP_KEY       # 互動輸入，不會出現在檔案裡
  npx wrangler deploy
  ```
- `wrangler.toml` 已設定：靜態檔由 Workers Assets 提供、`/api/*` 先進 Worker。
- 可綁自己的網域；免費方案每天 10 萬次請求。限流同樣是單一執行個體記憶體內的（可再加 Cloudflare 的 Rate Limiting 規則）。

### 包成 App（之後）
前端是純靜態檔，可以直接用 Capacitor 之類工具包成 iOS App，`/api` 指向上面任一部署網址即可。屆時定位改用原生 API，開啟高德 App 需要在 `Info.plist` 的 `LSApplicationQueriesSchemes` 加 `iosamap`。

## 限制與已知問題
- 高清模式的文字標註是 256px 圖層放大顯示，比底圖略軟（見上方「高清圖磚」）。
- Apple 地圖不支援途經點，只會導航到終點；高德網頁版只帶第 1 個途經點（高德 App 帶全部）。
- 導航 App 會自己重新規劃，路線和過路費可能和這裡略有差異。過路費是高德估算值（小客車）。
- iPhone 上「沒裝高德 App 就改開網頁」是用 1.6 秒計時判斷，少數情況 Safari 會先跳出「無法開啟網址」提示。
- 高德 Web 服務個人開發者每日配額有限，超過時介面會顯示「今天的查詢次數已達上限」。
- 圖磚直接從高德伺服器載入（不經過我們的伺服器），屬於高德網頁地圖的公開圖磚，非正式授權的 API；高德若改網址需更新 `public/js/lib/layers.js`。
- 尚未包含：中石化加油站、服務區、天氣、油費估算、收藏。程式已預留：後端在 `core/handlers.js` 的 `ROUTES` 加新端點，前端在 `public/js/lib/api.js` 加函式、`app.js` 加新的面板即可。
