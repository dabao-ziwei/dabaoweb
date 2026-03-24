document.addEventListener('DOMContentLoaded', () => {
    const supabase = window.supabaseDB;
    
    // --- ✨ 舊圖自動升級魔法 ✨ ---
    // 將純 <img> 標籤自動升級為帶有圖說的 <figure> 結構
    function upgradeOldImages(html) {
        if (!html) return '';
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        const images = tempDiv.querySelectorAll('img');
        images.forEach(img => {
            // 如果圖片已經在 figure 裡面，代表是新版的，跳過不處理
            if (img.closest('figure')) return;
            
            // 建立新版的 figure 結構
            const figure = document.createElement('figure');
            const newImg = img.cloneNode(true);
            const figcaption = document.createElement('figcaption');
            figcaption.setAttribute('contenteditable', 'false'); // 禁止原生編輯，交給懸浮選單
            figcaption.innerText = newImg.getAttribute('alt') || '';
            
            figure.appendChild(newImg);
            figure.appendChild(figcaption);
            
            // 將舊圖片替換成新結構
            img.parentNode.replaceChild(figure, img);
        });
        return tempDiv.innerHTML;
    }

    // --- Quill 客製化模組 (分隔線與帶有圖說的進階圖片) ---
    const BlockEmbed = Quill.import('blots/block/embed');
    
    // 客製化：分隔線
    class DividerBlot extends BlockEmbed {}
    DividerBlot.blotName = 'divider';
    DividerBlot.tagName = 'hr';
    Quill.register(DividerBlot);

    // 客製化：圖片與圖說 (Figure)
    class ImageFigureBlot extends BlockEmbed {
        static create(value) {
            const node = super.create();
            const img = document.createElement('img');
            img.setAttribute('src', typeof value === 'string' ? value : value.url);
            img.setAttribute('alt', value.caption || '');
            node.appendChild(img);

            const figcaption = document.createElement('figcaption');
            figcaption.innerText = value.caption || '';
            // 禁止 Quill 核心直接編輯這個區塊，統一由我們的懸浮選單控管
            figcaption.setAttribute('contenteditable', 'false');
            node.appendChild(figcaption);
            return node;
        }
        static value(node) {
            const img = node.querySelector('img');
            const figcaption = node.querySelector('figcaption');
            return {
                url: img ? img.getAttribute('src') : '',
                caption: figcaption ? figcaption.innerText : ''
            };
        }
        updateCaption(newCaption) {
            const img = this.domNode.querySelector('img');
            const figcaption = this.domNode.querySelector('figcaption');
            if (img) img.setAttribute('alt', newCaption);
            if (figcaption) figcaption.innerText = newCaption;
        }
    }
    ImageFigureBlot.blotName = 'imageFigure';
    ImageFigureBlot.tagName = 'figure';
    Quill.register(ImageFigureBlot);

    // 客製化：排版大引言
    const Block = Quill.import('blots/block');
    class PullquoteBlot extends Block {}
    PullquoteBlot.blotName = 'pullquote';
    PullquoteBlot.tagName = 'blockquote';
    PullquoteBlot.className = 'pullquote';
    Quill.register(PullquoteBlot);

    // --- Quill 編輯器初始化與單鍵切換邏輯 ---
    const toolbarOptions = {
        container: [
            ['header-cycle'], // 自訂 H 標題循環
            ['bold', 'italic', 'underline'], // 精簡文字格式
            [{ 'list': 'ordered'}, { 'list': 'bullet' }], // 補回列表功能
            ['quote-cycle'], // 自訂雙模式引言
            ['link', 'image', 'divider'], // 新增超連結與分隔線
            ['clean'] // 清除格式保留
        ],
        handlers: {
            'header-cycle': function() {
                const format = this.quill.getFormat();
                let nextHeader = false;
                if (!format.header) nextHeader = 1;
                else if (format.header === 1) nextHeader = 2;
                this.quill.format('header', nextHeader);
            },
            'quote-cycle': function() {
                const format = this.quill.getFormat();
                if (format.pullquote) {
                    this.quill.format('pullquote', false);
                } else if (format.blockquote) {
                    this.quill.format('blockquote', false);
                    this.quill.format('pullquote', true);
                } else {
                    this.quill.format('blockquote', true);
                }
            },
            'divider': function() {
                const range = this.quill.getSelection(true);
                this.quill.insertText(range.index, '\n', Quill.sources.USER);
                this.quill.insertEmbed(range.index + 1, 'divider', true, Quill.sources.USER);
                this.quill.setSelection(range.index + 2, Quill.sources.SILENT);
            }
        }
    };

    const quill = new Quill('#quill-editor', {
        theme: 'snow',
        placeholder: '開始創作你的精彩內容......',
        modules: { toolbar: toolbarOptions }
    });

    // 攔截圖片上傳，改為插入帶有圖說的 ImageFigure
    quill.getModule('toolbar').addHandler('image', function() {
        const input = document.createElement('input');
        input.setAttribute('type', 'file');
        input.setAttribute('accept', 'image/*');
        input.click();

        input.onchange = async () => {
            const file = input.files[0];
            if (/^image\//.test(file.type)) {
                const range = quill.getSelection(true);
                try {
                    const compressedBlob = await window.compressImage(file);
                    const fileName = `article_img_${Date.now()}.jpg`;
                    const { error: uploadError } = await supabase.storage.from('article_images').upload(fileName, compressedBlob, { contentType: 'image/jpeg' });
                    if (uploadError) throw uploadError;
                    const { data: publicUrlData } = supabase.storage.from('article_images').getPublicUrl(fileName);
                    
                    // 插入進化版的 imageFigure
                    quill.insertEmbed(range.index, 'imageFigure', { url: publicUrlData.publicUrl, caption: '' });
                    quill.setSelection(range.index + 1);
                } catch (err) {
                    alert('⚠️ 圖片上傳失敗：' + err.message);
                }
            }
        };
    });

    // --- 變數與 DOM 綁定 ---
    let selectedTags = [];
    let autoSaveTimeout;
    
    const articleListView = document.getElementById('article-list-view');
    const zenEditorView = document.getElementById('zen-editor-view');
    const publishModal = document.getElementById('publish-modal');
    const zenSaveStatus = document.getElementById('zen-save-status');

    const articleTitleInput = document.getElementById('article-title-input');
    const currentArticleIdInput = document.getElementById('current-article-id');
    
    const tagInput = document.getElementById('tag-input');
    const tagsContainer = document.getElementById('tags-container');
    const wordCountDisplay = document.getElementById('word-count-display');
    const readTimeDisplay = document.getElementById('read-time-display');

    const slugInput = document.getElementById('article-slug');
    const metaTitleInput = document.getElementById('article-meta-title');
    const metaDescInput = document.getElementById('article-meta-desc');

    // --- ✨ 懸浮互動選單：點擊圖片與水平線的行為管理 ✨ ---
    const editorOverlay = document.getElementById('editor-overlay');
    const overlayInput = document.getElementById('editor-overlay-input');
    const overlayDelete = document.getElementById('editor-overlay-delete');
    let currentTargetBlot = null;

    const hideOverlay = () => {
        editorOverlay.classList.add('hidden');
        editorOverlay.classList.remove('flex');
        
        // 移除高亮狀態
        document.querySelectorAll('.active-embed').forEach(el => el.classList.remove('active-embed'));
        currentTargetBlot = null;
    };

    quill.root.addEventListener('click', (e) => {
        let targetNode = null;
        let showInput = false;

        // 偵測點擊的是不是水平線或圖片(及其父層figure)
        if (e.target.tagName === 'HR') {
            targetNode = e.target;
        } else if (e.target.tagName === 'IMG' && e.target.closest('figure')) {
            targetNode = e.target.closest('figure');
            showInput = true;
            e.target.classList.add('active-embed'); // 增加亮色邊框回饋
        } else if (e.target.tagName === 'HR' || e.target.tagName === 'IMG') {
            // 防呆：如果是舊版純 img 也捕捉
            targetNode = e.target;
        }

        if (targetNode) {
            const blot = Quill.find(targetNode);
            if (!blot) return;
            
            currentTargetBlot = blot;
            if(targetNode.tagName === 'HR') targetNode.classList.add('active-embed');
            
            // 取得元素與容器的座標來計算懸浮選單的位置
            const bounds = targetNode.getBoundingClientRect();
            const scrollContainer = document.getElementById('zen-scroll-container');
            const containerBounds = scrollContainer.getBoundingClientRect();
            
            editorOverlay.classList.remove('hidden');
            editorOverlay.classList.add('flex');
            
            if (showInput) {
                overlayInput.classList.remove('hidden');
                const val = blot.value();
                overlayInput.value = val.caption || '';
                // 延遲聚焦避免衝突
                setTimeout(() => overlayInput.focus(), 50);
            } else {
                overlayInput.classList.add('hidden');
            }

            // 計算懸浮選單位置 (置中顯示在物件正上方)
            const overlayRect = editorOverlay.getBoundingClientRect();
            let top = bounds.top - containerBounds.top + scrollContainer.scrollTop - overlayRect.height - 15;
            let left = bounds.left - containerBounds.left + (bounds.width / 2) - (overlayRect.width / 2);
            
            // 如果上方空間不夠，就顯示在物件下方
            if (top < scrollContainer.scrollTop) top = bounds.bottom - containerBounds.top + scrollContainer.scrollTop + 15;

            editorOverlay.style.top = `${top}px`;
            editorOverlay.style.left = `${left}px`;
        } else {
            hideOverlay();
        }
    });

    // 監聽圖說輸入，即時更新 Blot 與畫面
    overlayInput.addEventListener('input', (e) => {
        if (currentTargetBlot && currentTargetBlot.updateCaption) {
            currentTargetBlot.updateCaption(e.target.value);
            triggerAutoSave();
        }
    });

    // 監聽刪除按鈕
    overlayDelete.addEventListener('click', () => {
        if (currentTargetBlot) {
            currentTargetBlot.remove();
            hideOverlay();
            triggerAutoSave();
        }
    });

    // 捲動或文字改變時，為了體驗流暢，自動隱藏懸浮選單
    document.getElementById('zen-scroll-container').addEventListener('scroll', hideOverlay);
    quill.on('text-change', hideOverlay);


    // --- 自動延展標題高度的魔法 ---
    function autoResizeTitle() {
        articleTitleInput.style.height = 'auto';
        articleTitleInput.style.height = articleTitleInput.scrollHeight + 'px';
    }
    articleTitleInput.addEventListener('input', autoResizeTitle);

    // --- 功能開關與預覽邏輯 ---
    const toggleNewList = document.getElementById('toggle-new-list');
    const btnPreviewNewList = document.getElementById('btn-preview-new-list');

    async function initFeatureToggle() {
        if (!toggleNewList) return;
        try {
            const { data, error } = await supabase.from('site_settings').select('setting_value').eq('setting_key', 'new_article_list_enabled').single();
            if (error && error.code !== 'PGRST116') throw error; 
            if (data) toggleNewList.checked = data.setting_value;
        } catch (err) {
            console.error('讀取功能開關失敗:', err);
        }
    }

    if (toggleNewList) {
        initFeatureToggle();
        toggleNewList.addEventListener('change', async (e) => {
            const isEnabled = e.target.checked;
            toggleNewList.disabled = true;
            try {
                const { error } = await supabase.from('site_settings').upsert({ id: 1, setting_key: 'new_article_list_enabled', setting_value: isEnabled });
                if (error) throw error;
                alert(isEnabled ? '✅ 新版前台文章列表已正式上線！' : '⏸️ 已切換回原本的方格子列表。');
            } catch (err) {
                alert('⚠️ 開關狀態更新失敗');
                e.target.checked = !isEnabled; 
            } finally {
                toggleNewList.disabled = false;
            }
        });
    }

    if (btnPreviewNewList) {
        btnPreviewNewList.addEventListener('click', () => {
            window.open('/new_articles.html', '_blank');
        });
    }

    // --- 標籤功能邏輯 ---
    function renderTags() {
        tagsContainer.innerHTML = '';
        selectedTags.forEach(tag => {
            const span = document.createElement('span');
            span.className = 'bg-[#333] text-gray-200 text-sm font-medium px-3 py-1.5 rounded flex items-center gap-2 border border-gray-600';
            span.innerHTML = `#${tag} <button type="button" class="hover:text-red-500 font-bold ml-1" onclick="removeTag('${tag}')">×</button>`;
            tagsContainer.appendChild(span);
        });
    }

    window.removeTag = (tagToRemove) => {
        selectedTags = selectedTags.filter(tag => tag !== tagToRemove);
        renderTags();
        triggerAutoSave();
    };

    tagInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            const tag = tagInput.value.trim().replace(/^#/, '');
            if (tag && !selectedTags.includes(tag)) {
                selectedTags.push(tag);
                renderTags();
                triggerAutoSave();
            }
            tagInput.value = '';
        }
    });

    // --- 字數統計與完美的獨立自動存檔系統 ---
    function triggerAutoSave() {
        zenSaveStatus.innerText = '⏳ 儲存中...';
        zenSaveStatus.classList.replace('text-gray-500', 'text-yellow-500');

        clearTimeout(autoSaveTimeout);
        // 將儲存間隔縮短為 0.5 秒，確保即打即存
        autoSaveTimeout = setTimeout(() => {
            const title = articleTitleInput.value;
            const htmlContent = quill.root.innerHTML;
            const id = currentArticleIdInput.value || '0';
            
            if(title || quill.getText().trim().length > 0) {
                const saveData = { title, htmlContent, tags: selectedTags, slug: slugInput.value, metaTitle: metaTitleInput.value, metaDesc: metaDescInput.value, timestamp: Date.now() };
                // 針對不同文章 ID 分別儲存，避免互相覆蓋
                localStorage.setItem(`dabao_article_autosave_${id}`, JSON.stringify(saveData));
            }
            
            zenSaveStatus.innerText = '🟢 已自動儲存';
            zenSaveStatus.classList.replace('text-yellow-500', 'text-gray-500');
        }, 500); 
    }

    function calculateStats() {
        const text = quill.getText().trim();
        const wordCount = text.length;
        wordCountDisplay.innerText = wordCount;
        readTimeDisplay.innerText = Math.ceil(wordCount / 350) || 1; 
    }

    quill.on('text-change', () => {
        calculateStats();
        triggerAutoSave();
    });
    
    articleTitleInput.addEventListener('input', triggerAutoSave);
    [slugInput, metaTitleInput, metaDescInput].forEach(el => el.addEventListener('input', triggerAutoSave));

    // --- 視圖切換 ---
    window.showArticleListView = () => {
        zenEditorView.classList.add('hidden');
        publishModal.classList.add('hidden');
    };

    window.showArticleEditView = () => {
        zenEditorView.classList.remove('hidden');
        calculateStats();
        setTimeout(autoResizeTitle, 10);
    };

    document.getElementById('btn-zen-back').addEventListener('click', () => {
        // 放棄未儲存內容時，不主動刪除 LocalStorage，當作保險備份
        if(confirm('尚未正式發布的內容已保存為本機草稿狀態，確定要返回列表嗎？')) {
            window.showArticleListView();
        }
    });

    document.getElementById('btn-zen-prepare-publish').addEventListener('click', () => {
        const title = articleTitleInput.value.trim();
        if (!title) return alert('⚠️ 請先為您的文章輸入一個霸氣的標題！');
        const htmlContent = quill.root.innerHTML;
        if(quill.getText().trim().length === 0 && !htmlContent.includes('<img')) {
            return alert('⚠️ 文章內容不能為空，多寫幾句吧！');
        }
        publishModal.classList.remove('hidden');
    });

    document.getElementById('btn-cancel-publish').addEventListener('click', () => {
        publishModal.classList.add('hidden');
    });

    // --- 資料載入 ---
    window.loadArticles = async () => {
        try {
            const { data, error } = await supabase.rpc('get_admin_articles');
            if (error) throw error;
            
            const tbody = document.getElementById('article-list-body');
            tbody.innerHTML = '';
            
            if(document.getElementById('stat-published')) {
                const publishedCount = data.filter(a => a.status === 'published').length;
                const draftCount = data.filter(a => a.status === 'draft').length;
                const totalViews = data.reduce((sum, a) => sum + (a.view_count || 0), 0);
                document.getElementById('stat-published').innerText = publishedCount;
                document.getElementById('stat-drafts').innerText = draftCount;
                document.getElementById('stat-views').innerText = totalViews;
            }

            if(!data || data.length === 0){
                document.getElementById('article-table').classList.add('hidden');
                document.getElementById('article-empty-state').classList.remove('hidden');
                return;
            }

            document.getElementById('article-table').classList.remove('hidden');
            document.getElementById('article-empty-state').classList.add('hidden');

            data.forEach(item => {
                const statusHtml = item.status === 'published' 
                    ? '<span class="bg-green-100 text-green-800 text-xs font-bold px-2 py-1 rounded">已發布</span>'
                    : '<span class="bg-orange-100 text-orange-800 text-xs font-bold px-2 py-1 rounded">草稿</span>';
                
                const tr = document.createElement('tr');
                tr.className = 'border-b hover:bg-blue-50 cursor-pointer transition-colors';
                tr.onclick = () => editArticle(item.id);
                
                tr.innerHTML = `
                    <td class="py-3 px-4 text-gray-800 font-medium">${item.title}</td>
                    <td class="py-3 px-4">${statusHtml}</td>
                    <td class="py-3 px-4 text-gray-500">${item.view_count || 0} 次</td>
                    <td class="py-3 px-4 text-gray-500">${new Date(item.created_at).toLocaleDateString('zh-TW')}</td>
                    <td class="py-3 px-4 text-center">
                        <button onclick="event.stopPropagation(); editArticle(${item.id})" class="text-blue-600 hover:text-blue-800 font-medium mr-3 focus:outline-none">編輯</button>
                        <button onclick="event.stopPropagation(); deleteArticle(${item.id})" class="text-red-500 hover:text-red-700 font-medium focus:outline-none">刪除</button>
                    </td>
                `;
                tbody.appendChild(tr);
            });
        } catch (err) { console.error(err); }
    };

    // --- 新增 / 編輯 / 儲存 ---
    document.getElementById('btn-create-article').addEventListener('click', () => {
        currentArticleIdInput.value = '0';
        articleTitleInput.value = '';
        slugInput.value = '';
        metaTitleInput.value = '';
        metaDescInput.value = '';
        quill.root.innerHTML = ''; 
        selectedTags = [];
        renderTags();

        // 獨立檢查 ID 為 0 的新文章草稿
        const autoSaved = localStorage.getItem('dabao_article_autosave_0');
        if (autoSaved) {
            if (confirm('偵測到您有尚未發布的暫存內容，是否要恢復上次的寫作進度？')) {
                const data = JSON.parse(autoSaved);
                articleTitleInput.value = data.title || '';
                // 載入時自動升級舊圖片結構
                quill.root.innerHTML = upgradeOldImages(data.htmlContent || '');
                selectedTags = data.tags || [];
                slugInput.value = data.slug || '';
                metaTitleInput.value = data.metaTitle || '';
                metaDescInput.value = data.metaDesc || '';
                renderTags();
            } else {
                localStorage.removeItem('dabao_article_autosave_0');
            }
        }
        window.showArticleEditView();
    });

    async function executeSave(statusStr, btnElement, originalBtnText) {
        const title = articleTitleInput.value.trim();
        const id = parseInt(currentArticleIdInput.value, 10);
        const htmlContent = quill.root.innerHTML;

        btnElement.innerText = '處理中...';
        btnElement.disabled = true;

        try {
            const { error } = await supabase.rpc('save_article_v2', {
                p_id: id,
                p_title: title,
                p_content: { html: htmlContent },
                p_status: statusStr,
                p_slug: slugInput.value.trim() || null,
                p_meta_title: metaTitleInput.value.trim() || null,
                p_meta_description: metaDescInput.value.trim() || null,
                p_word_count: parseInt(wordCountDisplay.innerText, 10),
                p_read_time: parseInt(readTimeDisplay.innerText, 10),
                p_tags: selectedTags
            });
            if (error) throw error;
            
            // 成功儲存後，清除專屬 ID 的本地暫存
            localStorage.removeItem(`dabao_article_autosave_${id}`);
            alert(statusStr === 'published' ? '✅ 文章已成功正式發布！' : '✅ 文章已安穩存入草稿箱！');
            
            window.loadArticles();
            window.showArticleListView();
        } catch (err) {
            alert('⚠️ 儲存發生錯誤：' + err.message);
        } finally {
            btnElement.innerText = originalBtnText;
            btnElement.disabled = false;
        }
    }

    document.getElementById('btn-save-draft').addEventListener('click', function() {
        executeSave('draft', this, '存為草稿');
    });

    document.getElementById('btn-publish-article').addEventListener('click', function() {
        executeSave('published', this, '正式發布');
    });

    window.editArticle = async (id) => {
        try {
            // 優先檢查是否有此 ID 的本地草稿
            const autoSaved = localStorage.getItem(`dabao_article_autosave_${id}`);
            let useAutoSave = false;
            if (autoSaved) {
                useAutoSave = confirm('系統偵測到您上次有修改但未發布的暫存進度，是否要恢復？\n(若選擇取消，將放棄修改並讀取資料庫最新版本)');
                if (!useAutoSave) {
                    localStorage.removeItem(`dabao_article_autosave_${id}`);
                }
            }

            const { data: articleData, error: articleError } = await supabase.from('articles').select('*').eq('id', id).single();
            if (articleError) throw articleError;
            
            const { data: tagData, error: tagError } = await supabase.from('article_tags').select('tags(name)').eq('article_id', id);
            if (tagError) throw tagError;

            currentArticleIdInput.value = articleData.id;
            
            if (useAutoSave) {
                const data = JSON.parse(autoSaved);
                articleTitleInput.value = data.title || '';
                // 載入草稿時自動升級舊圖片結構
                quill.root.innerHTML = upgradeOldImages(data.htmlContent || '');
                selectedTags = data.tags || [];
                slugInput.value = data.slug || '';
                metaTitleInput.value = data.metaTitle || '';
                metaDescInput.value = data.metaDesc || '';
            } else {
                articleTitleInput.value = articleData.title;
                slugInput.value = articleData.slug || '';
                metaTitleInput.value = articleData.meta_title || '';
                metaDescInput.value = articleData.meta_description || '';
                // 載入資料庫舊資料時自動升級舊圖片結構
                quill.root.innerHTML = upgradeOldImages(articleData.content.html || '');
                selectedTags = tagData.map(t => t.tags.name);
            }
            
            renderTags();
            window.showArticleEditView();
        } catch (err) {
            alert('⚠️ 無法載入文章資料');
        }
    };

    window.deleteArticle = async (id) => {
        if(!confirm('確定要永久刪除這篇文章嗎？此動作無法復原！')) return;
        try {
            const { error } = await supabase.from('articles').delete().eq('id', id);
            if (error) throw error;
            // 刪除文章時，順便把殘留的草稿清掉
            localStorage.removeItem(`dabao_article_autosave_${id}`);
            window.loadArticles();
        } catch (err) {
            alert('⚠️ 刪除發生錯誤：' + err.message);
        }
    };

    // --- AI 自動產生 SEO 邏輯 ---
    document.getElementById('btn-ai-seo').addEventListener('click', async function() {
        const textContent = quill.getText().trim();
        if (textContent.length < 50) return alert('⚠️ 文章內容太少，AI 無法為您分析摘要喔！請多寫一點再試試。');

        const originalText = this.innerText;
        this.innerText = '✨ 伺服器 AI 分析生成中...';
        this.disabled = true;

        try {
            const response = await fetch(`${window.supabaseUrl}/functions/v1/generate-seo`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${window.supabaseKey}`,
                    'apikey': window.supabaseKey
                },
                body: JSON.stringify({ textContent: textContent })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || `HTTP error! status: ${response.status}`);
            }

            const data = await response.json();

            if (data.slug) slugInput.value = data.slug;
            if (data.meta_title) metaTitleInput.value = data.meta_title;
            if (data.meta_description) metaDescInput.value = data.meta_description;
            
            triggerAutoSave();
            alert('✅ 伺服器已成功為您生成完美的 SEO 設定！');

        } catch (err) {
            console.error(err);
            alert('⚠️ 產生失敗：' + err.message);
        } finally {
            this.innerText = originalText;
            this.disabled = false;
        }
    });
});