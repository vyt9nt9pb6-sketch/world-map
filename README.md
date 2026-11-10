# World Map v5

**線上版（固定網址）：https://world-map.kwok-worldmap.workers.dev**

給長途自駕用的網頁地圖：高德高清底圖、搜尋、駕車路線（含過路費）、一鍵交給高德地圖／Apple 地圖導航。
手機（iPhone Safari）優先，桌機也能用；之後可以包成 App。

## v5（熱力圖：人口密度、即時路況、我的足跡）

圖層面板「熱力」區新增三個開關，跟既有的標準／衛星／地形／大眾運輸底圖一起用（可以疊在任何底圖上）。介面仍是 Liquid Glass，圖例放在面板裡，地圖左下也有一小條（不用再疊一層模糊，避免 iPhone 掉幀）。

### A. 人口密度（公開、2020 靜態估計）

**採用 Chen et al. 2024 第七次人口普查 100 m 網格，不是 WorldPop／GHSL。** 資料在 figshare 公開，授權是 **CC BY 4.0**（API 回傳 `license.name = CC BY 4.0`，不是「只寫 freely available」）。檔案 `PopSE_China2020_100m.rar`（約 126 MB，MD5 `f020e67062b6368672428a891b07e84e`）可下載，所以沒有改用備援資料。

- 論文：<https://essd.copernicus.org/articles/16/3705/2024/>
- 資料：<https://doi.org/10.6084/m9.figshare.24916140>
- 請這樣引用：Chen, Yuehong; Xu, Congcong; Ge, Yong; Zhang, Xiaoxiang; Zhou, Ya'nan (2024). A 100-m gridded population dataset of China’s seventh census using ensemble learning and geospatial big data. figshare. Dataset. https://doi.org/10.6084/m9.figshare.24916140.v1

原始檔是 Albers／Krasovsky、每格人數（100×100 m，NoData 32767）。整張拿去 `gdalwarp` 會一次吃掉數 GB，所以 `scripts/build-pop-tiles.py` 逐列把人數加進 WGS-84 網格（全國約 **13.92 億人**，與七普大陸人口同一量級；港澳台不在這份網格裡），編成 `log2×14` 的 uint8。畫面依縮放換解析度，只載入目前視野裡的圖磚：

| 縮放 | 檔案 | 格子 | 放在哪 |
| --- | --- | --- | --- |
| 小（全國） | `c.bin.gz` | 約 4 公里（0.04°） | Worker 靜態檔 |
| 城市（沒上傳細圖磚時） | `b.bin.gz` | 約 2 公里（0.02°） | Worker 靜態檔 |
| 城市放大 | `m/` | 約 1 公里（0.01°） | R2 `WM_POP`（`world-map-pop`） |
| 再放大 | `f/` | 約 500 公尺（0.005°） | R2 `WM_POP`（`world-map-pop`） |
| 最大 | `n/` | 約 100 公尺（0.001°） | R2 `WM_POP`（`world-map-pop`） |

舊的單檔 `china2020.bin.gz`（0.02°）已拿掉。熱力半徑與透明度跟縮放一起變，放大時格子較清楚，不會一直是一大團。這是 2020 年的靜態估計，**不是即時人流**。

座標：網格是 WGS-84。高德底圖在中國境內是 GCJ-02，每個人口格子先轉成 GCJ 再畫；`outOfChina` 為真時轉換是恆等。原始投影沒有 TOWGS84 參數，角座標直接當成 WGS-84，誤差大約幾十公尺，在 100 公尺這一級才看得到。某一級圖磚還沒載入、或 R2 沒有那一級時，會改畫已經載入的較粗一級，不會把空洞畫成海。

圖層面板在手機上最高不超過可視高度（`100dvh` 扣掉瀏海與底部安全區），內容在面板裡捲動（`overflow-y: auto`、`-webkit-overflow-scrolling: touch`），背後的地圖不會跟著捲。橫向約 390 像素寬時也一樣。

圖例單位是 **人/km²**（1、10、50、200、500、1千、5千、2萬+），有透明度滑桿，面板與地圖上都有「2020 靜態估計」與來源。

重製資料（不需把 126 MB 的 rar 放進 git；`f/` 與 `n/` 已在 `.gitignore`）：

```bash
# 官方 unrar 解出 PopSE_China2020_100m.tif 之後
python3 scripts/build-pop-tiles.py /path/to/PopSE_China2020_100m.tif
```

### B. 即時路況（公開）

圖層開關「即時路況」使用高德 JS API 2.0 的 `AMap.TileLayer.Traffic`，`autoRefresh: true`、`interval: 180`（約每 3 分鐘）。圖例：暢通／緩行／擁堵／嚴重擁堵（顏色對齊高德路況圖磚）。沿用已經設定的 `AMAP_JS_KEY`，沒有新的金鑰。路況圖磚仍由瀏覽器直連高德。

### C. 我的足跡（私人）

登入後才看得到、才記得到。位置存在既有的 `WM_KV`，鍵是 `fp:{uid}`（uid 是 session 裡的 HMAC，請求不能指定別人）。`GET/POST/DELETE /api/footprint` 都要有效 session；寫入與刪除還要同源。回應 `cache-control: no-store`，不含 email、不含 uid。沒有「列出所有人」的路由，帶 `?uid=` 也不會換成別人。

- **記錄足跡**預設關閉。打開之後，只用頁面在前景時的 `watchPosition`（移動約 40 公尺或停留滿 30 秒記一筆）。**網頁關掉、或分頁在背景，瀏覽器就不會繼續定位**——這不是 App，做不到背景追蹤。
- 時間範圍：今天／7 天／30 天／全部。熱力用 `AMap.HeatMap`，座標先轉 GCJ-02（境外不轉）；顏色越熱代表在那附近被記到越多次。半徑跟著縮放，大約對應地面 80 公尺（像素半徑限制在 8–16），縮小看時透明度也降低，不會蓋住整條街。
- **清除我的足跡**會刪掉這個帳號在 KV 裡的全部點，不能還原。
- 未登入時開關只顯示「請登入」，不會向伺服器要資料，也不會開定位。
- 每人最多 3000 點、一次最多 40 點、每小時最多 180 次寫入。幾乎同一點的 GPS 抖動（15 秒內、20 公尺內）不會另存。

### 部署與 Kwok 要設定的東西

