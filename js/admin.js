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

const clientsTable=$('[data-clients-table]');
const clientSearch=$('[data-client-search]');
const clientDialog=$('[data-client-dialog]');
let clients=[];
let activeClient=null;
let activeClientDetail=null;

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
  loadClients().catch(()=>{});
}

const clientStatusLabels={trial:'Trial',active:'Active',past_due:'Past due',canceled:'Canceled'};

function renderClients(rows){
  clientsTable.innerHTML=rows.map(client=>`<tr><td><strong>${esc(client.name||'—')}</strong></td><td>${esc(client.email)}<br>${esc(client.phone||'')}</td><td><span class="status">${esc(clientStatusLabels[client.status]||client.status)}</span></td><td>${fmt(client.trial_ends_at)}</td><td>${Number(client.pending_call_requests||0)}</td><td>${fmt(client.last_login_at)}</td><td><button type="button" data-open-client="${client.id}">View</button></td></tr>`).join('')||'<tr><td colspan="7">No client accounts yet.</td></tr>';
}

async function loadClients(){
  const data=await api('/api/admin/clients');
  clients=data.clients||[];
  renderClients(clients);
}

function renderClientGoals(goals){
  const list=$('[data-client-goals-list]');
  list.innerHTML=goals.length?goals.map(goal=>`<div class="goal-item" data-goal-id="${goal.id}"><strong>${esc(goal.title)}</strong>${goal.description?`<div>${esc(goal.description)}</div>`:''}<div class="meta">${goal.target_date?`Target: ${esc(goal.target_date)} · `:''}${esc(goal.status)}</div><select data-goal-status-select data-goal-id="${goal.id}"><option value="active"${goal.status==='active'?' selected':''}>Active</option><option value="completed"${goal.status==='completed'?' selected':''}>Completed</option><option value="archived"${goal.status==='archived'?' selected':''}>Archived</option></select></div>`).join(''):'<p class="empty-hint">No goals yet.</p>';
}

function renderClientNotes(notes){
  const list=$('[data-client-notes-list]');
  list.innerHTML=notes.length?notes.map(note=>`<div class="note-item"><div>${esc(note.content)}</div><div class="meta">${note.visibility==='internal'?'Internal only':'Visible to client'} · ${fmt(note.created_at)}</div></div>`).join(''):'<p class="empty-hint">No notes yet.</p>';
}

function renderClientCalls(callRequests){
  const list=$('[data-client-calls-list]');
  list.innerHTML=callRequests.length?callRequests.map(call=>`<div class="call-item" data-call-id="${call.id}"><strong>${esc(call.preferred_time||'Any time')}</strong>${call.reason?`<div>${esc(call.reason)}</div>`:''}<div class="meta">Requested ${fmt(call.created_at)}</div><select data-call-status-select data-call-id="${call.id}"><option value="pending"${call.status==='pending'?' selected':''}>Pending</option><option value="scheduled"${call.status==='scheduled'?' selected':''}>Scheduled</option><option value="completed"${call.status==='completed'?' selected':''}>Completed</option><option value="canceled"${call.status==='canceled'?' selected':''}>Canceled</option></select></div>`).join(''):'<p class="empty-hint">No call requests yet.</p>';
}

async function openClient(id){
  activeClient=clients.find(c=>String(c.id)===String(id));
  if(!activeClient)return;
  const detail=await api(`/api/admin/clients/${id}`);
  activeClientDetail=detail;
  $('[data-client-title]').textContent=detail.client.name||detail.client.email;
  $('[data-client-details]').innerHTML=[['Email',detail.client.email],['Phone',detail.client.phone],['Trial ends',fmt(detail.client.trial_ends_at)],['Created',fmt(detail.client.created_at)],['Last login',fmt(detail.client.last_login_at)]].map(([label,value])=>`<div><strong>${esc(label)}</strong>${esc(value||'—')}</div>`).join('');
  $('[data-client-status]').value=detail.client.status||'trial';
  $('[data-client-name]').value=detail.client.name||'';
  $('[data-client-phone]').value=detail.client.phone||'';
  $('[data-client-save-message]').hidden=true;
  renderClientGoals(detail.goals||[]);
  renderClientNotes(detail.notes||[]);
  renderClientCalls(detail.call_requests||[]);
  clientDialog.showModal();
}

