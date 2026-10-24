# Supabase 後台串接與啟用審查

## 交付狀態

2026/10/24 擁有者另行核准正式建置與遷移後，已執行私有 CMS SQL、以 Docker 打包部署 `dabao-cms`、匯入 79 則回饋與 237 個媒體檔，並建立獨立 CMS 管理員；沒有重設既有 Auth 帳戶密碼。
本分支將 `cms-config.js` 改為 Supabase `enabled: true`，**正式靜態網站仍須待本分支 PR 經人工審查、合併及 GitHub Pages 部署後才會啟用登入**。本輪沒有自動合併或部署 GitHub Pages。
本機 Postgres／私有媒體驗收不能替代正式 Supabase Auth、Storage、TLS、Edge 資源限制及實際權限的驗收。

### 本輪正式驗收與限制

- 4 個課程、1 個期別、79 則回饋、79 組媒體、2 個既有版本與 336 筆既有操作紀錄已遷移；237 個雲端媒體檔逐檔 SHA-256 與來源一致
- 已保存 Git 外私有快照，核對原有網站六張資料表內容未變；六張 CMS 表皆啟用 RLS，anon／authenticated 無管理 RPC 執行權限，媒體 bucket 私有
- 真實 HTTPS API 已驗證 Auth 登入、10 字元初始密碼、拒絕 9 字元新密碼、私有圖片、WASM 上傳與像素遮蔽、發布、軟刪除、登出及撤銷 session
- 600×900 與 1440×2560 合成測試圖片通過實際 Edge 處理；不代表所有 10 MiB／2400 萬像素上限檔案、併發流量或 Free 配額已壓力測試
- 測試圖片未公開，已軟刪除並保留還原資料；公開課程／期別／回饋內容與測試前相同。測試發布會新增版本與 audit，沒有刪除紀錄
- 密碼變更與全部 session 撤銷流程已通過本機整合測試；本輪未變更正式管理員初始密碼，應由擁有者首次登入後自行更換
- 修正正式 Gateway 轉送路徑、弱 ETag 及 Storage `400 / NoSuchKey / statusCode=404` 相容性，並補測試；修正已刪除項目完成發布後仍被計入待發布的問題
- 後台切換頁面或登出後，不再繼續為已離開的圖片元素發起新的下載，避免無效的背景載入與登出後 401
- 本機整合 18 項、隔離瀏覽器 55 項、真實雲端唯讀 16 項、管理 API 23 項、後台瀏覽器 31 項、公開頁瀏覽器 35 項通過；瀏覽器使用本機靜態檔搭配真實 HTTPS 雲端 API，不是已部署的正式前台畫面
- 桌機 1440×900／1280×720 與手機 390×844／375×812 無水平溢出及 console error；草稿預覽沙箱與真實私有圖片正常
- 驗收後已撤銷全部 CMS 測試 session，清除 admin 本輪登入節流計數與本機臨時金鑰副本，登出 CLI；正式初始密碼僅交付 Git 外私有檔案，未變更
- 既有 `generate-seo` 原始程式雜湊保持一致。平台套用專案環境變數後其版本號有更新，未重新上傳或修改該函式來源
- 正式備份排程、災難還原演練與長期流量監測仍須另行安排；本輪沒有建立付費方案

## 已核對的現有環境

2026/10/24 使用擁有者登入的 Dashboard 唯讀核對：