足跡用原本的 `WM_KV`。路況與足跡熱力用原本的 `AMAP_JS_KEY`／`AMAP_JS_SECURITY_CODE`。人口密度：縮小看是約 4 公里（`c.bin.gz`），城市在細圖磚還沒載入時是約 2 公里（`b.bin.gz`，跟網站一起部署）。放大到約 1 公里（`m/`）、500 公尺（`f/`）、100 公尺（`n/`）時，手機只抓畫面裡的幾塊。這三級沒有打包進 Worker。正式環境的 R2 bucket `world-map-pop` 已放全部 1,491 塊，Worker 綁定是 `WM_POP`。沒有這塊圖磚時會退回已載入的較粗一級。

物件鍵是 `data/pop/m/….bin.gz`、`data/pop/f/….bin.gz`、`data/pop/n/….bin.gz`（內容是 gzip，`content-type` 用 `application/gzip`）。重傳圖磚：

```bash
sh scripts/upload-pop-native.sh world-map-pop
```

`scripts/deploy-cloudflare.mjs` 產生的部署檔會帶上 `{ type: 'r2_bucket', name: 'WM_POP', bucket_name: 'world-map-pop' }`，`keep_bindings` 也含 `r2_bucket`。之後重新部署不會拿掉 `WM_POP`。

重新部署時仍要帶著 KV，否則登入與足跡會一起被拿掉：

```bash
CF_KV_NAMESPACE_ID=<KV id> node scripts/deploy-cloudflare.mjs
```

Vercel 沒有 KV，跟收藏一樣：人口密度與路況可以用，足跡登入不能用。

### v5 測試與截圖

`npm test`（含 `tests/v5-population.test.js`、`tests/v5-footprint.test.js`、`tests/v5-frontend.test.js`）。截圖：`node scripts/screenshots-v5.mjs`（本機靜態檔＋線上 `/api`；足跡在截圖腳本裡模擬登入，不會寫進正式 KV）→ `screenshots/v5-*.png`。

**iPhone 若熱力開關點了沒反應：** Safari 會把 `/js/app.js` 快取一小時（`max-age=3600`），HTML 卻是 `no-cache`。部署後會出現「新的頁面、舊的程式」：三個開關畫得出來，但舊程式沒有監聽，點下去開關不會動。Worker 現在會在 HTML 裡把 `app.js`／CSS 加上 `?v=<etag>`，網址變了就不能沿用舊快取；JS／CSS 本身也改成 `no-cache`。修正部署之後，重新打開或下拉重新整理一次即可，不必清除網站資料。

## v4（Liquid Glass、圖層網格、地點頁、多路線）

### 變更摘要
- **圖層選擇器**：2×2 網格（標準／衛星／地形／大眾運輸），縮圖是自繪 SVG（`public/img/layer-*.svg`，無第三方素材）。衛星來源子選項（高德／天地圖／Mapbox／Google）整理在同一張卡片。
- **地形**：有設定 `GOOGLE_MAPS_TILE_KEY` 且瀏覽器連得到 Google（`reach.js` 探測，2.5 秒逾時、快取 60 秒；大陸需開 VPN）時用 Google Map Tiles API 地形；否則退回天地圖 `ter_w`。
- **衛星白色 3D 樓塊**：見下方根因，已修並有測試（`tests/v4-map.test.js`）。標準圖層仍保留 3D 樓塊。
- **搜尋附近**：圖示縮小；搜尋結果旁會主動出現「搜尋附近・跟著地圖更新」；附近結果會隨地圖拖曳／縮放自動更新（600 ms debounce、最短間隔 1.5 秒、中心移動超過半徑 25% 或縮放 ≥0.5 級才重查、40 筆快取、程式移動地圖後 2.2 秒內不查），並有「搜尋此區域」按鈕。
- **地點頁（仿 Apple 地圖）**：名稱、類別、距離、地址、電話（點擊撥號）、營業時間、評分／人均、照片，按鈕：路線／電話／收藏／分享。資料來自高德 `/v5/place/detail?show_fields=business,photos`（`/api/place`）。
- **導航**：駕車一次回傳最多 3 條路線（高德 v3 strategy 11：最快／最短距離／避擁堵，再合併 v5 結果），每張卡片有時間、距離、過路費、紅綠燈、直線距離與繞行倍率；地圖上每條路線有標籤，點標籤或卡片即可切換；上方快捷「最快／最短距離／少收費」。選項：現在出發／設定出發時間、避開高速公路、避開收費站（記在 `localStorage: wm.routeopts.v4`）。
- **Liquid Glass UI**：只用自己的 CSS（`public/css/glass.css`）：背景模糊＋飽和、高光邊緣、浮動膠囊控制、動態染色（衛星圖時調亮藍色）、`linear()` 彈簧動畫（不支援時退回 cubic-bezier）、深色模式。`backdrop-filter` 只用在面板、控制鈕、彈窗、區域按鈕與 toast；內部卡片只用半透明填色，以保 iPhone Safari 效能。

### 衛星白色樓塊的根因
高德 JS 2.0 的 `showBuildingBlock` **只在建構地圖時生效**。建構子預設值是 `true`，會建立核心的 `AMap.Buildings` 圖層；之後呼叫 `setFeatures`／`setStatus` 在 3D 模式都無法把它移除。v3 是建構後才設定，所以衛星圖上仍有白色擠出樓塊。修法（`public/js/lib/amap-map.js`）：建構時就傳 `showBuildingBlock:false`（衛星／地形），切回標準圖層才重建並開啟。

### 駕車出發時間的限制（誠實說明）
高德「駕車未來出發時間預測」（`/v4/etd/driving`）只對企業帳號開放，個人 Key 打不到，所以：**駕車**「設定出發時間」只顯示「出發時間＋即時路況耗時」推算的抵達時間，不是預測路況（畫面上有說明，`depart.supported=false`）；**公交／鐵路**則是真正帶 `date`/`time` 查詢。「避開高速公路」仍可能走高架快速路（高德把高架算在一般道路）；「避開收費站」若找不到免費路線會回 `tollNote=no_toll_free`。

### 一步一步：Cloudflare、Google Cloud、Mapbox 設定