clientsTable.addEventListener('click',event=>{
  const button=event.target.closest('[data-open-client]');if(!button)return;
  openClient(button.dataset.openClient);
});

clientSearch.addEventListener('input',()=>{
  const q=clientSearch.value.trim().toLowerCase();
  renderClients(!q?clients:clients.filter(client=>[client.name,client.email,client.phone,client.status].some(value=>String(value||'').toLowerCase().includes(q))));
});

$('[data-client-save]').addEventListener('click',async()=>{
  if(!activeClient)return;
  const message=$('[data-client-save-message]');message.hidden=false;message.textContent='Saving...';
  try{
    const updated=await api(`/api/admin/clients/${activeClient.id}`,{method:'PATCH',body:JSON.stringify({status:$('[data-client-status]').value,name:$('[data-client-name]').value,phone:$('[data-client-phone]').value})});
    Object.assign(activeClient,updated.client);renderClients(clients);message.textContent='Saved.';
  }catch(error){message.textContent=error.message;}
});

$('[data-client-reset-password]').addEventListener('click',async()=>{
  if(!activeClient)return;
  const message=$('[data-client-save-message]');message.hidden=false;message.textContent='Generating link...';
  try{
    const data=await api(`/api/admin/clients/${activeClient.id}/reset-password`,{method:'POST',body:'{}'});
    message.textContent=`Share this link with the client: ${data.activation_url}`;
    if(navigator.clipboard)navigator.clipboard.writeText(data.activation_url).catch(()=>{});
  }catch(error){message.textContent=error.message;}
});

$('[data-goal-add]').addEventListener('click',async()=>{
  if(!activeClient)return;
  const wrap=$('[data-goal-form]');
  const titleInput=wrap.querySelector('[data-goal-title]');
  if(!titleInput.value.trim()){titleInput.focus();return;}
  try{
    await api(`/api/admin/clients/${activeClient.id}/goals`,{method:'POST',body:JSON.stringify({title:titleInput.value,description:wrap.querySelector('[data-goal-description]').value,target_date:wrap.querySelector('[data-goal-target-date]').value})});
    wrap.querySelectorAll('input').forEach(input=>input.value='');
    const detail=await api(`/api/admin/clients/${activeClient.id}`);
    activeClientDetail=detail;renderClientGoals(detail.goals||[]);
  }catch(error){alert(error.message);}
});

$('[data-note-add]').addEventListener('click',async()=>{
  if(!activeClient)return;
  const wrap=$('[data-note-form]');
  const contentInput=wrap.querySelector('[data-note-content]');
  if(!contentInput.value.trim()){contentInput.focus();return;}
  try{
    await api(`/api/admin/clients/${activeClient.id}/notes`,{method:'POST',body:JSON.stringify({content:contentInput.value,visibility:wrap.querySelector('[data-note-internal]').checked?'internal':'client'})});
    contentInput.value='';
    wrap.querySelector('[data-note-internal]').checked=false;
    const detail=await api(`/api/admin/clients/${activeClient.id}`);
    activeClientDetail=detail;renderClientNotes(detail.notes||[]);
  }catch(error){alert(error.message);}
});

$('[data-client-goals-list]').addEventListener('change',async event=>{
  const select=event.target.closest('[data-goal-status-select]');if(!select||!activeClient)return;
  const goal=(activeClientDetail?.goals||[]).find(g=>String(g.id)===select.dataset.goalId);if(!goal)return;
  try{
    await api(`/api/admin/clients/${activeClient.id}/goals/${goal.id}`,{method:'PATCH',body:JSON.stringify({title:goal.title,description:goal.description,target_date:goal.target_date,status:select.value})});
    goal.status=select.value;
  }catch(error){alert(error.message);}
});

$('[data-client-calls-list]').addEventListener('change',async event=>{
  const select=event.target.closest('[data-call-status-select]');if(!select)return;
  try{
    await api(`/api/admin/call-requests/${select.dataset.callId}`,{method:'PATCH',body:JSON.stringify({status:select.value})});
    await loadClients();
  }catch(error){alert(error.message);}
});

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
