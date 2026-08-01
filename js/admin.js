const $=(selector)=>document.querySelector(selector);
const loginSection=$('[data-admin-login]');
const dashboard=$('[data-admin-dashboard]');
const loginForm=$('[data-admin-login-form]');
const loginMessage=$('[data-admin-login-message]');
const metrics=$('[data-admin-metrics]');
const pagesTable=$('[data-pages-table]');
const leadsTable=$('[data-leads-table]');
const eventsTable=$('[data-events-table]');
const search=$('[data-lead-search]');
const filterForm=$('[data-dashboard-filter]');
const filterFrom=$('[data-filter-from]');
const filterTo=$('[data-filter-to]');
const filterPage=$('[data-filter-page]');
const filterStatus=$('[data-filter-status]');
const dialog=$('[data-lead-dialog]');
let leads=[];
let activeLead=null;

const esc=(value)=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const fmt=(value)=>value?new Date(value).toLocaleString():'—';
const toLocalInput=(date)=>{
  const offset=date.getTimezoneOffset();
  return new Date(date.getTime()-offset*60000).toISOString().slice(0,16);
};

async function api(path,options={}){
  const response=await fetch(path,{credentials:'same-origin',...options,headers:{'content-type':'application/json',...(options.headers||{})}});
  const data=await response.json().catch(()=>({}));
  const isLoginRequest=path==='/api/admin/login';
  if(response.status===401&&!isLoginRequest){showLogin();throw new Error('Your session has expired. Please sign in again.');}
  if(!response.ok)throw new Error(data.error||`Request failed with status ${response.status}.`);
  return data;
}

function showLogin(){loginSection.hidden=false;dashboard.hidden=true;}
function showDashboard(){loginSection.hidden=true;dashboard.hidden=false;}

function renderMetrics(data){
  const items=[['Visits',data.visits],['Unique visitors',data.unique_visitors],['Leads',data.leads],['Chatbot opens',data.chatbot_opens],['Stripe clicks',data.stripe_clicks]];
  metrics.innerHTML=items.map(([label,value])=>`<article class="metric"><strong>${Number(value||0).toLocaleString()}</strong><span>${esc(label)}</span></article>`).join('');
}

function renderPages(rows){
  pagesTable.innerHTML=rows.map(page=>`<tr><td><strong>${esc(page.page_path||'—')}</strong></td><td>${Number(page.views||0).toLocaleString()}</td><td>${Number(page.unique_visitors||0).toLocaleString()}</td><td>${fmt(page.last_activity)}</td></tr>`).join('')||'<tr><td colspan="4">No page activity found for this reporting window.</td></tr>';
}

function renderLeads(rows){
  leadsTable.innerHTML=rows.map(lead=>`<tr><td><strong>${esc(lead.name)}</strong></td><td>${esc(lead.email)}<br>${esc(lead.phone)}</td><td>${esc(lead.area||'—')}</td><td>${esc(lead.lead_source||'—')}</td><td><span class="status">${esc(lead.status)}</span></td><td>${fmt(lead.submitted_at)}</td><td><button type="button" data-open-lead="${lead.id}">View</button></td></tr>`).join('')||'<tr><td colspan="7">No leads found.</td></tr>';
}

function renderEvents(rows){
  eventsTable.innerHTML=rows.map(event=>`<tr><td>${esc(event.event_name)}</td><td>${esc(event.page_path||'—')}</td><td>${esc((event.session_id||'').slice(0,12)||'—')}</td><td>${fmt(event.occurred_at)}</td></tr>`).join('')||'<tr><td colspan="4">No events recorded for this reporting window.</td></tr>';
}

function populatePages(paths){
  const current=filterPage.value;
  filterPage.innerHTML='<option value="">All pages</option>'+paths.map(path=>`<option value="${esc(path)}">${esc(path)}</option>`).join('');
  if(paths.includes(current))filterPage.value=current;
}

function getFilters(){
  const params=new URLSearchParams();
  if(filterFrom.value)params.set('from',new Date(filterFrom.value).toISOString());
  if(filterTo.value)params.set('to',new Date(filterTo.value).toISOString());
  if(filterPage.value)params.set('page',filterPage.value);
  return params;
}

