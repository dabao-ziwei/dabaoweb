# 大寶 CMS：操作、架構與部署審查

## 狀態與範圍

本機正式資料模型與真實 API 已實作；不是 localStorage prototype。
尚未部署、建立付費資源、修改正式 Supabase 或啟用正式前台 CMS。
正式服務需另外通過平台、成本、遷移、資安與 Git PR 審查。

目前官網由 GitHub Pages 的 main 根目錄部署，無法直接執行 Node、Session 或 SQLite 寫入。
Course V2 已存在 origin/main；本次沒有重新設計 Course V2、改排盤演算法或修改外部預約系統。

## 本機操作

需要 Node >=24.12、npm。

```sh
npm ci
npm run cms:admin -- --username admin
npm run cms:import -- --legacy-cloud
npm run cms:start
```

- 後台：http://localhost:4280/admin/
- 首頁：http://localhost:4280/index.html
- 課程：http://localhost:4280/course.html
- 初階 LP：http://localhost:4280/ziwei-beginner-course.html
- macOS 預設資料目錄：`~/Library/Application Support/DabaoCMS`
- 可用 `CMS_DATA_DIR` 指定其他專案外的私有持久路徑
- Node 不會自動讀 `.env`；使用主機環境變數或 `node --env-file=... cms/server.mjs`
- 首次管理員密碼透過終端遮蔽輸入，不經聊天或 URL 傳遞
- 新密碼長度為 10～128 字元，前端表單與伺服器使用相同規則
- `--generate` 僅供本機，登入資料寫入資料目錄內權限 0600 的私人檔案
- 忘記密碼時，可由具有主機權限的維運者透過 CLI 建立另一管理員，登入後變更密碼；沒有公開重設密碼 API

### 發布流程

1. 課程種類：管理名稱、簡介、定位、對象、堂數、每堂分鐘、階序、排序、公開與介紹頁
2. 招生期別：選所屬課程，設定狀態、公開價格、早鳥、日期、時間、人數、平台與報名入口
3. 儲存草稿：公開 API 不變
4. 工具列選首頁／課程總覽／初階 LP，按預覽草稿：需登入，同源預覽，不送 GA／Meta 轉換，帶 noindex
5. 按發布並確認：原子性發布目前全部草稿，建立版本與修改紀錄
6. 取消發布會立即撤下該項公開資料，不順便發布其他草稿；不刪原圖
7. 發布紀錄可還原版本；會取代該版本對應草稿，後來新增的資料保留為不公開草稿

沒有早鳥截止日期時，由管理員取消「啟用公開早鳥優惠」並發布。
有截止日期時，台北時間該分鐘結束後自動回原價。
報名截止／開課日期過後不再顯示可報名狀態；不猜測未提供的日期。
「招生中」與「即將額滿」可報名，其餘狀態保留詢問入口。

### 回饋管理

- 每批最多 30 張，逐張上傳；每張最多 10 MiB，最多 2400 萬像素
- 接受實際內容為 JPEG、PNG、非動畫 WebP；不支援 HEIC、SVG、GIF
- 重新解碼、依 EXIF 轉正、移除 metadata、產生最多 2000px 寬清晰版與 640px 縮圖
- UUID 安全檔名；原始二進位檔僅登入管理員可下載
- 重複圖片依標準化圖片 SHA-256 去重
- 依管理者要求，公開使用同意由管理者在上傳前自行確認；CMS 不檢查、記錄或管理此狀態
- 新圖片一律先保留未發布草稿，不會因上傳而自動公開
- 編輯說明、排序、公開與精選，儲存後再發布
- 上／下排序同一交易交換，遇到其他視窗修改會拒絕舊 revision
- 敏感資料框選遮蔽會輸出新圖片，不是 CSS 遮住；原圖仍私有保存，新圖儲存草稿後即可發布
- 取消發布後，新 CMS 的公開媒體 URL 會回 404；已下載或第三方快取的內容無法收回
- 刪除為可追溯軟刪除，原始檔仍保存；目前不自動永久清除，以免誤刪

