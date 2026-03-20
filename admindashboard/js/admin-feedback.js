document.addEventListener('DOMContentLoaded', () => {
    const supabase = window.supabaseDB;
    const fileInput = document.getElementById('feedback-file-input');
    const btnUploadFeedback = document.getElementById('btn-upload-feedback');
    const feedbackList = document.getElementById('feedback-list');

    window.loadFeedbacks = async () => {
        try {
            const { data, error } = await supabase.from('feedbacks').select('*').order('created_at', { ascending: false });
            if (error) throw error;
            
            feedbackList.innerHTML = '';
            if(data.length === 0){
                feedbackList.innerHTML = '<p class="text-gray-500 col-span-full">目前還沒有上傳任何回饋圖片。</p>';
                return;
            }

            data.forEach(item => {
                const div = document.createElement('div');
                div.className = 'relative group border rounded overflow-hidden bg-white shadow-sm';
                div.innerHTML = `
                    <img src="${item.image_url}" class="w-full h-32 object-cover">
                    <div class="absolute inset-0 bg-black bg-opacity-50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition duration-200">
                        <button onclick="deleteFeedback(${item.id}, '${item.image_url}')" class="bg-red-500 hover:bg-red-600 text-white text-xs font-bold py-1 px-3 rounded">刪除</button>
                    </div>
                `;
                feedbackList.appendChild(div);
            });
        } catch (err) {
            feedbackList.innerHTML = '<p class="text-red-500 col-span-full">載入失敗，請確認資料庫權限是否已開啟。</p>';
        }
    };

    btnUploadFeedback.addEventListener('click', async () => {
        const file = fileInput.files[0];
        if (!file) return alert('⚠️ 請先選擇一張圖片！');

        btnUploadFeedback.innerText = '壓縮與上傳中...';
        btnUploadFeedback.disabled = true;

        try {
            const compressedBlob = await window.compressImage(file);
            const fileName = `feedback_${Date.now()}.jpg`;

            const { error: uploadError } = await supabase.storage.from('feedback_images').upload(fileName, compressedBlob, { contentType: 'image/jpeg' });
            if (uploadError) throw uploadError;

            const { data: publicUrlData } = supabase.storage.from('feedback_images').getPublicUrl(fileName);
            const { error: rpcError } = await supabase.rpc('add_feedback', { img_url: publicUrlData.publicUrl });
            if (rpcError) throw new Error('寫入資料庫失敗');

            alert('✅ 圖片上傳成功！');
            fileInput.value = ''; 
            window.loadFeedbacks(); 
        } catch (err) {
            alert('⚠️ 上傳發生錯誤：' + err.message);
        } finally {
            btnUploadFeedback.innerText = '上傳圖片';
            btnUploadFeedback.disabled = false;
        }
    });

    window.deleteFeedback = async (id, imageUrl) => {
        if(!confirm('確定要刪除這張回饋圖嗎？')) return;
        try {
            const fileName = imageUrl.split('/').pop();
            await supabase.storage.from('feedback_images').remove([fileName]);
            const { error } = await supabase.rpc('delete_feedback', { target_id: id });
            if (error) throw error;
            window.loadFeedbacks(); 
        } catch (err) {
            alert('⚠️ 刪除發生錯誤：' + err.message);
        }
    };
});