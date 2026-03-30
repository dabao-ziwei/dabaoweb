document.addEventListener('DOMContentLoaded', () => {
    const supabase = window.supabaseDB;
    
    // --- ✨ 舊圖自動升級魔法 ✨ ---
    function upgradeOldImages(html) {
        if (!html) return '';
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        const images = tempDiv.querySelectorAll('img');
        images.forEach(img => {
            if (img.closest('figure')) return;
            
            const figure = document.createElement('figure');
            const newImg = img.cloneNode(true);
            const figcaption = document.createElement('figcaption');
            figcaption.setAttribute('contenteditable', 'false');
            
            const oldAlt = newImg.getAttribute('alt') || '';
            figcaption.innerText = oldAlt; 
            newImg.setAttribute('alt', oldAlt);
            
            figure.appendChild(newImg);
            figure.appendChild(figcaption);
            
            img.parentNode.replaceChild(figure, img);
        });
        return tempDiv.innerHTML;
    }

    // --- Quill 客製化模組 ---
    const BlockEmbed = Quill.import('blots/block/embed');
    
    class DividerBlot extends BlockEmbed {}
    DividerBlot.blotName = 'divider';
    DividerBlot.tagName = 'hr';
    Quill.register(DividerBlot);

    class ImageFigureBlot extends BlockEmbed {
        static create(value) {
            const node = super.create();
            const img = document.createElement('img');
            img.setAttribute('src', typeof value === 'string' ? value : value.url);
            img.setAttribute('alt', value.altText || '');
            node.appendChild(img);

            const figcaption = document.createElement('figcaption');
            figcaption.innerText = value.caption || '';
            figcaption.setAttribute('contenteditable', 'false');
            node.appendChild(figcaption);
            return node;
        }
        static value(node) {
            const img = node.querySelector('img');
            const figcaption = node.querySelector('figcaption');
            return {
                url: img ? img.getAttribute('src') : '',
                altText: img ? img.getAttribute('alt') : '',
                caption: figcaption ? figcaption.innerText : ''
            };
        }
        updateData(newCaption, newAltText) {
            const img = this.domNode.querySelector('img');
            const figcaption = this.domNode.querySelector('figcaption');
            if (img) img.setAttribute('alt', newAltText);
            if (figcaption) figcaption.innerText = newCaption;
        }
    }
    ImageFigureBlot.blotName = 'imageFigure';
    ImageFigureBlot.tagName = 'figure';
    Quill.register(ImageFigureBlot);

    const Block = Quill.import('blots/block');
    class PullquoteBlot extends Block {}
    PullquoteBlot.blotName = 'pullquote';
    PullquoteBlot.tagName = 'blockquote';
    PullquoteBlot.className = 'pullquote';
    Quill.register(PullquoteBlot);

    // --- Quill 編輯器初始化 ---
    const toolbarOptions = {
        container: [
            ['header-cycle'], 
            ['bold', 'italic', 'underline'], 
            [{ 'list': 'ordered'}, { 'list': 'bullet' }], 
            ['quote-cycle'], 
            ['link', 'image', 'divider'], 
            ['clean'] 
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
                    
                    quill.insertEmbed(range.index, 'imageFigure', { url: publicUrlData.publicUrl, altText: '', caption: '' });
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

    // --- ✨ [補回] 功能開關與預覽邏輯 ✨ ---
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

    // --- ✨ 懸浮互動選單 ---
    const editorOverlay = document.getElementById('editor-overlay');
    const overlayCaption = document.getElementById('editor-overlay-caption');
    const overlayAlt = document.getElementById('editor-overlay-alt');
    const overlaySave = document.getElementById('editor-overlay-save');
    const overlayDelete = document.getElementById('editor-overlay-delete');
    const overlayImageSettings = document.getElementById('editor-overlay-image-settings');
    const overlayTypeLabel = document.getElementById('editor-overlay-type-label');
    
    let currentTargetBlot = null;

    const hideOverlay = () => {
        if (editorOverlay.contains(document.activeElement)) return;
        
        editorOverlay.classList.add('hidden');
        editorOverlay.classList.remove('flex');
        document.querySelectorAll('.active-embed').forEach(el => el.classList.remove('active-embed'));
        currentTargetBlot = null;
    };

    editorOverlay.addEventListener('click', (e) => e.stopPropagation());

    quill.root.addEventListener('click', (e) => {
        let targetNode = null;
        let showImageSettings = false;

        if (e.target.tagName === 'HR') {
            targetNode = e.target;
            overlayTypeLabel.innerText = '分隔線設定';
        } else if (e.target.tagName === 'IMG' && e.target.closest('figure')) {
            targetNode = e.target.closest('figure');
            showImageSettings = true;
            e.target.classList.add('active-embed'); 
            overlayTypeLabel.innerText = '圖片設定';
        } else if (e.target.tagName === 'HR' || e.target.tagName === 'IMG') {
            targetNode = e.target;
        }

        if (targetNode) {
            const blot = Quill.find(targetNode);
            if (!blot) return;
            
            currentTargetBlot = blot;
            if(targetNode.tagName === 'HR') targetNode.classList.add('active-embed');
            
            const bounds = targetNode.getBoundingClientRect();
            const scrollContainer = document.getElementById('zen-scroll-container');
            const containerBounds = scrollContainer.getBoundingClientRect();
            
            editorOverlay.classList.remove('hidden');
            editorOverlay.classList.add('flex');
            
            if (showImageSettings) {
                overlayImageSettings.classList.remove('hidden');
                overlayImageSettings.classList.add('flex');
                const val = blot.value();
                overlayCaption.value = val.caption || '';
                overlayAlt.value = val.altText || '';
            } else {
                overlayImageSettings.classList.add('hidden');
                overlayImageSettings.classList.remove('flex');
            }

            const overlayRect = editorOverlay.getBoundingClientRect();
            let top = bounds.top - containerBounds.top + scrollContainer.scrollTop - overlayRect.height - 15;
            let left = bounds.left - containerBounds.left + (bounds.width / 2) - (overlayRect.width / 2);
            
            if (top < scrollContainer.scrollTop) top = bounds.bottom - containerBounds.top + scrollContainer.scrollTop + 15;

            editorOverlay.style.top = `${top}px`;
            editorOverlay.style.left = `${left}px`;
        } else {
            hideOverlay();
        }
    });

    overlaySave.addEventListener('click', () => {
        if (currentTargetBlot && currentTargetBlot.updateData) {
            currentTargetBlot.updateData(overlayCaption.value, overlayAlt.value);
            triggerAutoSave();
            
            const originalText = overlaySave.innerText;
            overlaySave.innerText = '✅ 已更新！';
            setTimeout(() => {
                overlaySave.innerText = originalText;
                editorOverlay.classList.add('hidden');
                editorOverlay.classList.remove('flex');
                document.querySelectorAll('.active-embed').forEach(el => el.classList.remove('active-embed'));
            }, 800);
        }
    });

    overlayDelete.addEventListener('click', () => {
        if (currentTargetBlot) {
            currentTargetBlot.remove();
            editorOverlay.classList.add('hidden');
            editorOverlay.classList.remove('flex');
            triggerAutoSave();
        }
    });

    document.getElementById('zen-scroll-container').addEventListener('scroll', () => {
        if (!editorOverlay.contains(document.activeElement)) hideOverlay();
    });
    quill.on('text-change', () => {
        if (!editorOverlay.contains(document.activeElement)) hideOverlay();
    });

    // --- 自動延展標題高度 ---
    function autoResizeTitle() {
        articleTitleInput.style.height = 'auto';
        articleTitleInput.style.height = articleTitleInput.scrollHeight + 'px';
    }
    articleTitleInput.addEventListener('input', autoResizeTitle);

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

    // --- 自動存檔 ---
    function triggerAutoSave() {
        zenSaveStatus.innerText = '⏳ 儲存中...';
        zenSaveStatus.classList.replace('text-gray-500', 'text-yellow-500');

        clearTimeout(autoSaveTimeout);
        autoSaveTimeout = setTimeout(() => {
            const title = articleTitleInput.value;
            const htmlContent = quill.root.innerHTML;
            const id = currentArticleIdInput.value || '0';
            
            if(title || quill.getText().trim().length > 0) {
                const saveData = { title, htmlContent, tags: selectedTags, slug: slugInput.value, metaTitle: metaTitleInput.value, metaDesc: metaDescInput.value, timestamp: Date.now() };
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
            const { data, error } = await supabase
                .from('articles')
                .select('*')
                .order('created_at', { ascending: false });
                
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

    // --- ✨ 核心防呆：新增 / 編輯 ✨ ---
    document.getElementById('btn-create-article').addEventListener('click', () => {
        currentArticleIdInput.value = '0';
        articleTitleInput.value = '';
        slugInput.value = '';
        metaTitleInput.value = '';
        metaDescInput.value = '';
        
        quill.setText('');
        
        selectedTags = [];
        renderTags();

        try {
            const autoSaved = localStorage.getItem('dabao_article_autosave_0');
            if (autoSaved) {
                if (confirm('偵測到您有尚未發布的暫存內容，是否要恢復上次的寫作進度？')) {
                    const data = JSON.parse(autoSaved);
                    articleTitleInput.value = data.title || '';
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
        } catch (e) {
            console.warn('草稿解析失敗，已自動清除毀損資料。', e);
            localStorage.removeItem('dabao_article_autosave_0');
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
            const autoSaved = localStorage.getItem(`dabao_article_autosave_${id}`);
            let useAutoSave = false;
            let autoSaveData = null;

            if (autoSaved) {
                try {
                    autoSaveData = JSON.parse(autoSaved);
                    useAutoSave = confirm('系統偵測到您上次有修改但未發布的暫存進度，是否要恢復？\n(若選擇取消，將放棄修改並讀取資料庫最新版本)');
                    if (!useAutoSave) {
                        localStorage.removeItem(`dabao_article_autosave_${id}`);
                    }
                } catch (e) {
                    console.warn('草稿解析失敗，已自動清除毀損資料。', e);
                    localStorage.removeItem(`dabao_article_autosave_${id}`);
                }
            }

            const { data: articleData, error: articleError } = await supabase.from('articles').select('*').eq('id', id).single();
            if (articleError) throw articleError;
            
            const { data: tagData, error: tagError } = await supabase.from('article_tags').select('tags(name)').eq('article_id', id);
            if (tagError) throw tagError;

            currentArticleIdInput.value = articleData.id;
            
            if (useAutoSave && autoSaveData) {
                articleTitleInput.value = autoSaveData.title || '';
                quill.root.innerHTML = upgradeOldImages(autoSaveData.htmlContent || '');
                selectedTags = autoSaveData.tags || [];
                slugInput.value = autoSaveData.slug || '';
                metaTitleInput.value = autoSaveData.metaTitle || '';
                metaDescInput.value = autoSaveData.metaDesc || '';
            } else {
                articleTitleInput.value = articleData.title;
                slugInput.value = articleData.slug || '';
                metaTitleInput.value = articleData.meta_title || '';
                metaDescInput.value = articleData.meta_description || '';
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