async function loadDashboard(){
  filterStatus.textContent='Loading…';
  const params=getFilters();
  const data=await api(`/api/admin/dashboard${params.toString()?`?${params}`:''}`);
  showDashboard();
  renderMetrics(data.metrics||{});
  renderPages(data.pages||[]);
  leads=data.leads||[];
  renderLeads(leads);
  renderEvents(data.events||[]);
  populatePages(data.page_paths||[]);
  filterStatus.textContent=`Showing ${fmt(data.range?.from)} through ${fmt(data.range?.to)}${data.range?.page?` for ${data.range.page}`:''}.`;
}

function setRange(hours){
  const now=new Date();
  filterTo.value=toLocalInput(now);
  filterFrom.value=toLocalInput(new Date(now.getTime()-hours*60*60*1000));
  filterPage.value='';
}

function resetRange(){setRange(30*24);}

async function applyQuickRange(hours){
  setRange(hours);
  await loadDashboard().catch(error=>{filterStatus.textContent=error.message;});
}

loginForm.addEventListener('submit',async event=>{
  event.preventDefault();
  loginMessage.hidden=false;loginMessage.textContent='Signing in...';
  try{
    await api('/api/admin/login',{method:'POST',body:JSON.stringify({password:loginForm.password.value})});
    loginForm.reset();loginMessage.hidden=true;resetRange();await loadDashboard();
  }catch(error){loginMessage.textContent=error.message;}
});

$('[data-admin-logout]').addEventListener('click',async()=>{try{await api('/api/admin/logout',{method:'POST',body:'{}'});}finally{showLogin();}});

filterForm.addEventListener('submit',async event=>{event.preventDefault();await loadDashboard().catch(error=>{filterStatus.textContent=error.message;});});
$('[data-filter-24h]').addEventListener('click',()=>applyQuickRange(24));
$('[data-filter-12h]').addEventListener('click',()=>applyQuickRange(12));
$('[data-filter-reset]').addEventListener('click',()=>applyQuickRange(30*24));

search.addEventListener('input',()=>{
  const q=search.value.trim().toLowerCase();
  renderLeads(!q?leads:leads.filter(lead=>[lead.name,lead.email,lead.phone,lead.area,lead.lead_source,lead.status].some(value=>String(value||'').toLowerCase().includes(q))));
});

leadsTable.addEventListener('click',event=>{
  const button=event.target.closest('[data-open-lead]');if(!button)return;
  activeLead=leads.find(lead=>String(lead.id)===button.dataset.openLead);if(!activeLead)return;
  $('[data-lead-title]').textContent=activeLead.name;
  $('[data-lead-details]').innerHTML=[['Email',activeLead.email],['Phone',activeLead.phone],['Area',activeLead.area],['Source',activeLead.lead_source],['Preferred contact',activeLead.preferred_contact],['Best time',activeLead.best_contact_time],['Summary',activeLead.chat_summary||activeLead.message],['Submitted',fmt(activeLead.submitted_at)]].map(([label,value])=>`<div><strong>${esc(label)}</strong>${esc(value||'—')}</div>`).join('');
  $('[data-lead-status]').value=activeLead.status||'new';
  $('[data-lead-assigned]').value=activeLead.assigned_representative||'';
  $('[data-lead-follow-up]').value=activeLead.next_follow_up_at?activeLead.next_follow_up_at.slice(0,16):'';
  $('[data-lead-notes]').value=activeLead.representative_notes||'';
  $('[data-lead-save-message]').hidden=true;
  dialog.showModal();
});

$('[data-lead-save]').addEventListener('click',async()=>{
  if(!activeLead)return;
  const message=$('[data-lead-save-message]');message.hidden=false;message.textContent='Saving...';
  try{
    const updated=await api(`/api/admin/leads/${activeLead.id}`,{method:'PATCH',body:JSON.stringify({status:$('[data-lead-status]').value,assigned_representative:$('[data-lead-assigned]').value,next_follow_up_at:$('[data-lead-follow-up]').value,representative_notes:$('[data-lead-notes]').value})});
    Object.assign(activeLead,updated.lead);renderLeads(leads);message.textContent='Saved.';
  }catch(error){message.textContent=error.message;}
});

resetRange();
loadDashboard().catch(()=>showLogin());