**1. Cloudflare（Worker `world-map`）**
1. 登入 https://dash.cloudflare.com → Workers & Pages → `world-map` → Settings → Variables and Secrets。
2. 新增 Secret（類型選 Secret，不是 Text）：`AMAP_KEY`（高德 Web 服務 Key）、`AMAP_JS_KEY`、`AMAP_JS_SECURITY_CODE`，以及需要的 `TIANDITU_TK`、`MAPBOX_TOKEN`、`GOOGLE_MAPS_TILE_KEY`。設定後不需要重新部署。
3. KV：Storage & Databases → KV → Create，建立後在 Worker → Settings → Bindings 綁成 `WM_KV`。
4. 重新部署時**必須保留綁定**：`CF_KV_NAMESPACE_ID=<KV id> node scripts/deploy-cloudflare.mjs`，再執行產生的 `.run/cf-deploy.js`。漏了 KV id 會讓 `WM_KV` 被拿掉。`WM_POP`（R2 bucket `world-map-pop`）寫在部署檔裡，也在 `keep_bindings` 的 `r2_bucket`，不會被拿掉。

**2. Google Cloud — Map Tiles API 金鑰（地形用）**
1. 開 https://console.cloud.google.com ，建立或選一個專案，並綁定帳單帳戶（Map Tiles 需要，有免費額度）。
2. APIs & Services → Library → 搜尋 **Map Tiles API** → Enable。
3. APIs & Services → Credentials → Create credentials → API key。
4. 編輯該 Key：Application restrictions 選 **Websites**，加入 `https://world-map.kwok-worldmap.workers.dev/*`；API restrictions 選 Restrict key → 只勾 **Map Tiles API**。
5. 在 Cloudflare 新增 Secret `GOOGLE_MAPS_TILE_KEY`。這是瀏覽器端金鑰，前端會看得到，保護靠網域限制。
6. 在大陸要開 VPN 才連得到 Google；連不到時會自動退回天地圖地形。到 Billing → Budgets 設個預算提醒。

**3. Mapbox（衛星子選項）**
1. 註冊 https://account.mapbox.com → Tokens → Create a token，權限只留 public scopes（`styles:read`、`tiles:read` 等預設即可）。
2. URL restrictions 填 `https://world-map.kwok-worldmap.workers.dev`。
3. 在 Cloudflare 新增 Secret `MAPBOX_TOKEN`。大陸同樣需要 VPN。

### v4 授權
Liquid Glass 全部是自寫 CSS／SVG，沒有複製任何第三方程式碼；`backdrop-filter:url(#svg)` 折射效果只有 Chromium 支援，Safari 用模糊＋高光替代。

### v4 測試
`npm test`（146 項）；截圖：`node scripts/screenshots-v4.mjs`（Playwright＋SwiftShader，輸出 `screenshots/v4-*.png`）。標準圖層的 3D 向量底圖在 SwiftShader 下會是空白，無法在開發機驗證樓塊擠出，要在真機看。

---

## v3（Apple 地圖風格改版）

### 變更摘要
- **介面**：底部面板（搜尋列在最下面，可拖到 peek／半高／全高）、右上浮動圓形按鈕（圖層、2D/3D、定位、指北針）、左下比例尺、人像按鈕（我的：帳號＋收藏）、支援深色模式。
- **搜尋**：搜尋記錄與「搜尋附近」（廁所／加油站／充電站）都在搜尋面板裡；螢幕最上面不再有 chips。
- **點地圖選地點**（類似 Apple 地圖）：點一下 → `/api/regeo`（伺服器端呼叫高德逆地理編碼）→ 顯示最近的 POI／建築名稱、地址、電話；長按同樣可選點。
- **路線**：主畫面沒有路線入口，只能從地點卡的「路線」進入；公交／火車新增「鐵路優先」。
- **圖層**：標準／衛星／大眾運輸三張卡；3D 與標準、衛星融合（2D/3D 按鈕＝地圖傾斜）；衛星可選高德或天地圖。
- **海拔／氣壓**（估計值）：見下節。
- **全球圖層**（圖層面板下方「全球」區）：① 天地圖全球衛星（img_w＋cia_w 地名，中國境內平移對齊高德、境外不平移）；② 全球地表覆蓋（ESA WorldCover 2021，10 m，11 類，附圖例與來源標示）。研究與取捨見「全球衛星與地表覆蓋」。
- 地圖引擎從 Leaflet 換成高德 JS API 2.0（單一地圖，傾斜＝3D）；`/3d.html` 只保留為轉址到 `/?view=3d`。

### 海拔／氣壓提供者介面（給日後原生 App）
`public/js/lib/env-provider.js`。每個提供者長這樣：

```js
{ source: 'sensor' | 'gps' | 'api',
  getAltitude(ctx) -> { value /*公尺*/, accuracy?, label } | null,
  getPressure(ctx) -> { value /*hPa*/, seaLevel?, label, time? } | null }
```
- 優先順序 `sensor > gps > api`，前一個回傳 null 或丟錯就換下一個；統一結果 `{kind, value, unit, source, estimate, label, ...}`，只有 `source:'sensor'` 的 `estimate` 是 false，其他一律在畫面上標「估計」。
- 目前內建：`gps`（`position.coords.altitude`，手機有回報才有；很多 iPhone 網頁拿到的是 null）、`api`（`/api/environment`，Open-Meteo：Copernicus 90 m 地形高程＋氣象模型地面氣壓）。
- **網頁讀不到 iPhone 的氣壓計。** 原生 App（Swift）用 `CMAltimeter`（`relativeAltitude` + `pressure`，單位 kPa，需換成 hPa ×10）時，在 WebView 注入：

```js
window.WorldMapEnv.registerProvider({
  source: 'sensor',
  getPressure: async () => ({ value: nativePressureHpa, label: 'iPhone 氣壓計' }),
  getAltitude: async () => ({ value: nativeRelativeOrAbsoluteAltitude, label: 'iPhone 氣壓計（相對高度需自行校正）' }),
});
```
  不用改任何前端 UI；原生端也可直接 import `env-provider.js` 的 `createEnvService`。注意 `CMAltimeter` 只給「相對高度變化」，絕對海拔仍需 GPS 或地形資料校正。
- Open-Meteo：免費版僅限非商用，要標示 CC BY 4.0 並有頻率限制；若商用需買授權。

### 鐵路優先
高德 v5 公交策略 0–8 沒有「鐵路／火車優先」（7 只是地鐵優先）。做法：伺服器用「推薦／最快／少換乘」三種策略各查一次、去重，含火車段的方案排前面（火車佔距離比例高者優先）。代價：每次搜尋用掉 3 次高德配額；找不到含火車的方案時畫面會照實說明，不會假裝有。

