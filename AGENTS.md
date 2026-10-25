# 專案固定流程

- 採 Local First → Local Review → User Approval → Git PR。
- 修改先從最新 origin/main 建立獨立 feature branch，不直接修改 main。
- 人工確認本機版本前，不自行 commit、push、建立 PR 或部署；使用者的明確單次指示除外。
- PR 建立後停下來，不自行 merge、刪除分支或部署正式網站。
- **所有 PR 標題與描述一律使用繁體中文**，檔名、程式識別字與必要的技術名稱可保留原文。
- 正式 Supabase schema、Auth、RLS、Storage policy、外部預約與監測工具的變更須另經使用者明確核准。
- 不將密碼、service role／secret key、私人資料庫、原始圖片備份或遷移包加入 Git。
- 管理員上傳的圖片一律已取得公開使用授權，不新增同意欄位、授權紀錄、授權審核或重複確認。圖片縮圖／閱讀版直接由公開 Storage/CDN 提供；草稿／發布只控制頁面列表，不對每次讀圖做授權查核。後台管理操作仍需登入。
