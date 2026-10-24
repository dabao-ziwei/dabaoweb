// Enable only after the CMS backend and allowed public origin have been approved.
window.DabaoCmsConfig = {
    enabled: true,
    provider: 'supabase',
    apiBase: 'https://uwktzlxlduqyjyoolgrs.supabase.co/functions/v1/dabao-cms',
    pollSeconds: 60
};
window.DabaoCmsPreview = new URLSearchParams(location.search).get('cms-preview') === '1';
