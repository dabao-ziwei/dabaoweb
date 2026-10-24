// Enable only after the CMS backend and allowed public origin have been approved.
window.DabaoCmsConfig = { enabled: false, apiBase: '', pollSeconds: 60 };
window.DabaoCmsPreview = new URLSearchParams(location.search).get('cms-preview') === '1';
