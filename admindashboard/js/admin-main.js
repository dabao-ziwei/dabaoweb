// 全域共用物件與方法初始化
window.supabaseUrl = 'https://uwktzlxlduqyjyoolgrs.supabase.co';
window.supabaseKey = 'sb_publishable_zd-hddZrWPl2uzLUJmouxw_U31_3PYa';

window.compressImage = async function(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = event => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;
                if (width > 800) {
                    height = Math.round(height * 800 / width);
                    width = 800;
                }
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);
                canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.8);
            };
            img.onerror = error => reject(error);
        };
        reader.onerror = error => reject(error);
    });
};

document.addEventListener('DOMContentLoaded', () => {
    // 確保資料庫套件已載入
    if (window.supabase) {
        window.supabaseDB = window.supabase.createClient(window.supabaseUrl, window.supabaseKey);
    } else {
        alert('資料庫連線套件載入失敗，請檢查網路連線。');
        return;
    }
    const supabase = window.supabaseDB;

    // --- 左側選單切換邏輯 ---
    const tabTitles = {
        'overview': '首頁總覽', 'ai': 'AI 提示詞產生', 'announcement': '公告管理',
        'feedback': '客戶回饋管理', 'article': '文章管理', 'password': '變更密碼'
    };
    const navBtns = document.querySelectorAll('.nav-btn');
    const contentTabs = document.querySelectorAll('.content-tab');
    const headerTitle = document.getElementById('header-title');

    navBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');
            contentTabs.forEach(tab => tab.classList.add('hidden'));
            document.getElementById('tab-' + targetTab).classList.remove('hidden');
            headerTitle.innerText = tabTitles[targetTab];

            navBtns.forEach(b => {
                b.classList.remove('bg-gray-700', 'text-white', 'font-medium');
                b.classList.add('text-gray-300', 'hover:text-white');
            });
            btn.classList.remove('text-gray-300', 'hover:text-white');
            btn.classList.add('bg-gray-700', 'text-white', 'font-medium');
            
            if(targetTab === 'feedback' && window.loadFeedbacks) window.loadFeedbacks();
            else if (targetTab === 'article' && window.loadArticles) {
                window.loadArticles();
                window.showArticleListView(); 
            }
        });
    });

    // --- 登出邏輯 ---
    document.getElementById('btn-logout').addEventListener('click', () => {
        sessionStorage.removeItem('isAdminLoggedIn');
        alert('已成功登出系統。');
        window.location.href = '/'; 
    });

    // --- 公告管理邏輯 ---
    const announcementInput = document.getElementById('announcement-input');
    const btnSaveAnnouncement = document.getElementById('btn-save-announcement');
    document.querySelector('[data-tab="announcement"]').addEventListener('click', async () => {
        announcementInput.value = '正在讀取最新公告...';
        try {
            const { data, error } = await supabase.from('announcements').select('content').eq('id', 1).single();
            if (error) throw error;
            if (data) announcementInput.value = data.content;
        } catch (err) {
            announcementInput.value = '讀取失敗，請確認資料庫連線或重新整理頁面。';
        }
    });

    btnSaveAnnouncement.addEventListener('click', async () => {
        const newContent = announcementInput.value.trim();
        if (!newContent) return alert('⚠️ 公告內容不能為空白！');
        btnSaveAnnouncement.innerText = '發布中...';
        btnSaveAnnouncement.disabled = true;
        try {
            const { error } = await supabase.rpc('update_announcement', { new_content: newContent });
            if (error) throw error;
            alert('✅ 公告已成功更新！');
        } catch (err) {
            alert('⚠️ 發生錯誤：' + err.message);
        } finally {
            btnSaveAnnouncement.innerText = '發布更新';
            btnSaveAnnouncement.disabled = false;
        }
    });

    // --- 變更密碼邏輯 ---
    const btnChangePass = document.getElementById('btn-change-password');
    btnChangePass.addEventListener('click', async () => {
        const oldPass = document.getElementById('old-password').value.trim();
        const newPass = document.getElementById('new-password').value.trim();
        const confirmPass = document.getElementById('confirm-password').value.trim();

        if (!oldPass || !newPass || !confirmPass) return alert('⚠️ 請將三個密碼欄位都填寫完整！');
        if (newPass !== confirmPass) return alert('⚠️ 兩次輸入的新密碼不一致！');
        if (oldPass === newPass) return alert('⚠️ 新密碼不能跟舊密碼一樣！');

        btnChangePass.innerText = '更新中...';
        btnChangePass.disabled = true;
        try {
            const { data, error } = await supabase.rpc('change_admin_password', { input_old_pass: oldPass, input_new_pass: newPass });
            if (error) throw error;
            if (data === true) {
                alert('✅ 密碼變更成功！請妥善保管您的新密碼。');
                document.getElementById('old-password').value = '';
                document.getElementById('new-password').value = '';
                document.getElementById('confirm-password').value = '';
            } else {
                alert('❌ 舊密碼輸入錯誤，變更失敗！');
            }
        } catch (err) {
            alert('⚠️ 發生錯誤：' + err.message);
        } finally {
            btnChangePass.innerText = '儲存新密碼';
            btnChangePass.disabled = false;
        }
    });

    // --- AI 提示詞產生器邏輯 ---
    const btnFetchAi = document.getElementById('btn-fetch-ai');
    const textAreaResult = document.getElementById('ai-prompt-result');
    const btnCopyAi = document.getElementById('btn-copy-ai');

    btnFetchAi.addEventListener('click', async () => {
        btnFetchAi.innerText = '⏳ 抓取所有資料中...';
        textAreaResult.value = '正在搜集資料庫與所有網頁檔案...\n檔案越多會需要幾秒鐘的時間。';
        btnCopyAi.classList.add('hidden');

        // 寫入最嚴格的開發規範
        let finalPrompt = '【⚠️ 給 AI 的嚴格開發規範（非常重要）】\n';
        finalPrompt += '1. 每次你提供修改後的 `/admindashboard/admin.html` 原始碼時，必須確保 `filesToFetch` 這個陣列包含網站「所有的」網頁檔案。\n';
        finalPrompt += '2. 如果你在對話中幫我「新增」了任何新的網頁檔案，你【必須主動】在修改 `/admindashboard/admin.html` 時，將新檔案的路徑加入到 `filesToFetch` 陣列中。\n';
        finalPrompt += '3. 絕對不可以叫我手動去新增陣列！這非常容易出錯，請你全權負責陣列清單的維護。\n';
        finalPrompt += '4. 在沒有收到「動工」指令下，絕對不可產出任何程式碼。\n';
        finalPrompt += '5. 交付時必須提供「完整的原始碼」，絕對不可以只給片段或 Diff，以確保複製貼上百分之百不會出錯。\n';
        finalPrompt += '6. 如果需要「修改」程式碼，請用最新的程式碼進行修改，不要重新腦補生成，也不要改動到本次修改沒有說要修改的部分（包含畫面、邏輯、UX...），只能針對我們討論完畢且收到動工指令要修改的部分進行調整。\n\n';
        finalPrompt += '========================================\n\n';

        try {
            const { data: dbData, error: dbError } = await supabase.rpc('get_db_schema_for_ai');
            if (dbError) throw new Error('資料庫抓取失敗：' + dbError.message);
            
            finalPrompt += dbData + '\n========================================\n';
            finalPrompt += '以下是我目前網站所有頁面的完整原始碼，請以此為基礎進行修改或新增功能：\n\n';

            for (const file of window.filesToFetch) {
                try {
                    const response = await fetch(file);
                    if (response.ok) {
                        const code = await response.text();
                        finalPrompt += `【檔案路徑：${file}】\n\`\`\`${file.endsWith('.js') ? 'javascript' : 'html'}\n${code}\n\`\`\`\n\n`;
                    } else {
                        finalPrompt += `【檔案路徑：${file}】\n(目前尚未建立此檔案或無法讀取)\n\n`;
                    }
                } catch (err) {
                    finalPrompt += `【檔案路徑：${file}】\n(讀取發生錯誤)\n\n`;
                }
            }
            textAreaResult.value = finalPrompt;
            btnCopyAi.classList.remove('hidden');
        } catch (err) {
            textAreaResult.value = err.message;
        } finally {
            btnFetchAi.innerText = '🪄 抓取並產生終極提示詞';
        }
    });

    btnCopyAi.addEventListener('click', () => {
        textAreaResult.select();
        document.execCommand('copy');
        const originalText = btnCopyAi.innerText;
        btnCopyAi.innerText = '✅ 已全部複製！';
        btnCopyAi.classList.replace('bg-green-500', 'bg-teal-600');
        setTimeout(() => {
            btnCopyAi.innerText = originalText;
            btnCopyAi.classList.replace('bg-teal-600', 'bg-green-500');
        }, 2000);
    });
});