- 專案 `DabaoWeb`，ID `uwktzlxlduqyjyoolgrs`，組織畫面標示 Free
- 官網現有來源：`articles`、`article_tags`、`tags`、`announcements`、`site_settings`、`feedbacks`
- `feedbacks` 表 1 筆；原 Git 回饋圖片 78 張；本機已遷移資料共 79 筆／79 個媒體
- 既有公開 bucket：`article_images`、`feedback_images`、`feedbacks`
- Email Auth 已啟用、公開註冊與匿名登入已關閉
- Site URL 為 `https://www.dabao.life`，redirect allowlist 包含 www 與 monitor 網域
- 既有 Edge Function：`generate-seo`
- 同專案還有監測工具資料與其他舊後台資料，不能整批取代 Auth／RLS 或撤銷全部匿名權限
- Dashboard 當時顯示 Unhealthy 與平台技術事件通知；不能據此推定既有網站已故障，部署前需重新核對服務健康
- 三張監測相關表出現未啟用 RLS 的警告。本輪未測試匿名讀寫、不讀取內容、不自動修正這些無關政策

## 架構

```text
dabao.life/admin/（仍由 GitHub Pages 服務）
  → cms-transport.js → dabao-cms Edge Function
  → Supabase Auth 驗證既有帳密
  → 私有 dabao_cms.admins 管理員名單
  → 可撤銷的 CMS opaque session（資料庫只存 SHA-256）
  → service-only RPC → dabao_cms 私有內容／版本／audit
  → dabao-cms-media 私有 bucket

首頁／課程／初階 LP
  → cms-client.js → Edge Function 公開唯讀 API
  → 僅目前已發布資料與已公開圖片
```

不需要部署長駐 Node 或 SQLite 主機，但需部署 Edge Function、遷移私有資料及完成實際雲端測試。
不承諾 Free 一定足夠；部署前需確認帳戶用量、專案配額、圖片 CPU／記憶體及供應商方案。沒有建立付費資源或變更訂閱。

### 登入與安全

- 保留「管理員帳號」欄位，例如 `admin`；私有名單將別名對應指定的 Supabase Auth user UUID
- 不將本機密碼、hash 或管理員 session 遷移到 Supabase
- 登入時後端向 Auth 驗證密碼，核對 user UUID 與 CMS allowlist，其他監測工具的 Auth 使用者不會自動成為 CMS 管理員
- 建議為 CMS 使用專用 Auth 帳戶，不共用監測工具帳號；建立／授予此帳戶權限需要擁有者另行核准
- service role key 只讀取 Edge 環境變數，不進入 HTML、JS、Git、URL 或瀏覽器
- 瀏覽器只在記憶體保留隨機 CMS token，重新整理管理頁需重新登入；不使用 localStorage／sessionStorage 保存登入憑證
- CMS session 最長 8 小時、閒置 30 分鐘；登出立即失效，變更密碼撤銷該 CMS 管理員全部 session
- 修改密碼先用目前密碼重新驗證 Auth，最少 10、最多 128 字元；不降低專案原有 Auth 密碼規則
- 目前密碼驗證通過後，先撤銷 CMS sessions，再更新 Auth 密碼，避免兩個系統無法原子提交時留下舊登入。若更新過程斷線，需重新登入確認結果；audit 的撤銷紀錄不宣稱 Auth 密碼必然變更成功
- 帳號每 15 分鐘最多 5 次登入嘗試、IP 最多 20 次；計數存 Postgres，不依賴單一 Edge instance 記憶體
- CORS 使用明確 allowlist；寫入要求 Origin 與 bearer session。CORS 不是授權機制，所有管理路由仍須伺服器 session／名單檢查
- 每次 commit 在 DB 交易內重新檢查 session，並用整體 revision compare-and-swap 防止 lost update
- 私有 schema 啟用 RLS，沒有 anon／authenticated 存取政策，service-only RPC 明確撤銷兩者與 PUBLIC 的 execute 權限
- 不提供公開註冊／自助取得管理員權限的入口
- 密碼變更為 Supabase Auth 帳戶密碼變更；若使用者選擇共用帳戶，其他系統登入也會受影響，正式建立前必須說明並確認

### 圖片與預覽

