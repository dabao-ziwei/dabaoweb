(() => {
    const config=window.DabaoCmsConfig;
    if(!config?.enabled||!config.apiBase)return;
    const target=new URL('/admin/',config.apiBase).href;
    document.getElementById('legacy-status').textContent='後台已改用伺服器驗證登入';
    const link=document.getElementById('legacy-entry');link.href=target;link.hidden=false;
    location.replace(target);
})();