舊有 `images/001.jpeg`～`078.jpeg` 和 Supabase public bucket 原網址不會自動刪除。
因此舊網址仍可能被存取，不可把「新 CMS 已取消發布」誤認為已清除網路上的舊檔。
舊公開檔案清理與快取處理仍需另行核准。

## 架構

```text
GitHub Pages 前台（既有 HTML/CSS/JS）
  → cms-config.js（正式啟用前維持 disabled）
  → cms-client.js → 公開唯讀 API /media

CMS 主機 /admin/（獨立同源登入）
  → HttpOnly Session + CSRF → Node HTTP API
  → SQLite WAL + 持久磁碟私有 media
  → 草稿／版本／audit／備份
```

Node 24 原生 HTTP、crypto、SQLite；sharp 處理圖片。不引入前端 framework。
既有 Supabase 僅取得公開讀取資訊，尚未核准變更正式 Auth／RLS／schema，所以本輪先用隔離的本機後端完成可驗收系統，沒有擅自遷走或修改既有雲端專案。
SQLite 適合目前單管理員、小型內容站，必須單一執行實例配本機持久磁碟，不適合無狀態 serverless、網路檔案系統或多副本寫入。
GitHub Pages、既有 Supabase 不直接重寫；新 CMS 資料與舊雲端資料隔離。
單次核准部署與切換設定後，更新課程／圖片不需要 Git 或重新部署。

### 資料表

| 表 | 用途 |
|---|---|
| schema_migrations | schema 版本 |
| admins | 管理員、scrypt hash、停用狀態 |
| sessions | 雜湊 Session token、CSRF、有效期、最後活動 |
| login_challenges | 短期登入 CSRF challenge |
| login_attempts | 登入失敗與節流 |
| courses | 任意數量課程種類、草稿／已發布 JSON、revision、軟刪除 |
| cohorts | 期別、所屬課程 FK、草稿／發布內容、revision |
| media | SHA-256、來源 hash、尺寸、私有原檔資訊 |
| feedback | media FK、說明、排序、精選與公開狀態 |
| settings | 精選數量、官方 LINE |
| versions | 完整公開快照、發布時間與操作者 |
| audit_log | 修改前／後、動作、時間、項目、操作者 |

Migration：`cms/migrations/001-initial.sql` 初始化 schema；`002-remove-feedback-consent.sql` 一次性移除草稿、公開版本及操作紀錄中的舊同意欄位，不改圖片、公開狀態或排序。啟動冪等執行，原有備份不刪除。
金額為 TWD 整數，總時數由堂數 × 分鐘計算。日期／早鳥使用 Asia/Taipei。
新增課程不需要改 SQL schema；沒有預先發布 2027 七班制度。
首次啟動只移入既有四種已公開課程，未確認的堂數／分鐘保持空白。

### API

公開 GET：
- `/api/public/content`：公開課程、期別、設定、精選、總數，不含草稿／管理員／audit
- `/api/public/feedback?offset=0&limit=24`：分頁，最多每次 60 張
- `/media/:id/thumb`、`/media/:id/full`：只服務目前已發布並設定公開的圖片
- `/healthz`

管理：
- GET `session`、POST `login`／`logout`／`password`
- GET `state`／`preview`／`history`
- PUT `courses[/id]`／`cohorts[/id]`／`feedback/id`／`settings/site`
- POST `publish`、`versions/:id/restore`
- POST `upload`、`media/:id/redact`、`feedback/reorder`
- DELETE `:kind/:id`、POST `:kind/:id/unpublish`

管理 API 均位於 `/api/admin/`；除 bootstrap/login 外須有效 Session，所有寫入須相同 Origin 與 CSRF。

### 前台與快取