### 開源參考與授權（寫程式前的調查）
- 底部面板（bottom sheet）：參考 MIT 授權的現成元件的設計（停靠點、慣性投射、拖曳區），但**沒有複製任何程式碼，也沒有引入第三方 UI 依賴**；`sheet.js` 為自行撰寫（含單元測試）。
- 比例尺：Web Mercator 公式 `156543.03392·cos(lat)/2^z`，取 1／2／5×10ⁿ 為刻度。
- 點地圖選地點：高德逆地理編碼＋POI 半徑搜尋（Apple 地圖／Google 地圖的標準做法）。
- 資料授權：OSM ODbL（鐵路）、Open-Meteo CC BY 4.0（氣象）、高德地圖須保留 Logo 與版權（已移到左上，沒有隱藏）。

### 全球衛星與地表覆蓋（寫程式前的調查）
**GlobeLand30（國家基礎地理信息中心）——不採用。** 官方入口 globeland30.org 只提供「註冊＋申請＋下載」，天地圖公開的 WMTS 只有矢量／影像／地形／注記／全球境界（`vec/img/ter/cva/cia/cta/ibo`），**沒有地表覆蓋圖層**，也沒有公開的圖磚服務與使用條款；網路上流傳的 WMS（網站內部 IP `218.244.250.80` 的 erdas-apollo）是未公開文件的內部服務，NGCC 網站頁尾還註明「未經許可不得複製、鏡像」。所以**這個子項目照規則停下**，沒有硬抓。若要用 GlobeLand30，需向 NGCC（glc@ngcc.cn）申請書面授權或下載資料自行切片，這要由 Kwok 決定。

**改用 ESA WorldCover 2021 v200（採用）。** CC BY 4.0（免費、不限用途，須標示 `© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium`）。圖磚：Terrascope（VITO，比利時）的 MapProxy WMTS REST，`https://mapproxy.terrascope.be/mapproxy/wmts/esa-worldcover-map-10m-2021-v2_map/webmercator/{z}/{x}/{y}.png`（Web Mercator、z0–19、回應 `access-control-allow-origin: *`、`max-age` 3 天）。官方色碼取自 WorldCover PUM v2.0 表 3（11 類）。不經我們伺服器代理、不快取、不鏡像。
- 海外開發機實測可連（HTTP 200，約 1 秒）；**這台機器在海外，無法證明大陸可連**——Terrascope 是歐洲伺服器、沒有 Google 那種封鎖，但可能較慢，需 Kwok 用大陸手機實測。若大陸連不到：替代方案是把 WorldCover 切成自己的圖磚放 R2／國內 CDN（CC BY 允許），或改用 NASA GIBS MODIS 500 m（公有領域，同樣在海外）。

**天地圖全球衛星。** 天地圖 `img_w`＋`cia_w` 本來就是全球覆蓋（Web Mercator，z1–18）；但**境外只有約 500 m 解析度的衛星影像**（高解析度只在中國境內：15 m／2.5 m／城市 0.6 m）。所以境外 z≈9 以上會變模糊——這是資料本身的限制，不是程式。

**座標處理（GCJ-02 只在中國境內）。** 高德圖面在中國是 GCJ-02、境外等於 WGS-84；天地圖與 WorldCover 圖磚是 WGS-84。`createShiftedFlexible`（`public/js/lib/tianditu.js`）對每個高德圖磚用「圖磚中心」做一次 GCJ→WGS 轉換，去抓對應的 WGS 圖磚並平移後畫在 canvas 上；框外（`outOfChina`）轉換為恆等式，所以只取同一張圖磚、不平移（有單元測試：連雲港需平移；巴黎、紐約、雪梨不平移）。已知限制：用的是矩形判斷（香港／澳門／台灣在框內，會被當成中國平移，可能與高德在當地的實際資料有差異）；框邊界的圖磚會有最多一塊圖磚寬的接縫。

