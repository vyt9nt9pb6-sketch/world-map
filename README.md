# World Map

給長途自駕用的網頁地圖。支援高德高清底圖、搜尋、駕車路線（含過路費），可一鍵交給高德地圖／Apple 地圖導航。

**線上版：** https://world-map.kwok-worldmap.workers.dev

手機（iPhone Safari）優先，桌機也能用。

## 主要功能

- 高德高清底圖（標準／衛星／地形）
- 地點搜尋與附近搜尋
- 駕車路線規劃（多條路線、過路費、避開高速公路／收費站）
- 公交／鐵路優先路線
- 一鍵交給高德地圖或 Apple 地圖導航
- 熱力圖圖層：人口密度（2020 靜態估計）、即時路況、我的足跡（登入後）
- Liquid Glass 風格介面，支援深色模式
- 地點詳情頁（評分、營業時間、電話、照片）

## 技術架構

- 前端：純靜態網頁（高德 JS API 2.0）
- 後端：Cloudflare Worker（API 代理、限流、身份驗證）
- 資料：高德地圖、人口密度資料（Chen et al. 2024）、ESA WorldCover

## 本地開發

```bash
npm install
npm run dev
```

## 部署

使用 Cloudflare Worker 部署。需要設定的 Secret：

- `AMAP_KEY`（高德 Web 服務 Key）
- `AMAP_JS_KEY` / `AMAP_JS_SECURITY_CODE`
- 其他可選：`TIANDITU_TK`、`MAPBOX_TOKEN`、`GOOGLE_MAPS_TILE_KEY`

人口密度細圖磚存放於 R2 bucket `world-map-pop`。

## 授權

MIT