- 首頁課程推薦、Course Overview 招生區與 Beginner LP 費用來自同一份已發布 API
- LP 固定綁 beginner，不會因首頁改推進階班而把初階 LP 變成進階頁
- 任意新課程無獨立介紹頁時使用 `course-enrollment.html?cohort=...`
- 同時開放多期別時，總覽顯示其他招生入口
- 課程種類清單動態產生；現有四階段的成果文案保留，課程數量沒有寫死
- 發布 API 回應後，重新整理立即讀取新資料；公開 API no-cache + ETag，無長期 CDN TTL
- 可見頁每 60 秒輪詢、切回分頁／視窗焦點會刷新；同源發布使用 BroadcastChannel 提前通知
- API 失效時顯示無法載入／詢問，不退回舊價格或未確認回饋
- 縮圖 lazy-load，gallery 每次 24 張，數量與精選顯示數取自資料
- Schema 使用同一份已發布費用／日期；公開 HTML 仍可被索引
- Google 可執行 JS 取得動態資訊；不執行 JS 的 crawler 不會取得即時價格，這是靜態站 + runtime API 的限制

## 安全

- 隨機鹽 scrypt N=65536/r=8/p=1，Session token 只在 DB 保存 SHA-256
- Session 8 小時、閒置 30 分鐘；登出作廢、改密碼作廢全部該帳號 Session
- Cookie HttpOnly、SameSite Strict；production 加 Secure 與 __Host- 前綴，強制 HTTPS origin
- 同帳號/IP 5 次失敗、同 IP 20 次後鎖 15 分鐘；登入計算同時最多 2 個
- 管理員無公開註冊；CLI 建立，密碼不在 URL／前端／Git
- 管理端 CSP、nosniff、no-store、noindex；公開 API 僅對設定的 origins 開 CORS
- 所有寫入在伺服器驗證、參數化 SQL、欄位 allowlist、revision 防覆寫
- 圖片原檔、DB、備份與密碼檔在專案外，私有檔案 0600、目錄 0700
- Native API 阻擋敏感目錄、dotfiles、symlink escape 與不允許副檔名
- 圖片上傳最多同時處理 2 個，尺寸／檔案大小／內容皆驗證
- 不宣稱已通過外部滲透測試；正式平台仍需 TLS、主機更新、磁碟監控、離站加密備份與監控告警

### 舊後台：正式發布阻擋項

舊 sessionStorage `isAdminLoggedIn` 不是伺服器授權，已停止使用；舊 HTML 入口改導新 CMS。
舊 JS 留在 Git 中避免無關功能來源遺失，但新入口不載入、不執行這些寫入程式。
移除前端入口不會自動撤銷 Supabase RPC、table grants 或 storage policy。

`cms/legacy-supabase-lockdown.sql` 是**待核准**腳本，沒有執行。
需擁有者先備份、盤點所有既有 client，再撤銷舊匿名寫入權限。
它也會停用舊文章／公告的 browser writer；本輪未建立文章編輯 CMS，公開文章仍沿用既有讀取。
若需要保留文章管理，必須另外核准遷移至伺服器驗證的管理流程。
正式開放前必須實際檢查上述權限，不能僅因新 CMS 安全就宣稱舊雲端 API 已安全。

## 遷移與備份

`npm run cms:import -- --legacy-cloud` 僅 GET 舊資料，不改正式 Supabase。
來源白名單限制原 Supabase bucket，不跟隨其他站轉址。
原始 78 張順序 001→078，雲端新增依既有最新優先規則放前面。
精選保留 002／003／004／014／021／033，遷移不自動發布。
新匯入圖片預設未發布草稿，已存在的圖片不修改其公開狀態；匯入不需要同意參數或確認欄位。
每次匯入前做 DB／media 備份，處理前另外保存來源原始二進位與 SHA-256；匯入後產生對照 manifest。
同一圖片重跑不新增重複回饋，也不覆蓋既有後台編輯。

```sh
npm run cms:backup -- --to /private/backup/dabao-YYYYMMDD
# 停止 CMS 後才可以：
npm run cms:restore -- --from /private/backup/dabao-YYYYMMDD --confirm-replace
```

