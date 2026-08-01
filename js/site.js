document.querySelectorAll('a[href^="#"]').forEach(link=>{link.addEventListener('click',event=>{const target=document.querySelector(link.getAttribute('href'));if(target){event.preventDefault();target.scrollIntoView({behavior:'smooth'});}})});

const form=document.querySelector('[data-coach-form]');
if(form){
  form.addEventListener('submit',async event=>{
    event.preventDefault();
    const message=document.querySelector('[data-form-message]');
    const paymentNextStep=document.querySelector('[data-payment-next-step]');
    const button=form.querySelector('button[type="submit"]');
    const originalText=button.textContent;
    message.hidden=false;
    message.textContent='Sending your request...';
    if(paymentNextStep){paymentNextStep.hidden=true;}
    button.disabled=true;
    button.textContent='Sending...';

    try{
      const payload=Object.fromEntries(new FormData(form).entries());
      const response=await fetch('/api/leads',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify(payload)
      });
      const result=await response.json().catch(()=>({}));
      if(!response.ok){throw new Error(result.error||'We could not submit your request. Please try again.');}
      message.textContent=result.message||'Thank you. Your request has been received and a LifeRise representative will contact you soon.';
      if(paymentNextStep){paymentNextStep.hidden=false;}
      form.reset();
    }catch(error){
      message.textContent=error.message||'We could not submit your request. Please call (806) 319-5785 or email support@liferise.cc.';
    }finally{
      button.disabled=false;
      button.textContent=originalText;
    }
  });
}