- 新增私有 bucket `dabao-cms-media`，不修改既有公開 bucket／網址
- 原始圖片、清晰版與縮圖皆私有，原圖不經公開 API 提供
- 公開圖片每次從已發布回饋查核；取消發布後返回 404，不使用仍有效的長期 signed URL
- 上傳仍最多 10 MiB／2400 萬像素、JPEG／PNG／非動畫 WebP，實際 signature 與解碼驗證，不信任副檔名／Content-Type
- Edge 使用固定版本 ImageMagick WASM，移除 metadata、轉正、產出 2000px 清晰版與 640px 縮圖
- 記憶體資源超限時拒絕處理；10 MiB／2400 萬像素是上限，不代表所有上限圖片都能通過 Edge CPU／記憶體限制，正式平台必須壓力測試
- 每個 isolate 最多一個圖片工作；限制不是跨 isolate 的全域併發保證
- 遮蔽實際輸出不透明像素，不是 CSS；新衍生圖的可下載原檔也是遮蔽後版本，原始圖片繼續私有保留
- 舊的未遮蔽版本不能透過版本還原重新公開
- 後台圖片以帶 bearer 的 fetch 取得 blob，不把 token 放到 img URL
- 雲端草稿預覽改用同網站的沙箱 dialog iframe（僅 allow-scripts，不給 allow-same-origin）；前台與第三方腳本不能讀取後台 transport。透過只讀 postMessage bridge 取得草稿及該草稿引用的圖片，不能呼叫管理端寫入；不在 URL／storage 傳遞登入 token
- 預覽不送 GA／Meta 轉換，退出登入或密碼更新會關閉預覽
- API commit 回應不確定時不自動刪除上傳物件，以免「交易已成功但網路斷線」造成已發布圖片遺失；可能產生的未引用私有物件需核對後人工清理
- 使用者已確認上傳前會取得公開同意，不重新加入同意檢查／記錄／管理流程

## 本機驗收

```sh
npm ci
npm run cms:supabase:test
PLAYWRIGHT_MODULE=/absolute/path/to/playwright QA_CHROME=/path/to/chrome \
  node tests/cms-supabase-browser.mjs
node tests/cms-supabase-preview.mjs
```

預覽網站 `http://localhost:4283/`，後台 `/admin/`，隔離 API 在 `localhost:4284`。
僅綁定 127.0.0.1。Postgres 使用 PGlite 實際執行本次 SQL，媒體保留在隔離記憶體。
**Auth 是本機測試替身，不是登入正式 Supabase**。本機驗收密碼隨機生成、10 字元，寫在專案外權限 0600 的私人檔案，終端只顯示路徑。
本機預覽編輯重啟後重置；不修改本機原 SQLite 或正式 Supabase。
瀏覽器測試攔截分析追蹤與外部目的地，不向正式服務送測試轉換、登入或寫入。

使用現有資料驗收：

```sh
npm run cms:supabase:export -- /private/current-cms /private/new-review-package
npm run cms:supabase:verify -- /private/new-review-package
CMS_REVIEW_PACKAGE=/private/new-review-package node tests/cms-supabase-preview.mjs
```

匯出使用 SQLite read-only transaction，不含 admins／sessions／login credentials。
保留全部課程／期別／回饋草稿與發布狀態、排序、精選、media、版本、audit；每個資料檔／原圖／清晰版／縮圖附 SHA-256。
匯出目錄必須是新的、位於網站與來源資料之外的私有目錄。

## 重建／重新啟用順序：每步均待核准

以下保留為重建操作指南，不代表上述 2026/10/24 已完成步驟尚未執行。後續重新部署或改動權限仍須取得核准。

