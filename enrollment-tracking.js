(() => {
    const track=(name,label)=>{
        if(window.DabaoCmsPreview||typeof window.gtag!=='function')return;
        window.gtag('event',name,{event_category:'course_enrollment',event_label:label,course_name:window.DabaoCourse?.data.courseName||'',cohort_id:window.DabaoCourse?.cohort?.id||''});
    };
    document.querySelector('[data-enrollment-signup]')?.addEventListener('click',()=>track('generate_lead','enrollment'));
    const price=document.querySelector('.enrollment-public-price');
    if(price&&'IntersectionObserver' in window){const observer=new IntersectionObserver(entries=>{if(entries.some(e=>e.isIntersecting)){track('view_pricing','pricing_section');observer.disconnect();}},{threshold:.5});observer.observe(price);}
})();
