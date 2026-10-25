(async () => {
    const config=window.DabaoCmsConfig;
    if(window.DabaoSiteMetricsInstalled||!config?.enabled||config.provider!=='supabase'||
        window.DabaoCmsPreview||new URLSearchParams(location.search).has('cms-preview')||
        (location.hostname!=='dabao.life'&&location.hostname!=='www.dabao.life'&&!config.localMetricsQA))return;
    window.DabaoSiteMetricsInstalled=true;
    // Draft iframes have opaque origins. Return before importing any module;
    // previews need neither CORS exceptions nor a connection to analytics.
    const {pageForPath,locations}=await import('./site-metrics-catalog.mjs');
    const page=pageForPath(location.pathname);if(!page)return;
    const base=config.apiBase.replace(/\/$/,''),queue=[];
    let enabled=null;
    // No cookies, identifiers, URL parameters or retries. A slow/offline metrics
    // service must never delay navigation, authentication or content rendering.
    function send(event) {
        fetch(base+'/api/public/metrics',{method:'POST',credentials:'omit',keepalive:true,referrerPolicy:'no-referrer',
            headers:{'Content-Type':'text/plain;charset=UTF-8'},body:JSON.stringify(event)})
            .catch(()=>{});
    }
    function record(action,target='none',where='content') {
        const event={page,action,target,location:where};
        if(enabled===true)send(event);
        else if(enabled===null&&queue.length<20)queue.push(event);
    }
    function capability(data) {
        enabled=data?.metrics?.enabled===true&&data.metrics.version===1;
        const pending=queue.splice(0);
        if(enabled)pending.forEach(send);
    }
    function position(element) {
        const explicit=element.closest('[data-location]')?.dataset.location||element.dataset.label;
        const alias={'service-guide':'guide','other-services':'other_services','booking-page':'content'};
        if(explicit&&Object.hasOwn(locations,alias[explicit]||explicit))return alias[explicit]||explicit;
        if(element.closest('footer'))return 'footer';
        if(element.closest('nav'))return 'navigation';
        if(element.closest('#sticky-cta'))return 'sticky';
        if(element.closest('.faq-list,.lp-faq,.faq-section'))return 'faq';
        if(element.matches('.home-feedback'))return 'testimonials';
        const section=element.closest('section');
        const id=section?.id;
        if(id==='final-cta'||section?.matches('.lp-final,.final-section'))return 'final';
        if(id==='student-story')return 'testimonials';
        if(section?.matches('.lp-hero,.chart-hero'))return 'hero';
        return Object.hasOwn(locations,id)?id:'content';
    }
    function destination(element) {
        if(element.matches('#testimonial-more'))return 'testimonials';
        if(element.matches('.home-feedback'))return 'testimonial_image';
        if(element.matches('summary'))return !element.parentElement.open&&element.closest('#faq,.lp-faq,.faq-section,.faq-list')?'faq_expand':null;
        if(!element.matches('a[href]'))return null;
        let url;try{url=new URL(element.href,location.href);}catch{return null;}
        if(!['http:','https:'].includes(url.protocol))return null;
        if(url.hostname==='lin.ee'||url.hostname==='line.me')return 'line';
        if(element.matches('.js-line-cta,[data-enrollment-signup]'))return 'course_signup';
        if(url.hostname==='ziweiapp.dabao.life')return url.pathname.replace(/\/$/,'')==='/booking'?'booking_system':'chart_system';
        if(['threads.net','www.threads.net','threads.com','www.threads.com'].includes(url.hostname))return 'threads';
        if(['instagram.com','www.instagram.com'].includes(url.hostname))return 'instagram';
        if(url.hostname==='vocus.cc')return 'article_external';
        if(url.origin!==location.origin&&!['dabao.life','www.dabao.life'].includes(url.hostname))return null;
        const anchors={'#services':'services','#service-guide':'guide','#complete-reading':'complete','#annual-reading':'annual',
            '#divination':'divination','#enrollment':'enrollment','#learning-path':'learning_path','#student-story':'testimonials'};
        if(anchors[url.hash])return anchors[url.hash];
        const destinationPage=pageForPath(url.pathname);
        if(destinationPage==='booking'){
            const service=url.searchParams.get('service');
            if(['complete','annual','divination'].includes(service))return 'booking_'+service;
        }
        return destinationPage||null;
    }
    function click(event) {
        if(event.type==='auxclick'&&event.button!==1)return;
        const element=event.target.closest?.('a[href],#testimonial-more,.home-feedback,summary');
        if(!element)return;
        const target=destination(element);
        if(target)record('click',target,position(element));
    }
    document.addEventListener('click',click,true);
    document.addEventListener('auxclick',click,true);
    record('view');
    window.addEventListener('pageshow',event=>{if(event.persisted)record('view');});
    window.DabaoCMS?.subscribe(capability);
    // Existing/disabled CMS versions never advertise collection capability.
    // Do not send to an endpoint that has not yet been enabled server-side.
    window.DabaoCMS?.ready.then(capability).catch(()=>capability(null));
})().catch(()=>{});