1. 本機功能、Desktop／Mobile 與人工 Review 通過
2. 確認備份、回退計畫、平台健康、方案限制、既有匿名寫入 RPC／Storage 權限；不直接套用舊的全面 lockdown 腳本
3. 擁有者核准 `supabase/migrations/202610240001_dabao_cms.sql`：只新增私有 CMS schema、service-only RPC 與私有 bucket
4. 核准部署 `dabao-cms`，保留原 `generate-seo`；不更動其他 Function／Auth providers。先執行 `npm ci`、`npm run cms:supabase:prepare`，將鎖定版本的 JS／WASM／授權檔產生到忽略版本控制的 vendor 目錄；原始 npm 版本及 integrity 由 package-lock 管理。`supabase/config.toml` 已列出靜態檔案，使用具 Docker 的 Supabase CLI 本機打包，不使用 Dashboard／`--use-api` 部署。2026/10/24 使用 CLI 2.122.0 預設 Docker 打包，實際部署套件為 5.0 MB；該版本沒有 `--use-docker` 旗標
5. Edge secret 設 `CMS_ALLOWED_ORIGINS=https://dabao.life,https://www.dabao.life`。Supabase URL／service role 使用平台提供的 server-side secrets
6. 匯出最新本機遷移包並核對數量／hash；私有環境中以明確專案確認執行 import，不使用聊天傳遞 service role key
7. 建立／選定 CMS 專用 Auth 帳戶，再由擁有者核准加入 `dabao_cms.admins`。不要任意把目前登入 Dashboard 的 GitHub／Google 帳戶當成網站管理員
8. 以正式 HTTPS 實測 Auth、名單隔離、失敗節流、重複登入、密碼更新、CORS、上傳、遮蔽、發布、取消公開、舊工具相容性及資源限制
9. 完成上述驗收後，才透過獨立審查 PR 修改 `cms-config.js`：

```js
window.DabaoCmsConfig = {
    enabled: true,
    provider: 'supabase',
    apiBase: 'https://uwktzlxlduqyjyoolgrs.supabase.co/functions/v1/dabao-cms',
    pollSeconds: 60
};
```

10. 人工核准、Git PR／Review／部署後，`https://dabao.life/admin/` 才是可用的正式管理入口；三個公開頁一起切換資料來源

匯入命令沒有掛在 install／startup／CI，需手動提供專案 ID：

```sh
# 僅供另行核准的全新目標重建；2026/10/24 已匯入的正式目標不可重複執行。
node cms/supabase/import.mjs /private/verified-package --confirm-project=uwktzlxlduqyjyoolgrs
```

既有內容不會被覆蓋：目標 revision 非 0 時拒絕 import。
斷線重跑時既有媒體 hash 相同才略過；hash 不同拒絕覆蓋。完整媒體確認後才原子性匯入資料、版本與 audit。
service role、遷移包、正式管理員密碼與原圖永遠不進 Git。

## 回退與剩餘限制

- 啟用前：正式靜態站保持舊資料來源，不影響訪客
- 啟用後如需回退：先保留雲端新增資料與版本，再經審查恢復前台設定；不可直接把靜態舊價格重新公開當成最新資料
- 前台關閉 CMS 不等於撤銷後台 session／關閉 Edge；停用需另行撤銷 CMS 管理權限並保留資料
- 平台備份、離站備份、保留期限與還原演練仍需在選定方案與實際雲端環境驗收
- 舊公開圖片 URL 與已下載資料無法因新 CMS 取消發布而回收
- 無 Docker／Supabase 本機完整 stack 的環境，可用真 Postgres SQL＋隔離 Auth／Storage 邊界測試，但不能據此宣稱正式雲端驗收；本輪另行執行的真實雲端測試範圍見上述紀錄
- 專案現有文章與公告仍沿用舊功能；本輪不額外擴充文章編輯 CMS

參考：
- Supabase Auth：https://supabase.com/docs/guides/auth
- Edge 圖片處理與限制：https://supabase.com/docs/guides/functions/examples/image-manipulation
- Edge 授權：https://supabase.com/docs/guides/functions/auth
- WASM 靜態檔打包：https://supabase.com/docs/guides/functions/wasm
- Edge 資源限制：https://supabase.com/docs/guides/functions/limits
- PGlite：https://pglite.dev/docs/
