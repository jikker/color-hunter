# 顏色獵人排行榜後端 — 部署說明

本資料夾 `Code.gs` 是「顏色獵人」雲端排行榜的 **Apps Script Web App** 後端。
全新獨立專案／全新 Google Sheet「顏色獵人排行榜」／全新 HMAC 密鑰，與 T-152 數字獵人完全分離。

> ⚠️ 需用瀏覽器登入 Google 帳號（建議與數字獵人同帳號 **iiikccc02@gmail.com**，集中管理）部署。
> headless 工人無 browser／憑證無法代部署，故附手動步驟。部署前遊戲以**本機排行榜**運作（`LB_API` 留空）。

## 部署步驟（約 3 分鐘）
1. 開 <https://script.google.com> → 新增專案，命名「顏色獵人排行榜 API」。
2. 把本資料夾 `Code.gs` **整檔內容貼進**編輯器的 `Code.gs`（覆蓋預設內容）、存檔。
3. 部署 → **新增部署作業** → 類型「網頁應用程式」：
   - 執行身分＝**我（擁有者）**
   - 具有存取權的使用者＝**所有人**
   - 部署 → 首次會要求授權（Sheets／Drive），同意。
4. 複製產生的 `/exec` 網址。
5. 把該網址貼進前端 `T-164-color-hunter/index.html` 的：
   ```js
   const LB_API = '貼這裡/exec';
   ```
   重新整理頁面即啟用雲端榜（四難度各自獨立、各留前 20 名）。

## 部署後驗證（curl，任何機器）
```
# doGet 應回該難度榜（首次自動懶建 Sheet，回空陣列）
curl -sL "<你的/exec>?mode=hard"
```
正常送分需 HMAC 簽章（`name|mode|sec|errors|ts|nonce`，密鑰＝`Code.gs` 的 `SECRET`，與前端 `lbSecret()` 相同）。
偽簽應回 `bad sig`、重放 `replay`、過期 `stale ts`、低於最短秒數 `bad sec`。

## 共享密鑰（前後端必須一致）
- 後端 `Code.gs` 的 `SECRET` = `331ab471ccfd99a381e3aec67b9f805f3696fce5789662f0`
- 前端 `index.html` 的 `LB_KC` 每碼 XOR 90 還原後 == 上述 `SECRET`（已對拍驗證）。
- 改任一端都要同步另一端，否則所有上傳會 `bad sig`。

## 與其他獵人遊戲的隔離
- Sheet 名稱不同（「顏色獵人排行榜」vs「67 獵人排行榜」vs「數字獵人排行榜」）、密鑰不同、Apps Script 專案不同。
- 欄位精簡為 `name / sec / errors / date / ts`（顏色獵人找多個目標格，無 fast/slow 逐題統計）。
- `MIN_SEC` 大幅調低（反應遊戲：beginner≥0.5 / easy≥0.7 / normal≥0.9 / hard≥1.1 秒），只擋 0 秒造假。
