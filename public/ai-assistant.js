
class AIAssistant{
  constructor({api,esc,icon,formatTime,openModal,toast}){Object.assign(this,{api,esc,icon,formatTime,openModal,toast});this.generation=0;this.active=false;this.drafts=new Map();}
  view(event,user){
    const contextHint=user.role==='organizer'?'Выбранный ИИ-сервис получит описание, задачи и сводку бюджета. Списки гостей, контактные поля, файлы и чат команды не отправляются.':'Выбранный ИИ-сервис получит описание и задачи. Бюджет, списки гостей, контактные поля, файлы и чат команды не отправляются.';
    return `<div id="ai-assistant" class="ai-layout" data-event="${event.id}"><section class="panel ai-panel"><div class="ai-toolbar"><span>${this.icon('spark')} Личный диалог</span><div><span class="badge finished" id="ai-status">Проверяем настройку</span>${user.role==='organizer'?'<button type="button" class="icon-button" id="ai-settings" aria-label="Настройки ИИ">'+this.icon('edit')+'</button>':''}<button type="button" class="icon-button" id="ai-refresh" aria-label="Обновить статус ИИ">${this.icon('clock')}</button><button type="button" class="icon-button" id="ai-clear" aria-label="Очистить мой диалог">${this.icon('trash')}</button></div></div>
    <div id="ai-setup" class="ai-setup" hidden></div><div class="ai-history-control"><button type="button" id="ai-older" class="text-button" hidden>Предыдущие сообщения</button></div>
    <div class="ai-scroll" id="ai-scroll"><div id="ai-messages" aria-live="polite" role="log" aria-label="Диалог с ИИ"><p class="muted small">Загружаем ваш диалог…</p></div></div>
    <form id="ai-form" class="ai-composer"><label class="sr-only" for="ai-question">Вопрос ассистенту</label><textarea id="ai-question" name="question" rows="3" maxlength="4000" required placeholder="Задайте вопрос или попросите помочь с подготовкой…"></textarea><label class="checkbox-line ai-context"><input id="ai-context" type="checkbox"><span>Добавить сведения о мероприятии к следующему вопросу</span></label><p class="ai-context-hint" id="ai-context-hint" hidden>${contextHint}</p><div class="ai-composer-bottom"><span>Enter — отправить · Shift+Enter — новая строка</span><button class="button" id="ai-send" type="submit" disabled>${this.icon('arrow')} Отправить</button></div><p class="form-error" id="ai-error" role="alert"></p><p class="ai-disclosure">Вопрос и история диалога обрабатываются выбранным ИИ-сервисом. Ответы ИИ стоит проверять.</p></form></section>
    <aside class="ai-aside"><div class="ai-helper-card"><span class="ai-helper-icon">${this.icon('spark')}</span><h2>EventGo AI</h2><p>Поможет разобраться в вопросе, составить план и подготовить тексты.</p><div class="ai-suggestions"><button type="button" data-ai-prompt="Составь пошаговый план подготовки мероприятия.">План подготовки ${this.icon('arrow')}</button><button type="button" data-ai-prompt="Как распределить задачи в команде организаторов?">Задачи команды ${this.icon('arrow')}</button><button type="button" data-ai-prompt="Помоги написать приглашение на мероприятие.">Текст приглашения ${this.icon('arrow')}</button></div></div><div class="panel ai-privacy"><h3>${this.icon('lock')} Только ваш диалог</h3><p>В интерфейсе другие участники не видят ваш диалог. История хранится в локальной базе и входит в её резервные копии.</p><p>Текущее событие:<br><strong>${this.esc(event.title)}</strong></p></div></aside></div>`;
  }
  valid(g){return this.active&&g===this.generation&&Number(document.getElementById('ai-assistant')?.dataset.event)===this.eventId;}
  stop(){if(this.active){const field=document.getElementById('ai-question');if(field)this.drafts.set(this.key,field.value);}this.active=false;this.generation++;}
  mount(eventId,user){
    this.active=true;this.generation++;this.eventId=eventId;this.user=user;this.key=user.id+':'+eventId;this.turns=[];this.loaded=false;this.sending=false;this.configured=false;
    const field=document.getElementById('ai-question');field.value=this.drafts.get(this.key)||'';
    field.addEventListener('input',()=>this.drafts.set(this.key,field.value));
    field.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();document.getElementById('ai-form').requestSubmit();}});
    document.getElementById('ai-form').addEventListener('submit',event=>{event.preventDefault();this.send();});
    document.getElementById('ai-context').addEventListener('change',event=>document.getElementById('ai-context-hint').hidden=!event.target.checked);
    document.getElementById('ai-settings')?.addEventListener('click',()=>this.settings());
    document.getElementById('ai-refresh').addEventListener('click',()=>this.load());
    document.getElementById('ai-clear').addEventListener('click',()=>this.clear());
    document.getElementById('ai-older').addEventListener('click',()=>this.older());
    document.querySelectorAll('[data-ai-prompt]').forEach(button=>button.addEventListener('click',()=>{field.value=button.dataset.aiPrompt;this.drafts.set(this.key,field.value);field.focus();}));
    this.load();
  }
  readiness(result){
    if(!result.provider_id){this.configured=false;const restartStatus=document.getElementById('ai-status');restartStatus.className='badge pending';restartStatus.textContent='Нужен перезапуск';const restartBox=document.getElementById('ai-setup');restartBox.hidden=false;restartBox.innerHTML='<strong>Обновление сервера</strong><p>Остановите старое окно запуска и снова откройте START.cmd. После этого обновите страницу.</p>';document.getElementById('ai-send').disabled=true;return;}
    this.configured=result.configured;this.model=result.model;this.provider=result.provider;document.querySelector('.ai-disclosure').textContent='Вопрос и история диалога обрабатываются '+result.provider+'. Ответы ИИ стоит проверять.';
    const status=document.getElementById('ai-status');status.className='badge '+(result.configured?'done':'pending');status.textContent=result.configured?result.provider+' · ключ настроен':'Нужно подключение';
    const setup=document.getElementById('ai-setup');setup.hidden=result.configured;
    setup.innerHTML=result.configured?'':`<strong>Подключите настоящую модель</strong><p>${this.user.role==='organizer'?'Введите ключ выбранного ИИ-сервиса в настройках — после этого можно задавать вопросы.':'Попросите организатора подключить ИИ в настройках ассистента.'}</p>${this.user.role==='organizer'?'<button type="button" class="button soft slim" id="ai-connect">Подключить ИИ</button>':''}`;
    document.getElementById('ai-connect')?.addEventListener('click',()=>this.settings());
    document.getElementById('ai-send').disabled=!result.configured||this.sending||!this.loaded;
  }
  empty(){return `<div class="ai-empty">${this.icon('spark')}<h2>Чем помочь?</h2><p>Задайте вопрос своими словами.<br>При необходимости добавьте сведения о событии.</p></div>`;}
  turnHtml(turn){return `<article class="ai-turn" data-turn-id="${turn.id}"><div class="ai-question"><span>Вы</span><p>${this.esc(turn.question)}</p></div><div class="ai-answer"><strong>${this.icon('spark')} EventGo AI</strong><div>${this.esc(turn.answer)}</div><time>${this.esc(this.formatTime(turn.created_at))}</time></div></article>`;}
  render(){document.getElementById('ai-messages').innerHTML=this.turns.length?this.turns.map(turn=>this.turnHtml(turn)).join(''):this.empty();document.getElementById('ai-older').hidden=!this.hasMore;}
  bottom(){const box=document.getElementById('ai-scroll');box.scrollTop=box.scrollHeight;}
  async load(){
    const generation=this.generation;
    try{const result=await this.api(`/events/${this.eventId}/assistant`);if(!this.valid(generation))return;this.turns=result.turns;this.hasMore=result.has_more;this.loaded=true;this.render();this.readiness(result);this.bottom();}
    catch(error){if(this.valid(generation)){document.getElementById('ai-error').textContent=error.message;document.getElementById('ai-messages').innerHTML=this.empty();}}
  }
  async older(){
    if(!this.hasMore||!this.turns.length)return;const generation=this.generation,button=document.getElementById('ai-older');button.disabled=true;
    try{const result=await this.api(`/events/${this.eventId}/assistant?before=${this.turns[0].id}`);if(!this.valid(generation))return;const box=document.getElementById('ai-scroll'),height=box.scrollHeight,top=box.scrollTop;this.turns=[...result.turns,...this.turns];this.hasMore=result.has_more;this.render();box.scrollTop=top+box.scrollHeight-height;}
    catch(error){if(this.valid(generation))document.getElementById('ai-error').textContent=error.message;}
    finally{if(this.valid(generation))button.disabled=false;}
  }

  async settings(){
    let current;try{current=await this.api('/ai/settings');}catch{current={configured:false,model:'deepseek-flash',provider_id:'deepseek'};}
    if(this.user.role!=='organizer')return;
    if(!current.provider_id){this.toast('Перезапустите START.cmd и обновите страницу.',true);return;}
    const provider=current.provider_id;
    this.openModal('Настройки ИИ',`<p class="muted small" style="margin-bottom:17px">Ключ хранится на этом компьютере отдельно от папки yba и не входит в архив для передачи. Запросы используют оплату и лимиты вашего ИИ-аккаунта.</p><div class="form-grid"><label class="field full"><span>ИИ-сервис</span><select name="provider" ${current.managed?'disabled':''}><option value="deepseek" ${provider==='deepseek'?'selected':''}>DeepSeek</option><option value="openai" ${provider==='openai'?'selected':''}>OpenAI</option></select></label><label class="field full"><span>Ключ API</span><input name="api_key" type="password" maxlength="512" autocomplete="off" spellcheck="false" placeholder="${current.configured?'Оставьте пустым, чтобы сохранить текущий':'sk-…'}" ${current.managed?'disabled':''} ${!current.configured&&!current.managed?'required':''}></label><label class="field full"><span>Модель</span><input name="model" value="${this.esc(current.model)}" required maxlength="100" autocomplete="off"><small>DeepSeek: deepseek-flash. OpenAI: gpt-4.1-mini.</small></label></div><p class="small muted" style="margin-top:15px">${current.managed?'Подключение задано владельцем сервера.':'Текущий ключ не отображается и не возвращается в браузер. Для смены сервиса нужен его собственный ключ.'}</p>`,{submit:'Сохранить настройки',onSubmit:async form=>{
      await this.api('/ai/settings','PATCH',{api_key:form.elements.api_key.value,model:form.elements.model.value.trim(),provider:form.elements.provider.value});
      this.toast('Настройки сохранены.');if(this.active)await this.load();
    }});
    const selector=document.querySelector('#modal select[name="provider"]');
    selector?.addEventListener('change',()=>{document.querySelector('#modal input[name="model"]').value=selector.value==='deepseek'?'deepseek-flash':'gpt-4.1-mini';});
  }

  clear(){
    if(this.sending)return;const eventId=this.eventId,generation=this.generation;
    this.openModal('Очистить ваш диалог?',`<p class="muted small">Будет удалена только ваша история с ИИ по этому мероприятию. Переписка других пользователей и чат команды сохранятся.</p>`,{submit:'Очистить',onSubmit:async()=>{await this.api(`/events/${eventId}/assistant`,'DELETE');if(this.valid(generation)){this.turns=[];this.hasMore=false;this.render();}this.toast('Ваш диалог очищен');}});
  }
  async send(){
    if(this.sending||!this.loaded||!this.configured)return;
    const generation=this.generation,eventId=this.eventId,key=this.key,field=document.getElementById('ai-question'),raw=field.value,question=raw.trim(),include_context=document.getElementById('ai-context').checked,errorBox=document.getElementById('ai-error');
    errorBox.textContent='';if(!question){errorBox.textContent='Напишите вопрос.';return;}
    if(!this.retry||this.retry.question!==question||this.retry.include_context!==include_context||this.retry.eventId!==eventId)this.retry={eventId,question,include_context,client_token:globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'-'+Math.random().toString(36).slice(2)};
    this.sending=true;field.disabled=true;document.getElementById('ai-send').disabled=true;document.getElementById('ai-context').disabled=true;
    const list=document.getElementById('ai-messages');if(!this.turns.length)list.innerHTML='';list.insertAdjacentHTML('beforeend',`<article id="ai-pending" class="ai-turn"><div class="ai-question"><span>Вы</span><p>${this.esc(question)}</p></div><div class="ai-answer"><strong>${this.icon('spark')} EventGo AI</strong><p class="ai-thinking">Готовлю ответ…</p></div></article>`);this.bottom();
    try{const result=await this.api(`/events/${eventId}/assistant`,'POST',{question,include_context,client_token:this.retry.client_token});this.retry=null;if(this.drafts.get(key)===raw)this.drafts.delete(key);if(!this.valid(generation))return;document.getElementById('ai-pending')?.remove();if(!this.turns.some(turn=>turn.id===result.turn.id))this.turns.push(result.turn);this.render();field.value='';this.bottom();}
    catch(error){if(this.valid(generation)){document.getElementById('ai-pending')?.remove();if(!this.turns.length)list.innerHTML=this.empty();errorBox.textContent=error.message;}}
    finally{if(this.valid(generation)){this.sending=false;field.disabled=false;document.getElementById('ai-context').disabled=false;document.getElementById('ai-send').disabled=!this.configured;field.focus();}}
  }
}

export {AIAssistant};
