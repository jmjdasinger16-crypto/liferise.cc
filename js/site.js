document.querySelectorAll('.brand-logo').forEach(img=>{img.src='/assets/liferise-logo-web.png';});

document.querySelectorAll('a[href^="#"]').forEach(link=>{link.addEventListener('click',event=>{const target=document.querySelector(link.getAttribute('href'));if(target){event.preventDefault();target.scrollIntoView({behavior:'smooth'});}})});

const getSessionId=()=>{let id=localStorage.getItem('liferise_session_id');if(!id){id=(crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random()}`);localStorage.setItem('liferise_session_id',id);}return id;};
const sessionId=getSessionId();
const track=(eventName,metadata={})=>fetch('/api/events',{method:'POST',headers:{'content-type':'application/json'},keepalive:true,body:JSON.stringify({event_name:eventName,page_path:location.pathname+location.search,session_id:sessionId,conversation_id:localStorage.getItem('liferise_conversation_id')||'',metadata})}).catch(()=>{});
track('page_view',{title:document.title,referrer:document.referrer||''});

document.addEventListener('click',event=>{const link=event.target.closest('a[href*="buy.stripe.com"]');if(link)track('stripe_click',{placement:link.textContent.trim()});});

const form=document.querySelector('[data-coach-form]');
if(form){form.addEventListener('submit',async event=>{event.preventDefault();track('form_submit_attempt');const message=document.querySelector('[data-form-message]');const paymentNextStep=document.querySelector('[data-payment-next-step]');const button=form.querySelector('button[type="submit"]');const originalText=button.textContent;message.hidden=false;message.textContent='Sending your request...';if(paymentNextStep){paymentNextStep.hidden=true;}button.disabled=true;button.textContent='Sending...';try{const payload=Object.fromEntries(new FormData(form).entries());payload.page_path=location.pathname+location.search;payload.session_id=sessionId;const response=await fetch('/api/leads',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const result=await response.json().catch(()=>({}));if(!response.ok){throw new Error(result.error||'We could not submit your request. Please try again.');}message.textContent=result.message||'Thank you. Your request has been received and a LifeRise representative will contact you soon.';if(paymentNextStep){paymentNextStep.hidden=false;}form.reset();}catch(error){track('form_submit_error',{message:error.message||'Unknown error'});message.textContent=error.message||'We could not submit your request. Please call (806) 319-5785 or email support@liferise.cc.';}finally{button.disabled=false;button.textContent=originalText;}});}

(function(){
  const markup=`<button class="lr-chat-toggle" type="button" aria-expanded="false">Chat with LifeRise</button><section class="lr-chat" aria-label="LifeRise virtual assistant"><div class="lr-chat-head"><strong>LifeRise Assistant</strong><button class="lr-chat-close" type="button" aria-label="Close chat">×</button></div><div class="lr-chat-log" aria-live="polite"></div><form class="lr-chat-form"><input type="text" autocomplete="off" placeholder="Type your answer..." required><button type="submit">Send</button></form><div class="lr-disclosure">I’m a virtual assistant. LifeRise provides lifestyle coaching—not medical, mental-health, legal, or financial professional services.</div></section>`;
  document.body.insertAdjacentHTML('beforeend',markup);
  const toggle=document.querySelector('.lr-chat-toggle');
  const panel=document.querySelector('.lr-chat');
  const close=document.querySelector('.lr-chat-close');
  const log=document.querySelector('.lr-chat-log');
  const chatForm=document.querySelector('.lr-chat-form');
  const input=chatForm.querySelector('input');
  let conversationId=localStorage.getItem('liferise_conversation_id')||'';
  let activeField='';
  let started=false;

  const add=(text,role='bot')=>{const el=document.createElement('div');el.className=`lr-msg ${role}`;el.textContent=text;log.appendChild(el);log.scrollTop=log.scrollHeight;};
  const options=(items)=>{const box=document.createElement('div');box.className='lr-options';items.forEach(item=>{const b=document.createElement('button');b.type='button';b.textContent=item;b.addEventListener('click',()=>send(item));box.appendChild(b);});log.appendChild(box);log.scrollTop=log.scrollHeight;};
  const checkout=(url)=>{const a=document.createElement('a');a.className='lr-checkout';a.href=url;a.textContent='Start My 3-Day Trial →';a.target='_blank';a.rel='noopener';log.appendChild(a);const note=document.createElement('div');note.className='lr-msg bot';note.textContent='After the 3-day trial, membership is $18 every two weeks. Cancellation is handled under the LifeRise Terms of Service.';log.appendChild(note);log.scrollTop=log.scrollHeight;};

  async function send(message=''){
    if(message){add(message,'user');input.value='';}
    chatForm.querySelector('button').disabled=true;
    try{
      const response=await fetch('/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({conversation_id:conversationId,message,field:activeField,page_path:location.pathname+location.search,session_id:sessionId})});
      const data=await response.json().catch(()=>({}));
      if(data.conversation_id){conversationId=data.conversation_id;localStorage.setItem('liferise_conversation_id',conversationId);}
      if(!response.ok){add(data.reply||data.error||'Please try that again.');activeField=data.field||activeField;return;}
      if(data.reply)add(data.reply);
      activeField=data.field||'';
      if(Array.isArray(data.options)&&data.options.length)options(data.options);
      if(data.show_checkout&&data.checkout_url)checkout(data.checkout_url);
    }catch(error){add('I’m having trouble connecting. You can still use the contact form or call (806) 319-5785.');}
    finally{chatForm.querySelector('button').disabled=false;input.focus();}
  }

  const open=()=>{panel.classList.add('open');toggle.setAttribute('aria-expanded','true');track('chatbot_open');if(!started){started=true;add('Hi, I’m the LifeRise virtual assistant. I can help you find the right place to begin.');send('');}input.focus();};
  const shut=()=>{panel.classList.remove('open');toggle.setAttribute('aria-expanded','false');};
  toggle.addEventListener('click',()=>panel.classList.contains('open')?shut():open());
  close.addEventListener('click',shut);
  chatForm.addEventListener('submit',event=>{event.preventDefault();const value=input.value.trim();if(value)send(value);});
})();