備份使用 SQLite backup API 取得一致快照，複製快照引用的全部原圖／清晰版／縮圖並產生 SHA-256 manifest。
還原先驗證所有 hash、自動保留還原前備份，先複製媒體再原子性替換 DB，清除舊 Session。
server.lock 防止服務使用同資料目錄時執行 restore／第二個 server。
資料目錄與備份目錄禁止位於網站專案內，亦檢查實際 symlink 路徑。
備份仍含私人資料，需私有、加密、離站保存；同磁碟備份不是災難復原。
目前提供手動命令，正式定時備份與離站目的地待平台核准，不會偷偷建立排程或外部服務。

## 部署方案待核准

優先選項：保留 GitHub Pages，增加單實例 Node 24 Web Service + 私有持久磁碟。
可用既有自管 Node 主機，或核准後使用 Render 類受管服務。
Dockerfile.cms / compose.cms.yml 是部署準備，沒有啟動正式容器或建立雲端資源。

Render 評估（2026-10-22 查官方資料）：
- 付費單實例才能掛持久磁碟；免費 Web Service 的檔案會隨重啟／部署遺失，不適合本系統
- 官方 Pricing 搜尋索引列 512 MB / 0.5 CPU 為 US$7/月；2 GB / 1 CPU 為 US$25/月
- 本系統有圖片解碼與密碼雜湊，建議先評估 2 GB 方案，5 GB 磁碟約 US$1.25/月，合計約 US$26.25/月起；這是基礎估算，不含超額流量、稅、離站備份或另選的 workspace 費用
- 512 MB 低價方案需先壓低圖片併發並在實際主機做記憶體壓力測試，不能僅因比較便宜就宣稱可穩定承載
- 實際計價與方案以核准當日官方 Pricing／結帳為準，未購買任何服務
- 若另選 Pro workspace，官方另列 US$25/月，基礎運算／磁碟加上該 workspace 約 US$51.25/月起；不要把運算價格誤認為完整帳單
- 受管 TLS 與 Node 更新維護較少，但 SQLite 單實例與掛磁碟的部署需安排短暫停機；不能多副本
- 不需要額外新增 Postgres 帳號；維持既有 Supabase 文章讀取
- 原價來源：<https://render.com/pricing>；持久磁碟：<https://render.com/docs/disks>；免費限制：<https://render.com/docs/free>

核准後才執行：
1. 建立受管單實例與持久掛載，例如 `/var/lib/dabao`，不要把 DB 放進 image
2. 設 `NODE_ENV=production`、`CMS_HOST=0.0.0.0`、`CMS_DATA_DIR`、正確 `PORT/CMS_PORT`
3. `CMS_ORIGIN=https://實際核准的CMS網域`；`CMS_PUBLIC_ORIGINS=https://dabao.life,https://www.dabao.life,https://CMS網域`
4. 設 HTTPS、主機請求大小限制、健康檢查、磁碟／流量監控與備份
5. 安全終端建立正式管理員，另行匯入並核對公開資料
6. 經批准處理舊 Supabase grants／RPC／storage policy，必要時遷移舊文章管理
7. 一次性透過審查 PR 將靜態 `cms-config.js` 設為 enabled、apiBase 寫實際核准網址
8. 檢查正式 CORS、Cookie、登入、草稿／發布、圖片可讀性、三頁價格、GA 與 Meta
9. 人工核准後才公開切換；之後只改資料不需要部署

## 測試

```sh
npm run cms:test
# 需要可用的 Playwright 及 Chromium；沿用專案 QA 的 Playwright 工具鏈。
PLAYWRIGHT_MODULE=/absolute/path/to/playwright QA_CHROME=/path/to/chrome \
QA_OUTPUT=/private/output node tests/cms-browser-qa.mjs
```

API 測試建立獨立暫存 DB／強密碼／合成圖片，測後刪除。
Browser QA 同樣使用獨立資料，GA／Meta transport、舊 Supabase 與外部 LINE 全部攔截；不送出正式轉換、不修改正式資料。
`QA_SKIP_POLL=1` 只供快速迭代，最終測試必須不帶此旗標，實際等待一次 60 秒公開輪詢。
Docker build 與雲端連線需在有 Docker／核准平台時另行驗證，不能把本機測試視為已部署成功。