**開源參考（只參考做法，沒複製程式碼）：** [htoooth/Leaflet.ChineseTmsProviders](https://github.com/htoooth/Leaflet.ChineseTmsProviders)（MIT；提供天地圖／高德圖磚網址，**不處理偏移**，issue #43「切換底圖，座標偏差」就是這個問題）；[gisarmory/Leaflet.InternetMapCorrection](https://github.com/gisarmory/Leaflet.InternetMapCorrection)（以重算每張圖磚位置來糾偏，與我們的做法同原理；**倉庫沒有明確授權檔案，所以沒有複製任何程式碼**，也有自己的免責聲明）；糾偏演算法為公開演算法（`coords.js` 自行實作）。WorldCover 疊加層的做法（WMTS＋半透明＋圖例）是 ESA 官方文件與 Leaflet/MapLibre 常見用法。


### 中國大陸連線診斷（workers.dev 逾時／打不開）— 2026-10-31

**根因（已查證）：`*.workers.dev` 在中國大陸被全面封鎖。** [GreatFire](https://en.greatfire.org/domain/workers.dev) 截至 2026-10-30 對 workers.dev 下可判定的 URL 全部標記為 Blocked（DNS 污染、連線逾時／靜默丟包、連線失敗）。Cloudflare 社群與多個開源專案（例如 WPILib #8467）也確認「不能用 workers.dev 給大陸用戶用，必須掛自訂網域」。因此目前 `https://world-map.kwok-worldmap.workers.dev` **不是「慢」，是網域本身進不了大陸網路**；本機（海外）無法代替大陸探測，請 Kwok 用大陸手機／[ITDOG](https://www.itdog.cn/)／[GreatFire](https://en.greatfire.org/) 驗證。

**已檢查、與「逾時」無關或幫助有限的項目：**
- 高德 JS 已從中國端點 `https://webapi.amap.com` 載入（不是海外 CDN）。
- `/_AMapService` 只代理 JS API 的安全密鑰相關請求（樣式／log／部分 Web 服務），圖磚仍直連 `*.amap.com`；會多一跳但不是打不開的主因。
- Worker 靜態打包約 400 KB；Cloudflare 會 gzip。減 JS 有幫助但是次要。
- 帳號下 **沒有任何 Cloudflare Zone／自訂網域**（查過 zones／workers domains 皆空），所以目前沒有可切換的備用 hostname。

**可行方案（需要 Kwok 決定；未代購網域）：**

| 方案 | 大陸可達？ | 費用（約） | 說明 |
|---|---|---|---|
| **A. 自訂網域綁 Worker**（建議） | 通常可（視 CF 節點／ISP） | `.com` 約 **US$10–15／年**（Cloudflare Registrar／Namecheap 等）；`.cn` 約 **¥30–55／年** 且若要在大陸「備案託管」需 ICP（數週～數月） | 把域名 NS 轉到 Cloudflare → Workers → Custom Domains 綁 `world-map`。**不買 Cloudflare China Network 也能試**；若部分省市仍慢／被牆，再考慮「優選 IP／CNAME 到優選域名、關小黃雲」等社群做法。 |
| B. 靜態資源鏡到國內 CDN | 只能加速 HTML／JS；API 仍在 Worker | 國內 CDN 另計；源站仍要可連 | 治標不治本：首屏或許快，但 `/api/*` 若仍走被牆的 workers.dev 一樣失敗。 |
| C. 國內主機／反向代理反代 Worker | 可以 | VPS 約 ¥30+/月 | 用國內 IP 反代到 Worker；要自己維護證書與合規。 |
| D. Cloudflare China Network | 較穩 | 企業級，貴，且通常要 ICP | 不建議個人專案起步就上。 |

**沒有「免買網域」的可靠解法。** freenom 等免費域名在大陸同樣不穩／常被牆。若 Kwok **已經有** `.com`／`.cn`／其他域名，把域名加進這個 Cloudflare 帳號並綁 Custom Domain 即可，**不必新買**。綁定後還要在高德／天地圖控制台把新網域加入 key 白名單。

**請 Kwok 回覆：** (1) 是否已有可綁的域名（名稱）？(2) 若沒有，要不要買 `.com`（建議）？確認前 **不會代購**。

### Mapbox／Google 衛星與地形圖（寫程式前的調查）

- **Mapbox：** 官方 Raster Tiles `https://api.mapbox.com/v4/mapbox.satellite/{z}/{x}/{y}@2x.jpg?access_token=`（satellite-v9／mapbox.satellite）。瀏覽器型 token；大陸常需 VPN。Secret 名：**`MAPBOX_TOKEN`**。
- **Google：** 官方 [Map Tiles API](https://developers.google.com/maps/documentation/tile/satellite) ——先 `POST …/createSession`（mapType=satellite）再 `GET …/2dtiles/{z}/{x}/{y}?session=&key=`。createSession 走同源 `/api/google-tiles/session` 避免瀏覽器 CORS；圖磚仍客戶端直連。Secret 名：**`GOOGLE_MAPS_TILE_KEY`**。未設定時功能旗標為 false。大陸常需 VPN。
- **地形：** 天地圖官方 `ter_w`（暈渲）＋`cta_w`（注記），與現有 `TIANDITU_TK` 共用；開源參考 [htoooth/Leaflet.ChineseTmsProviders](https://github.com/htoooth/Leaflet.ChineseTmsProviders)（MIT，只參考 URL 格式，未複製程式碼）。
- 座標：Mapbox／Google／天地圖地形皆 WGS-84，沿用 `createShiftedFlexible` 只在中國境內平移。

### 高德 Logo

高德開放平台 FAQ／服務協議明確：**不得刪除、遮擋、隱藏、修改或替換**「高德地圖」Logo 與審圖號。因此 **沒有移除**，只做縮小＋降低對比（仍可見）。

### 衛星 3D 樓塊

高德 `showBuildingBlock`／`features` 含 `building` 時，衛星圖上會疊白色擠出樓塊。做法：衛星／天地圖衛星／地形模式下 `setFeatures(['bg'])` 並嘗試關閉 building block；**標準圖層保留 3D 樓塊**；俯仰（pitch）仍可用（Apple Maps 風格）。

### v4.1（2026-10-31）：大眾運輸圖層、鍵盤與圖層選單
**1. 大眾運輸圖層改成「城市軌道」。** 只畫地鐵、輕軌、單軌與磁浮，依各線官方顏色上色，有車站圓點（轉乘站黑框）與站名；不再畫全國國鐵／高鐵線（路線結果裡的火車段名稱沿用原本的鐵路資料，不受影響）。
- 寫程式前先調查（先搜現成開源專案、看授權）：
  - 高德 JS API 2.0 沒有地鐵圖層；「地鐵圖」JS API 是示意圖（非地理座標）且要購買授權 → 不用。
  - subway.amap.com 的 JSON 是高德專有資料，沒有再利用授權 → 不用（也不該爬）。
  - OpenRailwayMap 圖磚：使用條款禁止大量／自動化存取，且畫的是所有鐵路 → 不用。
  - GitHub 上的地鐵資料集（CPTOND、AmapMetro、luxueyan、foglet/transit 等）授權不明或已過期 → 只借鑑做法，不抄資料。
  - **採用 OpenStreetMap（ODbL 1.0）：** OSM 的 `route=subway｜light_rail｜monorail`（磁浮在 OSM 多為 monorail，另加名稱含「磁浮」的 `route=train`）關係，經 Overpass 取得，許可證明確（要標示 © OpenStreetMap contributors，已放在面板與圖層說明）。
- 做法：`node scripts/build-metro-lines.mjs`（Overpass，快取在 `.run/metro-cache`）→ 依「網路＋線路 ref」合併兩個方向、串成長折線、Douglas-Peucker 簡化（8 m）、轉 GCJ-02（與高德底圖對齊）、站點只留離線路 150 m 內的 → 依 2° 地理格子切成 gzip 小檔 `public/data/metro/*.json.gz`（49 格、428 條線、約 8 千站，**合計約 350 KB**）。網頁只抓畫面附近的格子，用 `DecompressionStream` 解壓（iOS Safari 16.4+）。
- 靜態資料隨 Worker 一起部署：**不依賴任何第三方執行期服務**，在中國大陸用 VPN 打開 workers.dev 一樣能用（Overpass 只在建置時用）。
- 已知限制：OSM 完整度因城市而異；少數線路沒有 colour 標籤時用固定色盤；站名是 OSM 的 name（大陸多為簡體）；要更新資料就重跑建置腳本。

**2. 搜尋框被鍵盤頂出螢幕。** 原因：iOS Safari 開鍵盤時「版面視口」（`innerHeight`）不縮，只有「視覺視口」縮小並被捲動；全高的固定面板貼在版面視口底部，頂端就跑出螢幕上方。修法：用 `window.visualViewport`（`resize`／`scroll`）計算鍵盤高度 → CSS 變數 `--vv-bottom`，鍵盤開啟時面板貼在鍵盤上方、高度不超過可見區（`body.kb-open`），並把被捲動的頁面捲回 0；輸入框字級 17px（≥16px，Safari 不會自動放大）。`scripts/e2e-keyboard.mjs` 以 iPhone 尺寸偽造 visualViewport（含「Safari 把頁面捲 120px」的情況）驗證搜尋框一直在可見範圍；**真機的鍵盤只能在 iPhone 上最終確認**。

**3. 圖層選單縮小。** 2×2 大卡片改成緊湊的橫排小卡（縮圖 64×46、整組 ≈124px，原本 ≈400px），選項列與間距也縮小；衛星模式（選項最多）在 iPhone 12/13 高度（844px）也能全部露出、不必捲動。

### v4.2（2026-11-07）：油費／電費估算、天氣（地點＋抵達時）

**1. 油費／電費估算（駕車）。** 路線卡片的「過路費」旁顯示油費（電車顯示電費），並加一行「合計約 ¥xxx（油費＋過路費，估算）」；「路線選項」新增「能耗估算」區：油車／電車切換＋百公里能耗＋單價，存在 `localStorage: wm.fuel.v42`（切換車種時帶入該車種的參考預設）。
- 計算是線性公式：費用＝距離 ÷ 100 × 能耗 × 單價。實際油耗隨路況（高速／市區）、氣溫（空調）而不同，畫面照實標「估算」。
- 誠實說明：**油價／電價因地區與時間而異，預設值只是參考**（油車 8 L/100km・¥7.5/L；電車 14 kWh/100km・¥1.2/kWh）。沒有接任何油價 API（查不到穩定、可免費再利用的油價資料源），請改成自己車子的實際數字再規劃。高德回傳的過路費本身也是估算值（小客車）。

**2. 天氣（Open-Meteo，CC BY 4.0）。**
- 地點頁：現在天氣（溫度、體感、濕度、風、降水）＋未來 3 天（高／低溫、降水機率、天氣描述）。
- 駕車路線：以「現在（或設定的出發時間）＋行駛時間」算預計抵達時刻，從每小時預報取該時刻天氣，顯示「抵達時約 13°C 🌦️ 小雨・降水機率 40%」（降水機率 ≥30% 才顯示）。切換路線卡片會跟著更新。
- 新端點 **`/api/weather`**：後端代理 Open-Meteo（與海拔／氣壓同一來源；瀏覽器不直連 api.open-meteo.com，CSP 維持 `connect-src 'self'`）。一次回 current＋未來 7 天＋48 小時，座標四捨五入到 0.01°（約 1 公里，提高快取命中）、回應 `public, max-age=600`、所有數值清洗成有限數（上游 null／NaN 一律輸出 null）。不需要任何金鑰。
- 天氣代碼是 WMO 官方 code → 自建 emoji＋繁中對照表（`public/js/lib/weather.js`）。時間是「地點當地時間」（Open-Meteo `timezone=auto`）：裝置時區與地點相同的常見情境沒問題；不同時「今天／明天」的判斷可能偏差幾小時，屬可接受誤差。長途自駕出發前看目的地天氣最有用，失敗時靜默不顯示（天氣是加分項）。
- 前端 GCJ-02 座標先轉 WGS-84 再查（`gcj02ToWgs84`），10 分鐘記憶體快取（最多 40 個地點）。

**3. 測試。** v4.2 新增 18 項（`tests/v42-frontend.test.js`：能耗計算、合計、偏好讀寫（含損壞 JSON 與越界夾回預設）、WMO 對照（含 null 不誤判成「晴」）、hourlyAt 最近時刻、卡片與抵達天氣 HTML；`tests/v42-backend.test.js`：端點結構、座標捨入、錯誤路徑 400/405/429/502/504、數值清洗）。全套 172 項通過。`scripts/api-smoke.mjs` 加入 /api/weather 檢查。

### 取捨與限制
- 大眾運輸圖層（v4.1）：淡化底圖＋OSM 城市地鐵／輕軌／磁浮的真實軌道幾何與車站（見 v4.1）；公車／地鐵圖層高德沒有公開圖磚。
- 天地圖與地表覆蓋現在以 `AMap.TileLayer.Flexible` 疊加（WebGL 需要未被汙染的 canvas，會先嘗試 CORS，失敗改用一般圖片載入）；開發機在海外被天地圖 WAF 擋（418），**無法在這裡驗證**，需在大陸手機實測。
- 真正的 3D（WebGL）在沒有 GPU 的開發機上會退回 2D 點陣，**只能在真機驗證**。
- 收藏不再以星號畫在地圖上（照 Kwok 的「不要出現在螢幕上」），只在「我的」清單裡；點收藏項目會在地圖上標出。

## 功能

| 功能 | 說明 |
|---|---|
| 底圖 | 高德標準地圖（GCJ-02），可切換**衛星圖**，衛星圖可開關**道路標註**。高解析度螢幕（Retina）自動使用 512px 高清圖磚。 |
| 定位 | 右下角按鈕。瀏覽器回傳 WGS-84，程式轉成 GCJ-02 再顯示（中國境外不轉換）。 |
| 搜尋 | 關鍵字搜尋地點（以地圖中心 50 公里內優先；附近找不到完全符合的名稱時改搜全國），同時做地址解析。結果有清單與地圖編號標記；點一下可設為起點／終點／途經點。長按（或桌機右鍵）地圖也能選點。 |
| 駕車路線 | 起點預設「我的位置」，可加最多 16 個途經點。顯示距離、時間、**過路費**、收費路段長度、紅綠燈數、主要道路；最多 3 條候選路線。偏好：推薦／速度優先／避免收費／高速優先／不走高速。 |
| 導航 | 「高德地圖導航」：iPhone 先開高德 App（`iosamap://path`），沒裝 App 就改開高德網頁版（`uri.amap.com/navigation`）。「Apple 地圖」：開 `maps.apple.com` 駕車導航。 |

介面文字是繁體中文；地名、道路名照高德回傳的原樣顯示（多為簡體）。

## v2 新功能

| 功能 | 說明 |
|---|---|
| 多種導航方式 | 駕車／**公交＋火車**（`/v5/direction/transit/integrated`）／步行／騎行／電動車。起點預設「我的位置」。跨城市的城市碼由後端用逆地理編碼自動取得。 |
| 火車詳情 | 每個火車段列出**所有停靠站**（高德 `via_stops`，含到發時刻與停留分鐘）、不停靠的沿線站、座位價格。**鐵路線名稱**（陇海線、连镇线、京沪高铁、沪宁城际線…）由 OSM 衍生的靜態資料集比對得出，**一律標示「推測線路」**，因為高德本身不回傳線路名稱，偶爾會與實際不同。 |
| 搜尋附近 | 廁所（200300）、加油站（010100）、充電站（011100），用 `/v5/place/around`，地圖上以 markercluster 聚合，清單依距離排序，可「在地圖中心重新搜尋」。 |
| 收藏 | 本機儲存（localStorage，並呼叫 `navigator.storage.persist()`），可匯出／匯入 JSON；若啟用寄信，可用**電子郵件驗證碼登入**，收藏存在 Workers KV，跨裝置同步（以每筆 `updatedAt` 合併，刪除以墓碑記錄 30 天）。 |
| 分享／標記我的位置 | 「標記我的位置」釘選目前位置；分享按鈕用 Web Share API，備援為簡訊（iOS `sms:&body=`、Android `sms:?body=`）與複製連結。連結為 `https://uri.amap.com/marker?position=經度,緯度&name=…`（GCJ-02，在微信／QQ／簡訊／iMessage 都能點開）。 |
| 衛星＋天地圖 | 保留高德衛星圖，新增**天地圖影像**（`img_w`，EPSG:3857；天地圖是 WGS-84，前端逐磚計算 GCJ/WGS 位移並重繪）。沒有 tk 時選項自動停用。 |
| 3D | 切換到 `/3d.html`，用高德 JS API 2.0（`viewMode:'3D'`、俯仰角、建築物）。沒有 JS Key 時選項自動停用。 |

### 需要使用者自己申請的項目（沒設定時對應功能會優雅停用）
全部設為 Cloudflare Worker 的 **Secret**（Settings → Variables and Secrets），設定後不必重新部署。

| 名稱 | 用途 | 申請與設定 |
|---|---|---|
| `TIANDITU_TK` | 天地圖影像圖層 | 到 https://console.tianditu.gov.cn 註冊並實名認證 → 應用管理 → 創建應用，類型選「瀏覽器端」→ 白名單填 `kwok-worldmap.workers.dev`。個人配額每天 1 萬次。這是瀏覽器金鑰，前端會看得到，保護靠白名單。服務條款禁止大量抓取、快取與鏡像，所以**不經代理、不快取**，圖磚由瀏覽器直連天地圖。 |
| `AMAP_JS_KEY`、`AMAP_JS_SECURITY_CODE` | 3D 模式 | 高德開放平台 → 應用管理 → 建立「Web端（JS API）」的 Key，取得**安全密鑰**；Key 的域名白名單填 `kwok-worldmap.workers.dev`。安全密鑰只放在伺服器，由 `/_AMapService/*` 代理在伺服器端附上 `jscode`；前端只拿到 Key。 |
| 寄信（見下） | 電子郵件登入 | 見下表。 |

### 寄信（驗證碼登入）
`core/mail.js` 是可抽換的寄件器，用環境變數 `MAIL_PROVIDER` 選擇：`brevo`、`resend`、`cloudflare`。沒有設定時，`/api/auth/request-code` 回 503，介面顯示「尚未啟用電子郵件登入」，其餘功能（含本機收藏）不受影響。

| 方案 | 需要 | 備註 |
|---|---|---|
| Brevo（唯一不需網域的方案） | 註冊 Brevo 帳號、建立 API Key、驗證一個寄件信箱 | 免費每天 300 封。共用寄件網域，QQ／163 可能進垃圾信。設 `MAIL_PROVIDER=brevo`、`BREVO_API_KEY`、`MAIL_FROM`（已驗證信箱）。 |
| Resend | 自己的網域（DNS 驗證） | 免費每月 3,000 封、每天 100 封。設 `MAIL_PROVIDER=resend`、`RESEND_API_KEY`、`MAIL_FROM`。 |
| Cloudflare Email Service | 網域＋Workers Paid（寄給任意收件人） | 綁定 `EMAIL`，設 `MAIL_PROVIDER=cloudflare`、`MAIL_FROM`。 |

其他設定：`MAIL_FROM_NAME`、`MAIL_DAILY_LIMIT`（全站每日寄信上限，預設 200）、`AUTH_SECRET`（選填；未設定時自動產生並存入 KV）。

安全設計：6 位數驗證碼以 HMAC 雜湊儲存、10 分鐘過期、最多試 5 次；同一信箱 60 秒冷卻與每小時 5 次、每個 IP 每小時 10 次、全站每日上限；登入後發 32 位元組隨機 session token（KV 只存 SHA-256），以 HttpOnly、SameSite=Lax cookie 傳送（30 天）；寫入類路由檢查 Origin／Referer 同源；POST 內容上限 4096 位元組。KV 計數器不是原子操作，限流是盡力而為。

### Cloudflare 部署（v2）
```bash
# 一次性：建立 KV（收藏／登入用）
#   Cloudflare 後台 → Storage & Databases → KV → Create，或 API：POST /accounts/{id}/storage/kv/namespaces
CF_KV_NAMESPACE_ID=<KV id> node scripts/deploy-cloudflare.mjs    # 產生 .run/cf-deploy.js（含 WM_KV 綁定）
# 由 Grok Bot 的 Cloudflare 連接器執行 .run/cf-deploy.js
```
部署中繼資料使用 `keep_bindings: ['secret_text','plain_text','r2_bucket']`，**不會覆蓋已存在的秘密（AMAP_KEY 等）**，也不會拿掉 R2。綁定清單另有明確的 `WM_POP` → bucket `world-map-pop`。部署後請確認綁定名稱仍在，並用 `npm run check:api -- https://world-map.kwok-worldmap.workers.dev` 驗證。
Vercel 部署不支援登入與收藏同步（沒有 KV 綁定），其他功能可用。

### 資料與授權
- v3 起不再內含 Leaflet／markercluster；地圖引擎改為高德 JS API 2.0（執行時由 webapi.amap.com 載入，非本專案內含）。
- **鐵路線資料集** `data/rail-lines.json` 來自 **OpenStreetMap**（© OpenStreetMap contributors，**ODbL 1.0**），由 `scripts/build-rail-lines.mjs` 透過 Overpass API 產生；App 內地圖與火車詳情會顯示著作權標示與授權連結。這是衍生資料庫，若再散布須以 ODbL 釋出。
- **OpenRailwayMap 為 GPL-3.0，本專案沒有複製其程式碼**；只使用 OSM 原始資料與自己撰寫的比對程式（`core/rail.js`）。
- 站序修正（`scripts/lib/rail-order.mjs`）：OSM 站點成員順序有時不沿線，以重新插入＋2-opt 修正，仍可能有少數誤差。
- 高德圖磚網址為公開網頁圖磚，非正式授權 API；天地圖依其服務條款僅限瀏覽器端直連。

## 架構

```
public/                 前端（純靜態檔，無需編譯）
  index.html  css/app.css  js/app.js
  js/lib/coords.js      WGS-84 ⇄ GCJ-02 轉換
  js/lib/amap-map.js    高德 JS 2.0 地圖封裝（圖層、疊加物、長按、2D/3D）
  js/lib/sheet.js       底部面板（可拖曳停靠點）
  js/lib/history.js     搜尋記錄
  js/lib/scale.js       比例尺
  js/lib/env-provider.js 海拔／氣壓提供者介面
  js/lib/navlinks.js    高德／Apple 導航連結
  js/lib/api.js         呼叫自家 /api（前端完全沒有金鑰）
  js/lib/population.js  2020 人口密度（Chen et al.，只在中國境內做 GCJ 偏移）
  js/lib/traffic-layer.js 高德即時路況
  js/lib/footprint.js   我的足跡（時間範圍、熱力資料）
  data/pop/             c.bin.gz、b.bin.gz（約 4／2 公里，CC BY 4.0）；m/、f/、n/ 不進 git
core/                   後端邏輯（平台無關：標準 Fetch Request → Response）
  handlers.js           /api/search、/api/geocode、/api/route、/api/weather、/api/footprint 等
  footprint.js          登入者自己的足跡（KV，不公開）
  validate.js           參數白名單與驗證
  mapping.js            高德回應 → 精簡 JSON
  ratelimit.js          每個 IP 的限流
server/server.mjs       本機 Node 伺服器（靜態檔＋/api）
api/*.js + vercel.json  Vercel 部署用
worker/index.js + wrangler.toml  Cloudflare Workers 部署用（wrangler／Static Assets）
worker/bundled.js       單檔 Worker 入口（靜態檔內嵌；目前線上版使用）
scripts/build-worker.mjs、scripts/deploy-cloudflare.mjs  打包與重新部署
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
- 全程使用 **GCJ-02**（高德座標）：圖磚、搜尋結果、路線都是 GCJ-02，直接交給高德 JS API 使用，所以線和地圖完全對齊。
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

### B. Cloudflare Workers（建議，**目前已部署**）
- 網址：**https://world-map.kwok-worldmap.workers.dev**（Worker 名稱 `world-map`，帳號的 workers.dev 子網域 `kwok-worldmap`）。
- 部署方式：**單檔 Worker**。`scripts/build-worker.mjs` 用 esbuild 把 `worker/bundled.js`＋`core/`＋整個 `public/`（base64 內嵌，約 320 KB）打包成 `dist/worker.js`；`worker/bundled.js` 提供和 Workers Static Assets 相同的 `ASSETS.fetch()` 介面，所以 `worker/index.js` 不用改。
- 綁定：
  - `AMAP_KEY`：**Secret（secret_text）**，只存在 Cloudflare，不在任何檔案或程式碼裡。
  - `API_RATE_LIMIT`：Cloudflare Rate Limiting 綁定，每個 IP 每 60 秒最多 60 次 `/api` 請求（同一機房內跨執行個體有效）。另外還有程式內的記憶體限流（每 IP＋全站，盡力而為）。
- 重新部署（改了前端或後端之後）：
  ```bash
  node scripts/deploy-cloudflare.mjs      # 打包，產生 .run/cf-deploy.js（不含金鑰）
  ```
  然後由 Grok Bot 用 Cloudflare 連接器執行：`execute {"code": "$file:/workspace/world-map/.run/cf-deploy.js"}`。
  重新部署會保留 `AMAP_KEY` 等秘密（`keep_bindings` 含 `secret_text` 與 `plain_text`），也會保留 R2：`keep_bindings` 含 `r2_bucket`，並明確綁 `WM_POP` 到 `world-map-pop`。不需要重設。
- **設定／更換金鑰（請在 Cloudflare 網頁後台做）**：Workers & Pages → `world-map` → Settings → Variables and Secrets → `AMAP_KEY`（類型 Secret）→ Edit → 貼上高德 Web 服務 Key → Deploy。
  - Grok Bot 的連接器會自動把看起來像金鑰的字串遮蔽（變成 10 個字元的佔位字），所以無法透過連接器設定真正的金鑰——這是保護機制，不要繞過。
  - `node scripts/deploy-cloudflare.mjs --secret` 產生的 `.run/set-secret.js` 只適合在有自己 API 權杖、直接呼叫 Cloudflare API 時使用；用完立刻 `shred -u`。
- 如果之後有 wrangler 權杖，也可以改用標準方式（Static Assets）：
  ```bash
  npx wrangler secret put AMAP_KEY       # 互動輸入，不會出現在檔案裡
  npx wrangler deploy                    # 依 wrangler.toml
  ```
- 免費方案每天 10 萬次請求。
- **中國大陸連線注意**：`*.workers.dev` 在中國大陸常常很慢或被封鎖。根本解法是在 Cloudflare 綁定**自己的網域**（Worker → Settings → Domains & Routes → Custom Domain）；網域需另外購買，尚未處理。

### 包成 App（之後）
前端是純靜態檔，可以直接用 Capacitor 之類工具包成 iOS App，`/api` 指向上面任一部署網址即可。屆時定位改用原生 API，開啟高德 App 需要在 `Info.plist` 的 `LSApplicationQueriesSchemes` 加 `iosamap`。

## 限制與已知問題
- 高清模式的文字標註是 256px 圖層放大顯示，比底圖略軟（見上方「高清圖磚」）。
- Apple 地圖不支援途經點，只會導航到終點；高德網頁版只帶第 1 個途經點（高德 App 帶全部）。
- 導航 App 會自己重新規劃，路線和過路費可能和這裡略有差異。過路費是高德估算值（小客車）。
- iPhone 上「沒裝高德 App 就改開網頁」是用 1.6 秒計時判斷，少數情況 Safari 會先跳出「無法開啟網址」提示。
- 高德 Web 服務個人開發者每日配額有限，超過時介面會顯示「今天的查詢次數已達上限」。
- 圖磚直接從高德伺服器載入（不經過我們的伺服器），屬於高德網頁地圖的公開圖磚，非正式授權的 API；高德若改網址需更新 `public/js/lib/layers.js`。
- 尚未包含：離線地圖／離線導航（刻意不做）；天氣與油費／電費估算已在 v4.2 加入（油價為參考值、油耗是線性估算，見 v4.2 說明）；人口密度、即時路況與我的足跡熱力已在 v5 加入。程式已預留：後端在 `core/handlers.js` 的 `ROUTES` 加新端點，前端在 `public/js/lib/api.js` 加函式、`app.js` 加新的面板即可。
