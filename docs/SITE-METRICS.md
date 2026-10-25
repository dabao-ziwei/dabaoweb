# 網站自行累計統計

本功能先在本機驗收，尚未啟用正式站計數；不匯入 GA4 歷史資料

## 統計定義

- 頁面瀏覽：支援頁面載入一次計一次；重新整理／由 BFCache 返回也會再計一次，不是獨立訪客
- 功能點擊：固定清單中的連結、回饋圖與 FAQ 展開，每次操作計一次
- LINE：連結點擊，不代表成功加好友、付款或預約
- 預約系統：開啟 `ziweiapp.dabao.life/booking` 的連結；和本站預約介紹頁入口分開計算，不追蹤外部系統內的操作
- 課程：課程總覽、招生區、初階班頁的入口分開計算
- 區間：預設為啟用至今累計，也可選 Asia/Taipei 今日／近 7 天／近 30 天，含當日；開始時間為正式啟用後第一筆成功計數的時間

支援頁面與所有功能代碼集中於 `site-metrics-catalog.mjs`。`/` 和 `/index.html` 視為同一頁，站內文章只統計總瀏覽／入口，不記文章 ID

只保存每日、來源頁面、操作類型、功能與區塊的加總，不保存逐筆訪客紀錄、IP、Cookie、瀏覽器指紋、Email、姓名、完整網址、query 或 referrer。平台本身的基礎 HTTP 記錄不在此計數資料表內

無法保證擋掉所有機器流量或偽造公開請求。停用 JavaScript、封鎖請求、離線或網路失敗可能漏計；不為補數重送、不當成會計／付款紀錄。沒有唯一訪客、跨頁個人旅程、成交率或歸因推估

## 架構與效能

- 前端使用非阻塞 `fetch` + `keepalive`，不帶憑證，不阻止原本連結跳轉，不修改 GA／Meta
- 只有已啟用的 public content 回應宣告 `metrics.enabled=true` 才會送出，舊後端不會被新前端呼叫不存在的計數 API
- 一次瀏覽／點擊為一次小請求與資料庫 upsert；不經圖片路徑、不觸發圖片處理、不讀寫 CMS 內容文件
- 後台登入先完成，統計獨立載入；統計失敗不讓登入失敗，不以假 0 替代讀取失敗
- 操作紀錄仍在「發布紀錄」，不再作為儀表板主內容
- 正式網域以外不計數；本機測試伺服器可明確啟用 `localMetricsQA`，僅對隔離資料庫測試
- admin、CMS 草稿預覽和非清單頁面不計數

新表只在私有 `dabao_cms` schema，啟用 RLS 並撤銷直接存取。新 RPC 只允許 service_role 呼叫；查報表必須通過既有管理員 session 驗證。匿名訪客只能透過受來源／大小／固定代碼限制的 Edge 端點送計數，不能讀報表

## 正式上線順序（另需擁有者核准）

1. 通過本機驗收、Git PR Review，另取得正式 Supabase 變更核准
2. 套用 `202610250003_site_metrics.sql`，不改現有 Auth、CMS 內容或其他系統 schema
3. 更新 `dabao-cms` Edge（`CMS_METRICS_ENABLED` 先保持未設定／false）
4. 透過已核准的網站發布流程上線前端，確認登入和既有功能正常
5. 擁有者核准開始計數後，設定 `CMS_METRICS_ENABLED=true` 並確認 Edge 已使用新設定，實際瀏覽一次並確認後台讀到記錄

只有前端 PR 合併並不會自動啟用計數。還沒開始時顯示「尚未啟用」，已啟用但沒事件則顯示真正的 0。舊後端回 404／服務錯誤時顯示不可用，不影響其他管理功能

停用：將 `CMS_METRICS_ENABLED=false` 並讓 Edge 使用該設定，前端在下次讀取 CMS 公開內容後停止送出；過渡中的請求也不會寫入。資料保留，重新啟用不會重設起算時間

## 本機測試

```sh
node --test tests/site-metrics.test.mjs
node tests/site-metrics-browser.mjs
npm run cms:supabase:test
node tests/cms-supabase-browser.mjs
```

Browser 測試使用 Playwright，可透過 `PLAYWRIGHT_MODULE` 與 `QA_CHROME` 指定本機執行檔。全部使用可拋棄 Postgres，不連正式 Supabase；測試流量不寫入正式數字

`npm run cms:metrics:preview` 啟動 `http://localhost:4290/admin/` 與隔離 API 4291。隨機 10 字元本機密碼寫入 `~/Library/Application Support/DabaoCMS-Supabase-Local-Review/site-metrics-preview.txt`，不進 Git。此預覽計數從 0 開始、重啟清除；正式資料庫則持久保留累計
