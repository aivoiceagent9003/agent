// Local browser regression checks. HTTP APIs, Google identity and voice sockets
// are intercepted; this never submits a lead or starts a real voice session.
// Start the frontend on 127.0.0.1:5180 first. Requires Playwright with Edge;
// PLAYWRIGHT_MODULE may point to a bundled installation instead of node_modules.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const output = path.resolve(__dirname, '../ui-review');
fs.mkdirSync(output, {recursive:true});
const apiRequests = [], voiceMessages = [], errors = [];
let contactFails = true;
let instant = {enabled:true,url:'https://example.test/api/events/instant/ui-test',token:'test-only-token',header:'X-Instant-Token',presets:['generic','zoho','salesforce','meta_lead_ads'],active_preset:'zoho',from_number:'+12025550124',skip_recent_days:30,skip_statuses:[]};
const me = {user_id:'ui-test',role:'client',tenant_role:'owner',email:'ui-test@example.test',full_name:'Test Owner',permissions:['calls:read','leads:read','campaigns:read','campaigns:write','knowledge:read','whatsapp:read','agent:write'],tenant:{id:'ui-test',name:'Preview workspace',business_name:'Preview workspace',phone_number:'+12025550124',status:'published'}};
(async()=>{
  const browser=await chromium.launch({channel:'msedge',headless:true,args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000},permissions:['microphone']});
    await context.addInitScript(()=>{
      window.__API_BASE__='http://127.0.0.1:3999';
      window.google={accounts:{id:{initialize(config){window.__testGoogleCallback=config.callback;},renderButton(el){const b=document.createElement('button');b.textContent='Sign in with Google';b.onclick=()=>window.__testGoogleCallback({credential:'ui-test-google'});el.append(b);}}}};
    });
    await context.route('**/api/**',async route=>{
      const req=route.request(),url=new URL(req.url());
      const body=req.postDataJSON();
      apiRequests.push({path:url.pathname,method:req.method(),query:url.search,body});
      let data={},status=200;
      if(url.pathname==='/api/public/demo/sectors')data=[];
      else if(url.pathname==='/api/public/contact'){status=contactFails?500:200;data=contactFails?{error:'Test submission failed. Try again.'}:{success:true};}
      else if(url.pathname==='/api/auth/login'||url.pathname==='/api/auth/google'){status=401;data={error:'Test account: sign-in refused'};}
      else if(url.pathname==='/api/client/me')data=me;
      else if(url.pathname==='/api/client/instant-call'){
        if(req.method()==='PUT')instant={...instant,...body,active_preset:body.preset||instant.active_preset};
        data=instant;
      }
      else if(url.pathname==='/api/client/messages')data={conversations:[],total_unread:0};
      else if(url.pathname==='/api/client/notifications')data={notifications:[],unread_count:0};
      else if(url.pathname==='/api/client/calls')data={calls:[],total:0};
      await route.fulfill({status,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(data)});
    });
    await context.routeWebSocket('**/demo-stream',socket=>socket.onMessage(raw=>{
      const msg=JSON.parse(String(raw));
      if(msg.event!=='media')voiceMessages.push(msg);
      if(msg.event==='start')socket.send(JSON.stringify({event:'started',maxSeconds:90}));
    }));
    await context.routeWebSocket('**/messages-stream*',socket=>socket.send(JSON.stringify({type:'ready'})));
    const page=await context.newPage();
    page.on('pageerror',e=>errors.push(e.message));
    const ready=async()=>{
      await page.locator('h1').first().waitFor({timeout:60000});
      await page.evaluate(()=>document.fonts.ready);
      await page.waitForTimeout(1100);
    };
    const capture=async name=>page.screenshot({path:path.join(output,name+'.png'),fullPage:false});
    const fits=async label=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${label}: horizontal overflow`);
    await page.goto('http://127.0.0.1:5180/');await ready();await fits('public desktop');await capture('public-desktop');
    assert.equal(await page.locator('.forest-hero-wrap canvas.voice-wave').count(),1);
    await page.getByRole('button',{name:'Talk to Priya',exact:true}).click();
    await page.getByRole('button',{name:'End call',exact:true}).first().waitFor();
    await page.getByRole('button',{name:'End call',exact:true}).first().click();
    assert(voiceMessages.some(m=>m.event==='start'&&m.start.sector==='vocera'));
    assert(voiceMessages.some(m=>m.event==='stop'));
    await page.getByLabel('Your name').fill('UI Test');
    await page.getByLabel('Company',{exact:true}).fill('Test Company');
    await page.getByLabel('Work email').fill('test@example.test');
    await page.getByLabel('Phone (optional)').fill('+12025550123');
    await page.getByLabel('What do you want to use AnswerLabs for?').fill('A test enquiry');
    await page.getByRole('button',{name:'Request a demo',exact:true}).click();
    await page.getByText('Test submission failed. Try again.').waitFor();
    assert.equal(await page.getByLabel('Your name').inputValue(),'UI Test');
    contactFails=false;
    await page.getByRole('button',{name:'Request a demo',exact:true}).click();
    await page.waitForFunction(()=>document.getElementById('demo-name').value==='');
    assert(apiRequests.some(r=>r.path==='/api/public/contact'&&r.method==='POST'&&r.body.message.includes('Phone: +12025550123')));
    await page.goto('http://127.0.0.1:5180/login');await ready();await capture('login-desktop');
    await page.setViewportSize({width:1024,height:768});
    assert(await page.evaluate(()=>document.querySelector('.forest-login-orb').getBoundingClientRect().bottom <= document.querySelector('.forest-login-quote').getBoundingClientRect().top),'Login sculpture overlaps quote');
    await page.setViewportSize({width:1440,height:1000});
    await page.getByRole('tab',{name:'Employee',exact:true}).click();
    await page.getByText('Sign in with your invite credentials.').waitFor();
    await page.getByRole('tab',{name:'Business',exact:true}).click();
    await page.getByLabel('Email address',{exact:true}).fill('test@example.test');
    await page.getByLabel('Password',{exact:true}).fill('not-a-real-password');
    await page.getByRole('button',{name:'Show password',exact:true}).click();
    assert.equal(await page.locator('#password').getAttribute('type'),'text');
    await page.getByRole('button',{name:'Sign in',exact:true}).click();
    await page.getByText('Test account: sign-in refused').first().waitFor();
    assert(apiRequests.some(r=>r.path==='/api/auth/login'&&r.body.email==='test@example.test'));
    const google=page.getByRole('button',{name:'Sign in with Google',exact:true});
    if(await google.count()){await google.click();await page.waitForTimeout(500);assert(apiRequests.some(r=>r.path==='/api/auth/google'&&r.body.credential==='ui-test-google'));}
    await page.evaluate(()=>localStorage.setItem('vocera_token','ui-test-not-a-real-session'));
    await page.goto('http://127.0.0.1:5180/app/instant');await ready();
    await page.getByRole('button',{name:'Toggle instant calls'}).waitFor();await capture('dashboard-desktop');
    assert.equal(await page.locator('aside nav a[aria-current="page"]').count(),1);
    for(const theme of ['light','dark']) {
      await page.evaluate(theme=>{document.documentElement.classList.toggle('dark',theme==='dark');},theme);
      const ratios=await page.evaluate(()=>{
        const root=getComputedStyle(document.documentElement);
        const rgb=hex=>{let value=hex.trim().replace('#','');if(value.length===3)value=value.split('').map(c=>c+c).join('');return value.match(/../g).map(v=>parseInt(v,16)/255);};
        const lum=rgb=>rgb.map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
        const bg=rgb(root.getPropertyValue('--card'));
        return ['--destructive','--success','--warning','--color-orange-500'].map(key=>{
          const fg=rgb(root.getPropertyValue(key));
          const tinted=bg.map((v,i)=>v*.9+fg[i]*.1);
          const a=lum(fg),b=lum(tinted);
          return {key,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05)};
        });
      });
      for(const r of ratios)assert(r.ratio>=4.5,theme+' '+r.key+' contrast '+r.ratio);
      assert.equal(await page.locator('aside').evaluate(el=>getComputedStyle(el).backdropFilter),'none');
      await page.waitForTimeout(350);
      await capture('dashboard-'+theme);
    }
    await page.evaluate(()=>document.documentElement.classList.remove('dark'));
    await page.getByRole('button',{name:'Toggle instant calls'}).click();
    await page.getByText('Instant calling is off',{exact:true}).waitFor();
    assert(apiRequests.some(r=>r.path==='/api/client/instant-call'&&r.method==='PUT'&&r.body.enabled===false));
    for(const width of [390,320]){
      await page.setViewportSize({width,height:844});
      for(const route of ['/','/login','/app/instant']){
        await page.goto('http://127.0.0.1:5180'+route);await ready();await fits(`${route} ${width}`);
        if(width===390)await capture(route==='/'?'public-mobile':route==='/login'?'login-mobile':'dashboard-mobile');
      }
    }
    await page.setViewportSize({width:1440,height:1000});
    await page.evaluate(()=>localStorage.setItem('vocera-theme','dark'));
    await page.goto('http://127.0.0.1:5180/');await ready();
    assert(await page.locator('html').evaluate(el=>el.classList.contains('dark')));await capture('public-dark');
    await page.getByRole('button',{name:'Toggle dark mode'}).click();
    assert.equal(await page.locator('html').evaluate(el=>el.classList.contains('dark')),false);
    await page.emulateMedia({reducedMotion:'reduce'});await capture('public-reduced-motion');
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify({passed:true,checks:['public/login/dashboard at desktop, 390px and 320px','existing demo start/stop WebSocket contract','password login and available Google login API contracts','contact success/error and optional phone persistence in message','instant settings PUT','saved dark preference and theme toggle','reduced motion'],apiPaths:[...new Set(apiRequests.map(r=>r.method+' '+r.path))],errors},null,2));
    console.log('UI checks passed. Intercepted API and voice requests only. Screenshots in ui-review/.');
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
