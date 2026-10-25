# CMS 登入與媒體效能修正

本輪依 Local First 製作，尚未部署正式 schema / Edge Function / 網頁

## 行為

- 登入以 `login_prepare → Auth → login_finish` 三次服務呼叫完成，最後一次交易回傳後台資料
- 帳號每分鐘最多 5 次嘗試，IP 每分鐘最多 30 次；冷卻不超過 60 秒
- 成功登入清除帳號計數，不清除 IP 計數；並行請求仍先保留額度
- Auth 服務本身的限流 / 服務中斷不再誤報成密碼錯誤；不更改 Supabase 共用 Auth 設定
- 勾選「記住我」保存 30 天；不勾選時維持記憶體 token、8 小時絕對期限與 30 分鐘閒置期限
- 記住登入使用 `__Host-` / Secure / HttpOnly / SameSite=None / Partitioned Cookie，不寫入 Web Storage 或網址
- 登出撤銷該 session，變更密碼撤銷該帳戶全部 CMS session
- 瀏覽器必須支援 partitioned cookies；阻擋 Cookie 的環境仍可用當次記憶體登入，但無法跨重新整理保留登入
- 所有管理員上傳圖皆已取得公開使用授權，不檢查、記錄、管理授權或要求再次確認
- 縮圖與螢幕閱讀版上傳至公開 `dabao-cms-public`，前後台直接使用 Storage/CDN URL，不經圖片 API 或逐張資料庫查核
- 不新增圖片授權表、公開審核、背景搬運隊列或每次發布的圖片複製工作
- 使用原生 lazy loading、瀏覽器快取（max-age=86400）；點擊才載入完整圖，Escape 關閉並還原 focus
- 首頁在 CMS 回應前保留原有靜態精選圖，不先清空回饋區
- 原始備份仍留在私有 `dabao-cms-media`，公開 bucket 僅含 full.webp / thumb.webp
- 草稿資料仍需後台登入才能讀取；「未發布」指尚未列在公開頁面，不代表該已授權圖片的 URL 必須私有
- 取消發布／軟刪除只移除前台列表，不保證舊圖片 URL 或快取立即失效

## 驗收

執行 `npm run cms:supabase:test`、`npm run cms:test`

瀏覽器測試：`tests/cms-supabase-browser.mjs` 與 `tests/cms-remember-media-browser.mjs`

後者使用兩個不同 site 的本機 HTTPS 伺服器及隔離 Postgres / Auth 替身，驗證真正的 CHIPS Cookie，並非以攔截回應模擬 Cookie
測試用自簽憑證與忽略憑證驗證僅限該測試瀏覽器，不會修改正式 TLS 或使用者瀏覽器安全設定

## 正式發布順序（需管理員另行核准）

1. 備份正式 CMS schema / function definition，確認不影響其他系統
2. 套用 `202610250001_cms_access_performance.sql` 與 `202610250002_public_feedback_media.sql`
3. 暫停後台寫入期間，使用 `cms/supabase/copy-public-media.mjs --confirm-project=專案ID` 將既有顯示圖片一次複製至公開 bucket；這是部署步驟，不是訪客或每次發布的工作。需要私有環境變數 CMS_SUPABASE_URL / CMS_SUPABASE_SERVICE_ROLE_KEY，不得加入 Git
4. 確認所有既有 full / thumb 均可匿名直讀，原始備份未公開，再重新 prepare 與部署 `dabao-cms` Edge Function，包含前一輪 lazy WASM 修正
5. 驗證 Edge 新登入回傳 state、Cookie 安全旗標、冷卻期與圖片網址
6. 最後才發布本輪靜態網頁 / JS；新前端使用帶憑證 CORS，不能先搭配舊 Edge
7. 正式瀏覽器驗證記住登入、登出、圖片、快取及實際延遲

僅合併 GitHub Pages PR 不會部署 Supabase Edge 或資料庫 migration
勿將本機模擬延遲的改善比例當作正式站效能承諾

舊 gateway 改名為 service-role 亦不可直接執行的 legacy function，只供新的 security-definer gateway 內部呼叫
沒有開放公開註冊、沒有更改舊 public 業務資料表、沒有修改監測工具 Auth 帳戶；僅新增專用公開顯示圖片 bucket，不開放匿名寫入，原始備份 bucket 不變
