export class TeamChat {
  constructor({api,esc,avatar,icon,formatTime}) {
    Object.assign(this,{api,esc,avatar,icon,formatTime});
    this.generation=0;this.active=false;this.timer=null;this.drafts=new Map();this.pending=new Map();
    document.addEventListener('visibilitychange',()=>{if(this.active&&!document.hidden)this.synchronize();});
  }
  view(event) {
    return `<section class="panel chat-panel" id="team-chat" data-event="${event.id}">
      <div class="chat-toolbar"><span>${this.icon('lock')} Только команда мероприятия</span><small id="chat-sync">Сообщения обновляются автоматически</small></div>
      <div class="chat-error" id="chat-error" role="status" hidden></div>
      <div class="chat-history-control"><button type="button" id="chat-older" class="text-button" hidden>Загрузить предыдущие сообщения</button></div>
      <div class="chat-scroll" id="chat-scroll"><div id="chat-messages" role="log" aria-label="Сообщения команды" aria-live="polite" aria-relevant="additions"><div class="chat-empty">${this.icon('chat')}<p>Загружаем переписку…</p></div></div></div>
      <button type="button" class="chat-new" id="chat-new" hidden>К новым сообщениям</button>
      <form id="chat-form" class="chat-composer"><label class="sr-only" for="chat-text">Сообщение команде</label><textarea id="chat-text" name="text" rows="2" maxlength="4000" required placeholder="Напишите сообщение команде…"></textarea>
      <div class="chat-composer-bottom"><span class="chat-hint">Enter — отправить · Shift+Enter — новая строка</span><span class="chat-count" id="chat-count">0 / 4000</span><button class="button" type="submit" id="chat-send">${this.icon('arrow')} Отправить</button></div><p class="form-error" id="chat-send-error" role="alert"></p></form>
    </section>`;
  }
  mount(eventId,user) {
    this.active=true;this.eventId=eventId;this.user=user;this.key=user.id+':'+eventId;this.generation++;
    this.messages=[];this.cursor=0;this.known=new Set();this.initialized=false;this.sending=false;this.unseen=0;this.olderBusy=false;
    const input=document.getElementById('chat-text');input.value=this.drafts.get(this.key)||'';this.updateCount();
    input.addEventListener('input',()=>{this.drafts.set(this.key,input.value);this.updateCount();});
    input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing){event.preventDefault();document.getElementById('chat-form').requestSubmit();}});
    document.getElementById('chat-form').addEventListener('submit',event=>{event.preventDefault();this.send();});
    document.getElementById('chat-older').addEventListener('click',()=>this.loadOlder());
    document.getElementById('chat-new').addEventListener('click',()=>this.toBottom());
    document.getElementById('chat-scroll').addEventListener('scroll',()=>{if(this.atBottom()){this.unseen=0;this.showUnseen();}});
    this.synchronize();this.timer=setInterval(()=>{if(!document.hidden)this.synchronize();},2000);
  }
  stop() {
    if(this.active){const input=document.getElementById('chat-text');if(input)this.drafts.set(this.key,input.value);}
    this.active=false;this.generation++;clearInterval(this.timer);this.timer=null;
  }
  valid(generation) {return this.active&&this.generation===generation&&Number(document.getElementById('team-chat')?.dataset.event)===this.eventId;}
  atBottom(){const box=document.getElementById('chat-scroll');return !box||box.scrollHeight-box.scrollTop-box.clientHeight<90;}
  toBottom(){const box=document.getElementById('chat-scroll');if(box)box.scrollTop=box.scrollHeight;this.unseen=0;this.showUnseen();}
  showUnseen(){const button=document.getElementById('chat-new');if(button){button.hidden=!this.unseen;button.textContent=`К новым сообщениям · ${this.unseen}`;}}
  updateCount(){const input=document.getElementById('chat-text'),count=document.getElementById('chat-count');if(input&&count)count.textContent=input.value.length+' / 4000';}
  messageHtml(message) {
    const mine=message.user_id===this.user.id;
    return `<article class="chat-message ${mine?'mine':''}" data-message-id="${message.id}">${this.avatar(message.author,message.user_id)}<div class="chat-message-content"><div class="chat-message-meta"><strong>${this.esc(message.author)}</strong>${message.author_role==='organizer'?'<span>Организатор</span>':''}<time datetime="${this.esc(message.created_at.replace(' ','T')+'Z')}">${this.esc(this.formatTime(message.created_at))}</time></div><p class="chat-bubble">${this.esc(message.text)}</p></div></article>`;
  }
  append(messages,{forceBottom=false}={}) {
    const fresh=messages.filter(message=>!this.known.has(message.id));if(!fresh.length)return;
    const nearBottom=this.atBottom();const list=document.getElementById('chat-messages');if(!this.messages.length)list.innerHTML='';
    for(const message of fresh){this.known.add(message.id);this.messages.push(message);}
    this.messages.sort((a,b)=>a.id-b.id);
    // Incremental updates keep the composer and current scroll position intact.
    for(const message of fresh.sort((a,b)=>a.id-b.id)){const next=[...list.querySelectorAll('[data-message-id]')].find(node=>Number(node.dataset.messageId)>message.id);if(next)next.insertAdjacentHTML('beforebegin',this.messageHtml(message));else list.insertAdjacentHTML('beforeend',this.messageHtml(message));}
    if(nearBottom||forceBottom)this.toBottom();else{this.unseen+=fresh.length;this.showUnseen();}
  }
  error(message){const box=document.getElementById('chat-error');if(box){box.hidden=!message;box.textContent=message||'';}}
  async synchronize() {
    const generation=this.generation;if(!this.active||this.polling===generation)return;this.polling=generation;
    const initial=!this.initialized;
    const lastId=this.cursor;
    try {
      const result=await this.api(`/events/${this.eventId}/chat`+(initial?'':'?after='+lastId));
      if(!this.valid(generation))return;
      if(initial){this.initialized=true;this.hasOlder=result.has_more;document.getElementById('chat-older').hidden=!this.hasOlder;
        if(!result.messages.length&&!this.messages.length)document.getElementById('chat-messages').innerHTML=`<div class="chat-empty">${this.icon('chat')}<h3>Начните разговор</h3><p>Обсудите задачи, сроки и детали события с командой.</p></div>`;
      }
      this.cursor=Math.max(this.cursor,...result.messages.map(message=>message.id));this.append(result.messages,{forceBottom:initial});this.error('');
      document.getElementById('chat-sync').textContent='Сообщения обновляются автоматически';
    } catch(error) {
      if(!this.valid(generation))return;
      this.error(error.message||'Не удалось обновить сообщения. Повторим автоматически.');
      document.getElementById('chat-sync').textContent='Ожидаем соединения…';
      if(error.status===403){document.getElementById('chat-messages').innerHTML='';document.getElementById('chat-text').disabled=true;document.getElementById('chat-send').disabled=true;this.stop();}
    } finally {if(this.polling===generation)this.polling=null;}
  }
  async loadOlder() {
    const generation=this.generation;if(this.olderBusy||!this.hasOlder||!this.messages.length)return;this.olderBusy=true;
    const button=document.getElementById('chat-older');button.disabled=true;
    try {
      const result=await this.api(`/events/${this.eventId}/chat?before=${this.messages[0].id}`);if(!this.valid(generation))return;
      const box=document.getElementById('chat-scroll'),height=box.scrollHeight,top=box.scrollTop;
      const fresh=result.messages.filter(message=>!this.known.has(message.id));fresh.forEach(message=>this.known.add(message.id));this.messages=[...fresh,...this.messages];
      document.getElementById('chat-messages').insertAdjacentHTML('afterbegin',fresh.map(message=>this.messageHtml(message)).join(''));
      box.scrollTop=top+box.scrollHeight-height;this.hasOlder=result.has_more;button.hidden=!this.hasOlder;this.error('');
    }catch(error){if(this.valid(generation))this.error(error.message);}
    finally{if(this.valid(generation)){this.olderBusy=false;button.disabled=false;}}
  }
  async send() {
    if(!this.active||this.sending)return;
    const generation=this.generation,key=this.key,input=document.getElementById('chat-text'),raw=input.value,text=raw.trim(),button=document.getElementById('chat-send');
    const errorBox=document.getElementById('chat-send-error');errorBox.textContent='';
    if(!text){errorBox.textContent='Напишите сообщение.';return;}
    if(text.length>4000){errorBox.textContent='Сообщение должно содержать не более 4000 символов.';return;}
    let pending=this.pending.get(key);
    if(!pending||pending.text!==text){const token=globalThis.crypto?.randomUUID?.()||Date.now().toString(36)+'-'+Math.random().toString(36).slice(2)+'-'+Math.random().toString(36).slice(2);pending={text,client_token:token};this.pending.set(key,pending);}
    this.sending=true;input.disabled=true;button.disabled=true;button.textContent='Отправляем…';
    try {
      const result=await this.api(`/events/${this.eventId}/chat`,'POST',pending);
      if(this.pending.get(key)===pending)this.pending.delete(key);
      if(this.drafts.get(key)===raw)this.drafts.delete(key);
      if(!this.valid(generation))return;
      input.value='';this.updateCount();this.append([result.message],{forceBottom:true});this.error('');
    }catch(error){if(this.valid(generation))errorBox.textContent=error.message||'Не удалось отправить сообщение. Повторите попытку.';}
    finally{if(this.valid(generation)){this.sending=false;input.disabled=false;button.disabled=false;button.innerHTML=this.icon('arrow')+' Отправить';input.focus();}}
  }
}
