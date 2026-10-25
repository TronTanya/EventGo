import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { get as httpGet, request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { qrMatrix } from '../public/qr.js';
import { MAX_FILE_BYTES } from '../file-storage.mjs';
import { openDatabase } from '../db.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
let processHandle,base,directory;
async function start(){
 processHandle=spawn(process.execPath,['--no-warnings',join(root,'server.mjs')],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',EVENTGO_DATA_DIR:directory,EVENTGO_SECRET_DIR:join(directory,'secrets'),OPENAI_API_KEY:'',OPENAI_MODEL:'',DEEPSEEK_API_KEY:'',DEEPSEEK_MODEL:'',EVENTGO_AI_PROVIDER:'openai',EVENTGO_SMTP_HOST:''},stdio:['ignore','pipe','pipe'],windowsHide:true});
 base=await new Promise((resolve,reject)=>{let out='';const timer=setTimeout(()=>reject(new Error('Server start timeout: '+out)),15000);processHandle.stdout.on('data',b=>{out+=b;const m=out.match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});processHandle.stderr.on('data',b=>out+=b);processHandle.once('exit',code=>{clearTimeout(timer);reject(new Error('Server exited '+code+': '+out));});});
}
async function stop(){if(processHandle&&processHandle.exitCode===null){processHandle.kill();await once(processHandle,'exit');}}
async function request(path,{method='GET',data,cookie,headers={}}={}){const response=await fetch(base+'/api'+path,{method,headers:{'X-EventGo':'1',...(cookie?{Cookie:cookie}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:data===undefined?undefined:JSON.stringify(data)});const content=await response.text();let body;try{body=JSON.parse(content);}catch{body=content;}return {status:response.status,body,headers:response.headers};}
async function login(email,password){const r=await request('/login',{method:'POST',data:{email,password}});assert.equal(r.status,200,JSON.stringify(r.body));return r.headers.get('set-cookie').split(';')[0];}

test('EventGo: persistent data, roles, registration, files and exports',async t=>{
 directory=await mkdtemp(join(tmpdir(),'eventgo-test-'));
 try{
 await start();let org,member,eventId,teamId,taskId,ticket,token,expenseId,fileId,chatLastId;
 await t.test('authentication and request origin checks',async()=>{
   assert.equal((await request('/events')).status,401);
   assert.equal((await request('/login',{method:'POST',data:{email:'organizer@eventgo.local',password:'wrong'}})).status,401);
   org=await login('organizer@eventgo.local','EventGo2026!');member=await login('team@eventgo.local','TeamGo2026!');
   assert.equal((await request('/me',{cookie:org})).body.user.role,'organizer');
   assert.equal((await request('/events',{method:'POST',cookie:org,data:{},headers:{Origin:'https://example.com'}})).status,403);
   assert.equal((await request('/events',{method:'POST',cookie:member,data:{}})).status,403);
   assert.equal((await fetch(base+'/db.mjs')).status,404);
   const rebound=await new Promise((resolve,reject)=>{httpGet(base+'/api/health',{headers:{Host:'evil.example.com'}},r=>{r.resume();resolve(r.statusCode);}).on('error',reject);});assert.equal(rebound,403);
 });
 await t.test('event creation, validation and event access',async()=>{
   const p={title:'Проверка переноса',type:'Форум',starts_at:'2026-11-20T10:00',location:'Тестовый зал',description:'<img src=x onerror=alert(1)>',goal:'Проверить сохранение',capacity:1,budget:10000,status:'planning',registration_open:true};
   assert.equal((await request('/events',{method:'POST',cookie:org,data:{...p,capacity:-1}})).status,400);
   assert.equal((await request('/events',{method:'POST',cookie:org,data:null})).status,400);
   assert.equal((await request('/events',{method:'POST',cookie:org,data:{...p,starts_at:'2026-02-31T10:00'}})).status,400);
   const r=await request('/events',{method:'POST',cookie:org,data:p});assert.equal(r.status,201);eventId=r.body.id;
   assert.equal((await request('/events/'+eventId,{cookie:member})).status,403);
   assert.equal((await request(`/events/${eventId}/chat`,{cookie:member})).status,403);
   assert.equal((await request(`/events/${eventId}/chat`,{method:'POST',cookie:member,data:{text:'Нет доступа'}})).status,403);
   const detail=(await request('/events/'+eventId,{cookie:org})).body;token=detail.event.public_token;
   assert.equal(detail.event.description,p.description);
   assert.equal((await request('/public/'+token)).body.event.title,p.title);
 });
 await t.test('team, assigned tasks and comments',async()=>{
   const person=await request(`/events/${eventId}/team`,{method:'POST',cookie:org,data:{name:'Диана',role:'Дизайнер',email:'team@eventgo.local',kind:'team'}});assert.equal(person.status,201);teamId=person.body.id;
   assert.equal((await request('/events/'+eventId,{cookie:member})).status,200);
   const r=await request(`/events/${eventId}/tasks`,{method:'POST',cookie:org,data:{title:'Проверить макет',description:'Согласовать стиль',assignee_id:teamId,due_date:'2026-11-10',priority:'high'}});assert.equal(r.status,201);taskId=r.body.id;
   assert.equal((await request('/tasks/'+taskId,{method:'PATCH',cookie:member,data:{status:'done'}})).status,200);
   assert.equal((await request('/tasks/'+taskId,{method:'PATCH',cookie:member,data:{title:'Подмена'}})).status,403);
   assert.equal((await request('/tasks/1',{method:'PATCH',cookie:member,data:{status:'done'}})).status,403);
   assert.equal((await request(`/tasks/${taskId}/comments`,{method:'POST',cookie:member,data:{text:'Готово <script>alert(1)</script>'}})).status,201);
   assert.equal((await request(`/tasks/${taskId}/comments`,{cookie:org})).body.length,1);
   assert.equal((await request('/events/'+eventId,{cookie:org})).body.event.readiness,100);
 });
 await t.test('team chat checks access, author identity and duplicate sends',async()=>{
   const path=`/events/${eventId}/chat`;
   assert.equal((await request(path)).status,401);
   assert.equal((await request(path,{method:'POST',data:{text:'Guest'}})).status,401);
   assert.deepEqual((await request(path,{cookie:org})).body.messages,[]);
   const token='chat-test-organizer-0001',text='Обсудим подготовку\n<img src=x onerror=alert(1)>';
   const first=await request(path,{method:'POST',cookie:org,data:{text,client_token:token}});assert.equal(first.status,201);assert.equal(first.body.message.user_id,1);assert.equal(first.body.message.text,text);
   const duplicate=await request(path,{method:'POST',cookie:org,data:{text,client_token:token}});assert.equal(duplicate.status,200);assert.equal(duplicate.body.message.id,first.body.message.id);
   assert.equal((await request(path,{method:'POST',cookie:org,data:{text:'Другой текст',client_token:token}})).status,409);
   const answer=await request(path,{method:'POST',cookie:member,data:{text:'Я подготовлю макет.',user_id:1,author:'Подмена'}});assert.equal(answer.status,201);assert.equal(answer.body.message.user_id,2);assert.equal(answer.body.message.author,'Диана Мирзоян');
   const received=await request(path+'?after='+first.body.message.id,{cookie:org});assert.equal(received.body.messages[0].id,answer.body.message.id);assert.equal(received.body.messages[0].text,'Я подготовлю макет.');
   assert.equal((await request(path,{method:'POST',cookie:member,data:{text:'   '}})).status,400);
   assert.equal((await request(path,{method:'POST',cookie:member,data:{text:'x'.repeat(4001)}})).status,400);
   assert.equal((await request(path,{method:'POST',cookie:member,data:{text:'Текст',client_token:'bad'}})).status,400);
   assert.equal((await request(path+'?after=-1',{cookie:member})).status,400);
   assert.equal((await request(path+'?after=1&before=2',{cookie:member})).status,400);
   assert.deepEqual((await request('/events/1/chat',{cookie:org})).body.messages,[]);
 });
 await t.test('chat paginates old history and receives new messages in order',async()=>{
   const path=`/events/${eventId}/chat`;
   for(let i=0;i<65;i++)assert.equal((await request(path,{method:'POST',cookie:org,data:{text:'Сообщение истории '+i}})).status,201);
   const latest=(await request(path,{cookie:member})).body;assert.equal(latest.messages.length,50);assert.equal(latest.has_more,true);
   assert.ok(latest.messages.every((message,i,rows)=>i===0||message.id>rows[i-1].id));
   const older=(await request(path+'?before='+latest.messages[0].id,{cookie:org})).body;assert.equal(older.messages.length,17);assert.equal(older.has_more,false);
   assert.ok(older.messages.at(-1).id<latest.messages[0].id);
   const last=latest.messages.at(-1).id;
   const posted=await request(path,{method:'POST',cookie:member,data:{text:'Последнее сообщение: всё готово!'}});chatLastId=posted.body.message.id;
   const update=(await request(path+'?after='+last,{cookie:org})).body;assert.equal(update.messages.length,1);assert.equal(update.messages[0].id,chatLastId);
 });
 
 await t.test('AI settings and private assistant require account and event access',async()=>{
   assert.equal((await request('/ai/settings')).status,401);
   assert.equal((await request(`/events/${eventId}/assistant`)).status,401);
   const state=await request('/ai/settings',{cookie:org});assert.equal(state.status,200);assert.equal(state.body.configured,false);
   assert.equal((await request(`/events/${eventId}/assistant`,{cookie:member})).body.turns.length,0);
   assert.equal((await request(`/events/${eventId}/assistant`,{method:'POST',cookie:member,data:{question:'Помоги с планом'}})).status,503);
   assert.equal((await request('/ai/settings',{method:'PATCH',cookie:member,data:{api_key:'sk-test-eventgo-12345678901234567890',model:'gpt-4.1-mini'}})).status,403);
   const key='sk-test-eventgo-12345678901234567890';const configured=await request('/ai/settings',{method:'PATCH',cookie:org,data:{api_key:key,model:'gpt-4.1-mini'}});assert.equal(configured.status,200);assert.equal(configured.body.configured,true);assert.equal(JSON.stringify(configured.body).includes(key),false);
   assert.equal(JSON.stringify((await request('/ai/settings',{cookie:member})).body).includes(key),false);
   assert.equal((await request(`/events/${eventId}/assistant?before=bad`,{cookie:org})).status,400);
   assert.equal((await request(`/events/${eventId}/assistant`,{method:'DELETE',cookie:member})).status,200);
 });

 await t.test('budget arithmetic and access',async()=>{
   const r=await request(`/events/${eventId}/expenses`,{method:'POST',cookie:org,data:{name:'Аренда',category:'Площадка',planned:9000,actual:11000}});assert.equal(r.status,201);expenseId=r.body.id;
   assert.equal((await request('/events/'+eventId,{cookie:org})).body.event.expense.actual,11000);
   assert.equal((await request('/expenses/'+expenseId,{method:'PATCH',cookie:member,data:{actual:1}})).status,403);
   assert.equal((await request('/expenses/'+expenseId,{method:'PATCH',cookie:org,data:{actual:-1}})).status,400);
 });
 await t.test('members cannot read budgets, contractor costs or analytics',async()=>{
   const result=await request('/events/'+eventId,{cookie:member});assert.equal(result.status,200);
   assert.equal(Object.hasOwn(result.body.event,'budget'),false);assert.equal(Object.hasOwn(result.body.event,'expense'),false);assert.equal(Object.hasOwn(result.body,'expenses'),false);
   assert.ok(result.body.team.every(p=>!Object.hasOwn(p,'cost')));
   const seeded=(await request('/events/1',{cookie:member})).body.guests;assert.ok(seeded.length>0);
   assert.ok([...result.body.guests,...seeded].every(g=>['ticket','email','phone','consent_at'].every(field=>!Object.hasOwn(g,field))));
   const list=(await request('/events',{cookie:member})).body;assert.ok(list.every(e=>!Object.hasOwn(e,'budget')&&!Object.hasOwn(e,'expense')));
   for(const path of [`/events/${eventId}/budget.csv`,`/events/${eventId}/report.json`,`/expenses/${expenseId}`,'/backup'])assert.equal((await request(path,{cookie:member})).status,403,path);
 });
 await t.test('program items for organizers, guests and tickets',async()=>{
   const seeded=(await request('/events/1',{cookie:org})).body.program;assert.ok(seeded.length>=5);
   assert.equal((await request(`/events/${eventId}/program`,{method:'POST',cookie:member,data:{title:'Секрет',starts_at:'2026-11-20T11:00'}})).status,403);
   assert.equal((await request(`/events/${eventId}/program`,{method:'POST',cookie:org,data:{title:'Открытие',starts_at:'2026-11-20T11:00',ends_at:'2026-11-20T10:00'}})).status,400);
   const created=await request(`/events/${eventId}/program`,{method:'POST',cookie:org,data:{title:'Открытие',starts_at:'2026-11-20T10:00',ends_at:'2026-11-20T10:30',speaker:'Александр',hall:'Главный зал',description:'Приветствие'}});assert.equal(created.status,201);
   const programId=created.body.id;
   assert.equal((await request('/program/'+programId,{method:'PATCH',cookie:org,data:{title:'Открытие дня',speaker:'Александр Войтенко'}})).status,200);
   const detail=(await request('/events/'+eventId,{cookie:member})).body;assert.equal(detail.program[0].title,'Открытие дня');assert.equal(detail.program[0].hall,'Главный зал');
   const pub=(await request('/public/'+token)).body;assert.equal(pub.program.length,1);assert.equal(pub.program[0].title,'Открытие дня');
   assert.equal((await request('/program/'+programId,{method:'DELETE',cookie:member})).status,403);
   assert.equal((await request('/program/'+programId,{method:'DELETE',cookie:org})).status,200);
   assert.equal((await request('/public/'+token)).body.program.length,0);
   const again=await request(`/events/${eventId}/program`,{method:'POST',cookie:org,data:{title:'Нетворкинг',starts_at:'2026-11-20T12:00',hall:'Холл'}});assert.equal(again.status,201);
 });
 await t.test('notifications show overdue tasks, new registrations and respect roles',async()=>{
   assert.equal((await request('/notifications')).status,401);
   const orgList=(await request('/notifications',{cookie:org})).body;
   assert.ok(orgList.items.some(n=>n.kind==='task'&&n.level==='danger'&&n.event_id===1));
   assert.ok(orgList.items.some(n=>n.kind==='guests'&&n.event_id===1&&n.unread));
   const memberList=(await request('/notifications',{cookie:member})).body;
   assert.ok(memberList.items.every(n=>n.kind==='task'));
   const memberTasks=(await request('/events/1',{cookie:member})).body.tasks.filter(t=>t.assignee_user_id===2).map(t=>t.id);
   assert.ok(memberList.items.every(n=>memberTasks.includes(n.task_id)));
   const seen=(await request('/notifications/seen',{method:'POST',cookie:org})).body;assert.equal(seen.items.some(n=>n.kind==='guests'),false);
   const forum=(await request('/events/1',{cookie:org})).body;const pub=forum.event.public_token;
   const answers={};for(const f of forum.fields)if(f.required)answers[f.id]=f.kind==='choice'?f.options[0]:f.kind==='checkbox'?'on':'да';
   assert.equal((await request('/public/'+pub,{method:'POST',data:{name:'Новый гость',email:'notify@example.com',consent:true,answers}})).status,201);
   const fresh=(await request('/notifications',{cookie:org})).body.items.find(n=>n.kind==='guests'&&n.event_id===1);assert.equal(fresh?.text,'Новых регистраций: 1');
 });
 await t.test('date warnings for past events and tasks due after the event',async()=>{
   const baseEvent={title:'Проверка дат',type:'Встреча',location:'Зал',capacity:10,budget:0};
   const past=await request('/events',{method:'POST',cookie:org,data:{...baseEvent,starts_at:'2020-01-01T10:00'}});assert.equal(past.status,201);assert.equal(past.body.status,'finished');assert.equal(past.body.warnings.length,2);assert.match(past.body.warnings[0],/прошла/);assert.match(past.body.warnings[1],/Завершено/);
   const future=await request('/events',{method:'POST',cookie:org,data:{...baseEvent,starts_at:'2026-12-01T10:00'}});assert.equal(future.status,201);assert.deepEqual(future.body.warnings,[]);const id=future.body.id;
   const early=await request(`/events/${id}/tasks`,{method:'POST',cookie:org,data:{title:'До события',due_date:'2026-11-25'}});assert.deepEqual(early.body.warnings,[]);
   const late=await request(`/events/${id}/tasks`,{method:'POST',cookie:org,data:{title:'После события',due_date:'2027-05-01'}});assert.equal(late.status,201);assert.equal(late.body.warnings.length,1);assert.match(late.body.warnings[0],/позже даты мероприятия/);
   assert.deepEqual((await request('/tasks/'+late.body.id,{method:'PATCH',cookie:org,data:{priority:'high'}})).body.warnings,[]);
   assert.equal((await request('/tasks/'+early.body.id,{method:'PATCH',cookie:org,data:{due_date:'2026-12-02'}})).body.warnings.length,1);
   const moved=await request('/events/'+id,{method:'PATCH',cookie:org,data:{starts_at:'2026-11-20T10:00'}});assert.equal(moved.status,200);assert.ok(moved.body.warnings.some(w=>w.includes('Незавершённых задач')));
   assert.deepEqual((await request('/events/'+id,{method:'PATCH',cookie:org,data:{title:'Без смены даты'}})).body.warnings,[]);
   for(const eventId of [past.body.id,id])assert.equal((await request('/events/'+eventId,{method:'DELETE',cookie:org})).status,200);
 });
 await t.test('past events finish automatically and leave the afisha',async()=>{
   const at=offset=>new Date(Date.now()+9*3600000+offset).toISOString().slice(0,16),hour=3600000;
   const baseEvent={title:'Автозавершение',type:'Встреча',location:'Зал',capacity:10,budget:0};
   assert.equal((await request('/events',{method:'POST',cookie:org,data:{...baseEvent,starts_at:'2026-12-01T10:00',ends_at:'2026-12-01T09:00'}})).status,400);
   const old=await request('/events',{method:'POST',cookie:org,data:{...baseEvent,starts_at:'2020-01-01T10:00',status:'active'}});assert.equal(old.status,201);assert.equal(old.body.status,'finished');
   const created=await request('/events',{method:'POST',cookie:org,data:{...baseEvent,title:'Двухдневное событие',starts_at:at(-hour),ends_at:at(24*hour),status:'planning'}});assert.equal(created.status,201);assert.deepEqual(created.body.warnings,[]);const id=created.body.id;
   let e=(await request('/events/'+id,{cookie:org})).body.event;assert.equal(e.status,'active');
   assert.ok((await request('/afisha')).body.some(x=>x.title==='Двухдневное событие'));assert.ok(!(await request('/afisha')).body.some(x=>x.public_token===undefined||x.title==='Автозавершение'));
   assert.equal((await request('/public/'+e.public_token,{method:'POST',data:{name:'Гость Вовремя',email:'ontime@example.com',consent:true}})).status,201);
   const raw=new DatabaseSync(join(directory,'eventgo.sqlite'));raw.prepare('UPDATE events SET ends_at=? WHERE id=?').run(at(-60000),id);raw.close();
   e=(await request('/events/'+id,{cookie:org})).body.event;assert.equal(e.status,'finished');
   assert.ok(!(await request('/afisha')).body.some(x=>x.title==='Двухдневное событие'));
   assert.equal((await request('/public/'+e.public_token)).body.event.registration_open,false);
   assert.equal((await request('/public/'+e.public_token,{method:'POST',data:{name:'Гость Поздно',email:'late@example.com',consent:true}})).status,409);
   const check=new DatabaseSync(join(directory,'eventgo.sqlite'),{readOnly:true});const log=check.prepare('SELECT actor,text FROM activities WHERE event_id=? ORDER BY id').all(id).map(a=>a.actor+': '+a.text);check.close();
   assert.ok(log.some(x=>x.startsWith('EventGo: перевёл мероприятие в статус «Идёт сейчас»')));assert.equal(log.filter(x=>x.startsWith('EventGo: завершил мероприятие автоматически')).length,1);
   const reopen=await request('/events/'+id,{method:'PATCH',cookie:org,data:{status:'active'}});assert.equal(reopen.status,200);assert.equal(reopen.body.status,'finished');assert.ok(reopen.body.warnings.some(w=>w.includes('перенесите дату окончания')));
   const extended=await request('/events/'+id,{method:'PATCH',cookie:org,data:{status:'active',ends_at:at(48*hour)}});assert.equal(extended.body.status,'active');assert.deepEqual(extended.body.warnings,[]);
   assert.equal((await request('/events/'+id,{cookie:org})).body.event.status,'active');
   for(const eventId of [old.body.id,id])assert.equal((await request('/events/'+eventId,{method:'DELETE',cookie:org})).status,200);
 });
 await t.test('contractor cost is linked to a budget expense in both directions',async()=>{
   const seeded=(await request('/events/1',{cookie:org})).body;const catering=seeded.team.find(p=>p.name==='Северный кейтеринг');assert.equal(seeded.expenses.find(x=>x.contractor_id===catering.id).name,'Кофе-брейк и обед');
   const created=await request('/events',{method:'POST',cookie:org,data:{title:'Бюджет подрядчиков',type:'Встреча',starts_at:'2026-12-15T10:00',location:'Зал',capacity:50,budget:50000}});const id=created.body.id;
   const expenses=async()=>(await request('/events/'+id,{cookie:org})).body.expenses;
   const sound=await request(`/events/${id}/team`,{method:'POST',cookie:org,data:{name:'Звук Плюс',role:'Оборудование',kind:'contractor',service:'Звук и свет',cost:30000,status:'pending'}});assert.equal(sound.status,201);assert.equal(sound.body.budget,'created');
   let list=await expenses();assert.equal(list.length,1);assert.deepEqual([list[0].name,list[0].category,list[0].planned,list[0].actual,list[0].contractor_id],['Оборудование: Звук Плюс','Оборудование',30000,0,sound.body.id]);
   const team=await request(`/events/${id}/team`,{method:'POST',cookie:org,data:{name:'Волонтёр',role:'Регистрация',kind:'team',cost:0}});assert.equal(team.body.budget,'none');
   const offBudget=await request(`/events/${id}/team`,{method:'POST',cookie:org,data:{name:'Фотограф',role:'Съёмка',kind:'contractor',cost:15000,in_budget:false}});assert.equal(offBudget.body.budget,'none');assert.equal((await expenses()).length,1);
   const raised=await request('/team/'+sound.body.id,{method:'PATCH',cookie:org,data:{name:'Звук Плюс Про',cost:60000}});assert.equal(raised.body.budget,'updated');assert.ok(raised.body.warnings.some(w=>w.includes('превышают бюджет')));
   list=await expenses();assert.equal(list[0].planned,60000);assert.equal(list[0].name,'Оборудование: Звук Плюс Про');
   assert.equal((await request('/expenses/'+list[0].id,{method:'PATCH',cookie:org,data:{planned:45000,actual:20000}})).body.contractor_synced,true);
   assert.equal((await request('/events/'+id,{cookie:org})).body.team.find(p=>p.id===sound.body.id).cost,45000);
   const added=await request('/team/'+offBudget.body.id,{method:'PATCH',cookie:org,data:{in_budget:true,expense_category:'Другое'}});assert.equal(added.body.budget,'created');
   assert.equal((await request('/team/'+offBudget.body.id,{method:'PATCH',cookie:org,data:{status:'active'}})).body.budget,'linked');
   assert.equal((await request('/team/'+offBudget.body.id,{method:'PATCH',cookie:org,data:{in_budget:false}})).body.budget,'removed');
   assert.equal((await request('/team/'+offBudget.body.id,{method:'PATCH',cookie:org,data:{cost:16000}})).body.budget,'none');
   assert.equal((await request('/team/'+sound.body.id,{method:'DELETE',cookie:org})).body.budget,'kept');
   list=await expenses();assert.equal(list.length,1);assert.equal(list[0].contractor_id,null);assert.equal(list[0].actual,20000);
   const lighting=await request(`/events/${id}/team`,{method:'POST',cookie:org,data:{name:'Свет',role:'Оборудование',kind:'contractor',cost:5000}});
   assert.equal((await request('/team/'+lighting.body.id,{method:'DELETE',cookie:org})).body.budget,'removed');assert.equal((await expenses()).length,1);
   assert.equal((await request(`/events/${id}/team`,{method:'POST',cookie:member,data:{name:'Чужой',role:'x',kind:'contractor',cost:1}})).status,403);
   assert.equal((await request('/events/'+id,{method:'DELETE',cookie:org})).status,200);
 });
 await t.test('catalog: search data, compare fields and one-click add to event',async()=>{
   assert.equal((await request('/catalog',{cookie:member})).status,403);
   const list=await request('/catalog',{cookie:org});assert.equal(list.status,200);assert.ok(list.body.length>=10);
   const venues=list.body.filter(c=>c.kind==='venue');const contractors=list.body.filter(c=>c.kind==='contractor');
   assert.ok(venues.every(c=>c.city&&c.capacity>=1&&c.price>=0));assert.ok(contractors.some(c=>c.price_unit==='guest'));
   assert.equal((await request('/catalog',{method:'POST',cookie:member,data:{kind:'venue',name:'Нет',city:'Якутск',category:'Зал',capacity:10,price:1}})).status,403);
   const created=await request('/catalog',{method:'POST',cookie:org,data:{kind:'venue',name:'Тест-холл',city:'Якутск',category:'Лофт',capacity:80,price:12000,price_unit:'event',address:'ул. Тестовая, 1',description:'Для автотеста',email:'hall@test.example',phone:'+7 900 000-00-00'}});assert.equal(created.status,201);
   assert.equal((await request('/catalog/'+created.body.id,{method:'PATCH',cookie:org,data:{price:15000}})).status,200);
   const event=await request('/events',{method:'POST',cookie:org,data:{title:'Каталог EventGo',type:'Форум',starts_at:'2026-12-10T10:00',location:'Временный адрес',capacity:100,budget:200000}});assert.equal(event.status,201);const id=event.body.id;
   const venue=list.body.find(c=>c.name==='Квартал труда');
   assert.equal((await request(`/events/${id}/catalog`,{method:'POST',cookie:member,data:{item_id:venue.id}})).status,403);
   const pick=await request(`/events/${id}/catalog`,{method:'POST',cookie:org,data:{item_id:venue.id}});assert.equal(pick.status,201);assert.equal(pick.body.kind,'venue');assert.equal(pick.body.estimate,100000);
   const afterVenue=(await request('/events/'+id,{cookie:org})).body;assert.equal(afterVenue.event.location,'Якутск, Квартал труда');assert.ok(afterVenue.expenses.some(x=>x.name.includes('Квартал труда')&&x.category==='Площадка'&&x.planned===100000));
   assert.equal((await request(`/events/${id}/catalog`,{method:'POST',cookie:org,data:{item_id:venue.id}})).status,409);
   const catering=list.body.find(c=>c.name==='Северный кейтеринг');
   const add=await request(`/events/${id}/catalog`,{method:'POST',cookie:org,data:{item_id:catering.id}});assert.equal(add.status,201);assert.equal(add.body.estimate,150000);assert.ok(add.body.warnings.some(w=>/бюджет/i.test(w)));
   const afterTeam=(await request('/events/'+id,{cookie:org})).body;const person=afterTeam.team.find(p=>p.kind==='contractor'&&p.name==='Северный кейтеринг');
   assert.ok(person);assert.equal(person.cost,150000);assert.equal(person.status,'pending');assert.ok(afterTeam.expenses.some(x=>x.name.includes('Северный кейтеринг')&&x.planned===150000&&x.category==='Кейтеринг'&&x.contractor_id===person.id));
   assert.equal((await request(`/events/${id}/catalog`,{method:'POST',cookie:org,data:{item_id:catering.id}})).status,409);
   assert.equal((await request('/catalog/'+created.body.id,{method:'DELETE',cookie:org})).status,200);
   assert.equal((await request('/events/'+id,{method:'DELETE',cookie:org})).status,200);
 });
 await t.test('guest communications: ticket mail, announcements on ticket, survey mailing',async()=>{
   const created=await request('/events',{method:'POST',cookie:org,data:{title:'Рассылки EventGo',type:'Встреча',starts_at:'2026-12-12T18:00',location:'Зал Б',capacity:10,budget:0}});assert.equal(created.status,201);const id=created.body.id;
   const pub=(await request('/events/'+id,{cookie:org})).body.event.public_token;
   const reg=await request('/public/'+pub,{method:'POST',data:{name:'Гость Рассылки',email:'mail.guest@example.com',consent:true}});assert.equal(reg.status,201);const code=reg.body.ticket;
   assert.equal((await request(`/events/${id}/guests`,{method:'POST',cookie:org,data:{name:'Второй Гость',email:'second.guest@example.com'}})).status,201);
   let outbox=(await request(`/events/${id}/outbox`,{cookie:org})).body;assert.equal(outbox.counts.ticket,2);const letter=outbox.items.find(m=>m.email==='mail.guest@example.com');assert.equal(letter.kind,'ticket');assert.ok(letter.body.includes('/ticket/'+code));assert.ok(letter.body.includes('12.12.2026'));
   assert.equal((await request('/events/1/outbox',{cookie:member})).status,403);
   assert.equal((await request(`/events/${id}/announcements`,{method:'POST',cookie:member,data:{text:'Нет прав'}})).status,403);
   assert.equal((await request(`/events/${id}/announcements`,{method:'POST',cookie:org,data:{text:'   '}})).status,400);
   const quiet=await request(`/events/${id}/announcements`,{method:'POST',cookie:org,data:{text:'Гардероб работает с 17:30.'}});assert.equal(quiet.status,201);assert.equal(quiet.body.sent,0);
   const loud=await request(`/events/${id}/announcements`,{method:'POST',cookie:org,data:{text:'Зал перенесён: встреча пройдёт в зале А на 2 этаже.',important:true,notify:true}});assert.equal(loud.status,201);assert.equal(loud.body.sent,2);
   let ticket=(await request('/ticket/'+code)).body;assert.equal(ticket.announcements.length,2);assert.equal(ticket.announcements[0].text,'Зал перенесён: встреча пройдёт в зале А на 2 этаже.');assert.equal(ticket.announcements[0].important,true);assert.equal(Object.hasOwn(ticket.announcements[0],'author'),false);
   outbox=(await request(`/events/${id}/outbox`,{cookie:org})).body;assert.equal(outbox.counts.announcement,2);assert.ok(outbox.items.find(m=>m.kind==='announcement').subject.startsWith('Важно'));
   assert.equal((await request('/announcements/'+quiet.body.id,{method:'DELETE',cookie:org})).status,200);ticket=(await request('/ticket/'+code)).body;assert.equal(ticket.announcements.length,1);
   assert.equal((await request(`/events/${id}/survey/send`,{method:'POST',cookie:org,data:{scope:'all'}})).status,409);
   const survey=await request(`/events/${id}/survey`,{method:'PUT',cookie:org,data:{title:'Как прошло?',status:'open',questions:[{text:'Оценка',kind:'rating'}]}});assert.equal(survey.status,200);
   assert.equal((await request(`/events/${id}/survey/send`,{method:'POST',cookie:org,data:{scope:'attended'}})).body.sent,0);
   const sent=await request(`/events/${id}/survey/send`,{method:'POST',cookie:org,data:{scope:'all'}});assert.equal(sent.status,200);assert.equal(sent.body.sent,2);
   assert.equal((await request(`/events/${id}/survey/send`,{method:'POST',cookie:org,data:{scope:'all'}})).body.sent,0);
   outbox=(await request(`/events/${id}/outbox`,{cookie:org})).body;const invite=outbox.items.find(m=>m.kind==='survey'&&m.email==='mail.guest@example.com');assert.ok(invite.body.includes(`/survey/${survey.body.survey.public_token}?ticket=${code}`));
   assert.equal((await request('/events/'+id,{method:'DELETE',cookie:org})).status,200);
 });
 await t.test('expected guests differ from capacity; portfolio analytics across events',async()=>{
   const base={title:'Сводка EventGo',type:'Встреча',starts_at:'2026-12-20T18:00',location:'Зал В',capacity:50,budget:1000};
   for(const bad of [60,-1,2.5,'много'])assert.equal((await request('/events',{method:'POST',cookie:org,data:{...base,expected_guests:bad}})).status,400,String(bad));
   const before=(await request('/analytics/summary',{cookie:org})).body.totals;
   const created=await request('/events',{method:'POST',cookie:org,data:{...base,expected_guests:20}});assert.equal(created.status,201);const id=created.body.id;
   let e=(await request('/events/'+id,{cookie:org})).body.event;assert.equal(e.expected_guests,20);assert.equal(e.capacity,50);
   assert.equal((await request('/events/'+id,{method:'PATCH',cookie:org,data:{...base,expected_guests:''}})).status,200);assert.equal((await request('/events/'+id,{cookie:org})).body.event.expected_guests,0);
   assert.equal((await request('/events/'+id,{method:'PATCH',cookie:org,data:{...base,expected_guests:30}})).status,200);
   const pub=(await request('/events/'+id,{cookie:org})).body.event.public_token;
   for(const n of [1,2,3])assert.equal((await request('/public/'+pub,{method:'POST',data:{name:'Гость Сводки '+n,email:`summary${n}@example.com`,consent:true}})).status,201);
   assert.equal((await request(`/events/${id}/expenses`,{method:'POST',cookie:org,data:{name:'Аренда',category:'Площадка',planned:800,actual:1500}})).status,201);
   const summary=await request('/analytics/summary',{cookie:org});assert.equal(summary.status,200);const {events,totals}=summary.body;
   const row=events.find(x=>x.id===id);assert.deepEqual([row.capacity,row.expected_guests,row.registered,row.budget,row.planned,row.actual,row.own],[50,30,3,1000,800,1500,true]);
   assert.equal(totals.events,before.events+1);assert.equal(totals.registered,before.registered+3);assert.equal(totals.expected_guests,before.expected_guests+30);assert.equal(totals.capacity,before.capacity+50);assert.equal(totals.actual,before.actual+1500);assert.equal(totals.over_budget,before.over_budget+1);
   assert.equal(totals.registered,events.reduce((a,x)=>a+x.registered,0));assert.equal(totals.by_status.planning+totals.by_status.active+totals.by_status.finished,totals.events);
   assert.equal((await request('/analytics/summary',{cookie:member})).status,403);assert.equal((await request('/analytics/summary.csv',{cookie:member})).status,403);assert.equal((await request('/analytics/summary')).status,401);
   const csv=await request('/analytics/summary.csv',{cookie:org});assert.equal(csv.status,200);assert.match(csv.headers.get('content-type'),/text\/csv/);assert.ok(csv.body.includes('Ожидаемо гостей'));assert.ok(csv.body.includes('Сводка EventGo'));
   assert.equal((await request('/events/'+id,{method:'DELETE',cookie:org})).status,200);
 });
 await t.test('event owner can be chosen and transferred; invalid owner_id is rejected',async()=>{
   const partner=await login('partner@eventgo.local','PartnerGo2026!');
   const partnerId=(await request('/me',{cookie:partner})).body.user.id;
   assert.equal((await request('/organizers',{cookie:member})).status,403);
   const list=(await request('/organizers',{cookie:org})).body;assert.ok(list.some(o=>o.email==='organizer@eventgo.local'));assert.ok(list.some(o=>o.email==='partner@eventgo.local'));
   const baseEvent={title:'Смена ответственного',type:'Встреча',starts_at:'2026-12-05T10:00',location:'Зал',capacity:20,budget:1000};
   assert.equal((await request('/events',{method:'POST',cookie:org,data:{...baseEvent,owner_id:2}})).status,400);
   assert.equal((await request('/events',{method:'POST',cookie:org,data:{...baseEvent,owner_id:'abc'}})).status,400);
   const created=await request('/events',{method:'POST',cookie:org,data:{...baseEvent,owner_id:partnerId}});assert.equal(created.status,201);const id=created.body.id;
   const detail=(await request('/events/'+id,{cookie:org})).body.event;assert.equal(detail.owner_id,partnerId);assert.equal(detail.owner_name,'Елена Соколова');
   assert.ok((await request('/events/'+id,{cookie:org})).body.team.some(p=>p.user_id===partnerId));
   assert.ok((await request('/events/'+id,{cookie:org})).body.team.some(p=>p.email==='organizer@eventgo.local'));
   assert.equal((await request('/events/'+id,{method:'PATCH',cookie:org,data:{title:'Попытка создателя'}})).status,403);
   assert.equal((await request('/events/'+id,{method:'DELETE',cookie:org})).status,403);
   assert.equal((await request('/events/'+id+'/tasks',{method:'POST',cookie:org,data:{title:'Задача соорганизатора',due_date:'2026-12-01'}})).status,201);
   assert.equal((await request('/events/'+id+'/expenses',{method:'POST',cookie:org,data:{name:'Кофе',category:'Кейтеринг',planned:500,actual:0}})).status,201);
   assert.equal((await request('/events/'+id+'/guests',{method:'POST',cookie:org,data:{name:'Гость соорганизатора',email:'coorg@example.com'}})).status,201);
   assert.equal((await request('/events/'+id,{method:'PATCH',cookie:partner,data:{title:'Ведёт Елена',owner_id:2}})).status,400);
   assert.equal((await request('/events/'+id,{method:'PATCH',cookie:partner,data:{title:'Ведёт Елена',owner_id:(await request('/me',{cookie:org})).body.user.id}})).status,200);
   const back=(await request('/events/'+id,{cookie:org})).body.event;assert.equal(back.owner_id,(await request('/me',{cookie:org})).body.user.id);assert.equal(back.title,'Ведёт Елена');
   assert.equal((await request('/events/'+id,{method:'PATCH',cookie:partner,data:{title:'Снова Елена'}})).status,403);
   assert.equal((await request('/events/'+id,{method:'DELETE',cookie:org})).status,200);
 });
 await t.test('team invitations create member accounts and grant event access',async()=>{
   const mk=async title=>(await request('/events',{method:'POST',cookie:org,data:{title,type:'Встреча',starts_at:'2026-12-01T10:00',location:'Зал',capacity:10,budget:5000}})).body.id;
   const a=await mk('Приглашения A'),b=await mk('Приглашения B');
   const addPerson=async(eventId,data)=>(await request(`/events/${eventId}/team`,{method:'POST',cookie:org,data:{role:'Волонтёр',kind:'team',...data}})).body.id;
   const personA=await addPerson(a,{name:'Ольга Новикова',email:'olga.new@example.com'}),personB=await addPerson(b,{name:'Ольга Новикова',email:'olga.new@example.com'});
   const noMail=await addPerson(a,{name:'Без почты'}),vendor=await addPerson(a,{name:'Кейтеринг',email:'food@example.com',kind:'contractor'});
   assert.equal((await request(`/team/${personA}/invite`,{method:'POST',cookie:member})).status,403);
   assert.equal((await request(`/team/${noMail}/invite`,{method:'POST',cookie:org})).status,400);
   assert.equal((await request(`/team/${vendor}/invite`,{method:'POST',cookie:org})).status,400);
   const invite=await request(`/team/${personA}/invite`,{method:'POST',cookie:org});assert.equal(invite.status,201);assert.match(invite.body.token,/^[a-f0-9]{48}$/);assert.equal(invite.body.existing,false);
   assert.ok((await request('/events/'+a,{cookie:org})).body.team.find(p=>p.id===personA).invite_expires>Date.now());
   assert.equal((await fetch(base+'/invite/'+invite.body.token)).status,200);
   const info=await request('/invite/'+invite.body.token);assert.equal(info.status,200);assert.equal(info.body.email,'olga.new@example.com');assert.equal(info.body.existing,false);assert.equal(info.body.event_title,'Приглашения A');
   assert.equal((await request('/invite/'+'0'.repeat(48))).status,404);
   assert.equal((await request('/invite/'+invite.body.token,{method:'POST',data:{name:'Ольга',password:'short'}})).status,400);
   const accepted=await request('/invite/'+invite.body.token,{method:'POST',data:{name:'Ольга Новикова',password:'OlgaPass2026!'}});assert.equal(accepted.status,200);assert.equal(accepted.body.event_id,a);
   const olga=accepted.headers.get('set-cookie').split(';')[0];
   assert.equal((await request('/me',{cookie:olga})).body.user.role,'member');
   const view=await request('/events/'+a,{cookie:olga});assert.equal(view.status,200);assert.equal(view.body.event.expense,undefined);assert.equal(view.body.expenses,undefined);assert.equal(view.body.team.every(p=>!Object.hasOwn(p,'invite_expires')),true);
   assert.equal((await request('/events/'+b,{cookie:olga})).status,403);
   assert.equal((await request('/invite/'+invite.body.token,{method:'POST',data:{password:'OlgaPass2026!'}})).status,410);
   assert.equal((await request(`/team/${personA}/invite`,{method:'POST',cookie:org})).status,409);
   assert.equal((await request('/events/'+a,{cookie:org})).body.team.find(p=>p.id===personA).user_id,accepted.body.user.id);
   const first=(await request(`/team/${personB}/invite`,{method:'POST',cookie:org})).body,second=(await request(`/team/${personB}/invite`,{method:'POST',cookie:org})).body;
   assert.equal(second.existing,true);assert.equal((await request('/invite/'+first.token)).status,404);
   assert.equal((await request('/invite/'+second.token)).body.existing,true);
   assert.equal((await request('/invite/'+second.token,{method:'POST',data:{password:'WrongPass2026!'}})).status,401);
   assert.equal((await request('/invite/'+second.token,{method:'POST',data:{password:'OlgaPass2026!'}})).status,200);
   assert.equal((await request('/events/'+b,{cookie:olga})).status,200);
   assert.equal((await request('/team/'+personA,{method:'DELETE',cookie:org})).status,200);assert.equal((await request('/events/'+a,{cookie:olga})).status,403);
   for(const id of [a,b])assert.equal((await request('/events/'+id,{method:'DELETE',cookie:org})).status,200);
 });
 await t.test('registration form builder: custom fields, validation, answers and CSV',async()=>{
   const created=await request('/events',{method:'POST',cookie:org,data:{title:'Форма регистрации',type:'Встреча',starts_at:'2026-12-15T10:00',location:'Зал',capacity:10,budget:0}});assert.equal(created.status,201);const id=created.body.id;
   await request(`/events/${id}/team`,{method:'POST',cookie:org,data:{name:'Диана',role:'Дизайнер',email:'team@eventgo.local',kind:'team'}});
   const detail=(await request('/events/'+id,{cookie:org})).body;const publicToken=detail.event.public_token;assert.deepEqual(detail.fields,[]);
   const fields=[{label:'Секция',kind:'choice',options:['Дизайн','Код'],required:true},{label:'Размер футболки',kind:'text',required:false},{label:'Согласен на фото',kind:'checkbox',required:true}];
   assert.equal((await request(`/events/${id}/form`,{method:'PUT',cookie:member,data:{fields}})).status,403);
   assert.equal((await request(`/events/${id}/form`,{method:'PUT',cookie:org,data:{fields:[{label:'Пусто',kind:'choice',options:['Один']}]}})).status,400);
   const saved=await request(`/events/${id}/form`,{method:'PUT',cookie:org,data:{fields}});assert.equal(saved.status,200);assert.equal(saved.body.fields.length,3);
   const [section,shirt,photo]=saved.body.fields;assert.deepEqual(section.options,['Дизайн','Код']);assert.equal(photo.required,true);
   const pub=(await request('/public/'+publicToken)).body;assert.equal(pub.fields.length,3);assert.equal(Object.hasOwn(pub.fields[0],'sort_order'),false);
   const base={name:'Гость формы',email:'form@example.com',consent:true};
   assert.equal((await request('/public/'+publicToken,{method:'POST',data:{...base,answers:{[photo.id]:'on'}}})).status,400);
   assert.equal((await request('/public/'+publicToken,{method:'POST',data:{...base,answers:{[section.id]:'Танцы',[photo.id]:'on'}}})).status,400);
   assert.equal((await request('/public/'+publicToken,{method:'POST',data:{...base,answers:{[section.id]:'Код'}}})).status,400);
   const ok=await request('/public/'+publicToken,{method:'POST',data:{...base,answers:{[section.id]:'Код',[shirt.id]:' L ',[photo.id]:'on'}}});assert.equal(ok.status,201);
   const manual=await request(`/events/${id}/guests`,{method:'POST',cookie:org,data:{name:'Ручной',email:'manual-form@example.com',answers:{[section.id]:'Дизайн'}}});assert.equal(manual.status,201);
   const orgGuests=(await request('/events/'+id,{cookie:org})).body.guests;const g=orgGuests.find(x=>x.email==='form@example.com');
   assert.deepEqual(g.answers,{[section.id]:'Код',[shirt.id]:'L',[photo.id]:'Да'});assert.deepEqual(orgGuests.find(x=>x.email==='manual-form@example.com').answers,{[section.id]:'Дизайн'});
   const memberGuests=(await request('/events/'+id,{cookie:member})).body.guests;assert.equal(memberGuests.every(x=>!Object.hasOwn(x,'answers')),true);
   const csvText=(await request(`/events/${id}/guests.csv`,{cookie:org})).body;assert.ok(csvText.includes('"Секция";"Размер футболки";"Согласен на фото"'));assert.ok(csvText.includes('"Код";"L";"Да"'));assert.ok(csvText.includes('"Дизайн";"";"Нет"'));
   assert.equal((await request(`/events/${id}/form`,{method:'PUT',cookie:org,data:{fields:[{id:section.id,label:'Секция дня',kind:'choice',options:['Дизайн','Код'],required:true}]}})).status,200);
   const after=(await request('/events/'+id,{cookie:org})).body;assert.equal(after.fields.length,1);assert.equal(after.fields[0].label,'Секция дня');assert.deepEqual(after.guests.find(x=>x.email==='form@example.com').answers,{[section.id]:'Код'});
   assert.equal((await request('/events/'+id,{method:'DELETE',cookie:org})).status,200);
 });
 await t.test('post-event surveys: create, answer, analytics and ticket link',async()=>{
   const created=await request('/events',{method:'POST',cookie:org,data:{title:'Опросное событие',type:'Встреча',starts_at:'2026-12-20T10:00',location:'Зал',capacity:20,budget:0}});assert.equal(created.status,201);const id=created.body.id;
   assert.equal((await request(`/events/${id}/survey`,{cookie:member})).status,403);
   assert.equal((await request(`/events/${id}/survey`,{cookie:org})).body.survey,null);
   const saved=await request(`/events/${id}/survey`,{method:'PUT',cookie:org,data:{title:'Как прошла встреча?',description:'Коротко',status:'draft',questions:[{text:'Оценка',kind:'rating',required:true},{text:'Что понравилось?',kind:'choice',options:['Программа','Команда'],required:true},{text:'Комментарий',kind:'text',required:false}]}});
   assert.equal(saved.status,200);assert.equal(saved.body.survey.status,'draft');assert.equal(saved.body.questions.length,3);assert.equal(saved.body.responses,0);
   const token=saved.body.survey.public_token;assert.match(token,/^[a-f0-9]{32}$/);
   assert.equal((await request('/survey/'+token)).status,404);
   const guest=await request(`/events/${id}/guests`,{method:'POST',cookie:org,data:{name:'Гость опроса',email:'survey-guest@example.com'}});assert.equal(guest.status,201);
   assert.equal((await request('/ticket/'+guest.body.ticket)).body.survey_token,null);
   await request(`/events/${id}/survey`,{method:'PUT',cookie:org,data:{title:'Как прошла встреча?',description:'Коротко',status:'open',questions:saved.body.questions.map(q=>({id:q.id,text:q.text,kind:q.kind,options:q.options,required:q.required}))}});
   assert.equal((await request('/ticket/'+guest.body.ticket)).body.survey_token,token);
   const publicSurvey=await request('/survey/'+token);assert.equal(publicSurvey.status,200);assert.equal(publicSurvey.body.questions.length,3);
   assert.equal((await request('/survey/'+token,{method:'POST',data:{answers:{}}})).status,400);
   const answers={[saved.body.questions[0].id]:'5',[saved.body.questions[1].id]:'Программа',[saved.body.questions[2].id]:'Всё понравилось'};
   assert.equal((await request('/survey/'+token,{method:'POST',data:{answers,ticket:guest.body.ticket}})).status,201);
   assert.equal((await request('/survey/'+token,{method:'POST',data:{answers,ticket:guest.body.ticket}})).status,409);
   assert.equal((await request('/survey/'+token,{method:'POST',data:{answers:{[saved.body.questions[0].id]:'4',[saved.body.questions[1].id]:'Команда'}}})).status,201);
   const results=(await request(`/events/${id}/survey`,{cookie:org})).body;assert.equal(results.responses,2);assert.equal(results.average,4.5);
   assert.deepEqual(results.questions[0].counts,[0,0,0,1,1]);assert.deepEqual(results.questions[1].counts,[1,1]);
   const detail=(await request('/events/'+id,{cookie:org})).body;assert.equal(detail.survey.responses,2);assert.equal(detail.survey.average,4.5);
   const report=await request(`/events/${id}/report.json`,{cookie:org});assert.equal(report.status,200);assert.equal(report.body.survey.responses,2);
   assert.equal((await fetch(base+'/survey/'+token)).status,200);
   await request(`/events/${id}/survey`,{method:'PUT',cookie:org,data:{title:'Как прошла встреча?',status:'closed',questions:saved.body.questions.map(q=>({id:q.id,text:q.text,kind:q.kind,options:q.options,required:q.required}))}});
   assert.equal((await request('/survey/'+token,{method:'POST',data:{answers:{[saved.body.questions[0].id]:'3',[saved.body.questions[1].id]:'Программа'}}})).status,409);
   assert.equal((await request('/ticket/'+guest.body.ticket)).body.survey_token,null);
   assert.equal((await request(`/events/${id}/survey`,{method:'DELETE',cookie:org})).status,200);
   assert.equal((await request(`/events/${id}/survey`,{cookie:org})).body.survey,null);
   assert.equal((await request('/events/'+id,{method:'DELETE',cookie:org})).status,200);
 });
 await t.test('organizer adds and imports guests with limits and duplicates',async()=>{
   const created=await request('/events',{method:'POST',cookie:org,data:{title:'Импорт гостей',type:'Встреча',starts_at:'2026-12-10T10:00',location:'Зал',capacity:3,budget:0}});assert.equal(created.status,201);const id=created.body.id;
   assert.equal((await request(`/events/${id}/guests`,{method:'POST',cookie:member,data:{name:'X',email:'x@example.com'}})).status,403);
   assert.equal((await request(`/events/${id}/guests`,{method:'POST',cookie:org,data:{name:'Без почты',email:'bad'}})).status,400);
   const added=await request(`/events/${id}/guests`,{method:'POST',cookie:org,data:{name:'Ручной гость',email:'Manual@Example.com',company:'СВФУ'}});assert.equal(added.status,201);assert.match(added.body.ticket,/^[a-f0-9]{32}$/);
   assert.equal((await request(`/events/${id}/guests`,{method:'POST',cookie:org,data:{name:'Повтор',email:'manual@example.com'}})).status,409);
   assert.equal((await request(`/events/${id}/guests/import`,{method:'POST',cookie:member,data:{rows:[{name:'A',email:'a@example.com'}]}})).status,403);
   assert.equal((await request(`/events/${id}/guests/import`,{method:'POST',cookie:org,data:{rows:[]}})).status,400);
   const imported=await request(`/events/${id}/guests/import`,{method:'POST',cookie:org,data:{status:'registered',rows:[{line:2,name:'Анна',email:'anna@example.com'},{line:3,name:'Повтор',email:'MANUAL@example.com'},{line:4,name:'',email:'empty@example.com'},{line:5,name:'Анна 2',email:'anna@example.com'},{line:6,name:'Борис',email:'boris@example.com',phone:'+7 900'},{line:7,name:'Лишний',email:'extra@example.com'}]}});
   assert.equal(imported.status,200);assert.equal(imported.body.added,2);assert.deepEqual(imported.body.skipped.map(x=>x.line),[3,4,5,7]);
   const guests=(await request('/events/'+id,{cookie:org})).body.guests;assert.equal(guests.length,3);assert.equal(guests.find(g=>g.email==='boris@example.com').status,'registered');assert.equal(guests.find(g=>g.email==='manual@example.com').status,'confirmed');
   assert.equal((await request('/ticket/'+added.body.ticket)).status,200);
   assert.equal((await request('/events/'+id,{method:'DELETE',cookie:org})).status,200);
 });
 await t.test('guest afisha exposes only public event information',async()=>{
   let list=await request('/afisha');assert.equal(list.status,200);assert.ok(list.body.some(e=>e.public_token===token));
   for(const e of list.body){assert.ok(['planning','active'].includes(e.status));for(const field of ['budget','expense','expenses','owner_id','tasks','team','guests'])assert.equal(Object.hasOwn(e,field),false,field);}
   await request('/events/'+eventId,{method:'PATCH',cookie:org,data:{status:'finished'}});
   list=await request('/afisha');assert.equal(list.body.some(e=>e.public_token===token),false);
   await request('/events/'+eventId,{method:'PATCH',cookie:org,data:{status:'planning'}});
   for(const path of ['/events',`/events/${eventId}`,`/tasks/${taskId}/comments`,`/expenses/${expenseId}`,'/backup'])assert.equal((await request(path)).status,401,path);
   for(const path of ['/afisha','/my-tickets'])assert.equal((await fetch(base+path)).status,200,path);
 });
 await t.test('guest form, duplicates, capacity and consent',async()=>{
   const p={name:'=HYPERLINK("x")',email:'test@example.com',company:'<b>Тест</b>',consent:true};
   assert.equal((await request('/public/'+token,{method:'POST',data:{...p,consent:false}})).status,400);
   const r=await request('/public/'+token,{method:'POST',data:p});assert.equal(r.status,201);ticket=r.body.ticket;assert.match(ticket,/^[a-f0-9]{32}$/);
   assert.equal((await request('/public/'+token,{method:'POST',data:p})).status,409);
   assert.equal((await request('/public/'+token,{method:'POST',data:{...p,email:'second@example.com'}})).status,409);
   await request('/events/'+eventId,{method:'PATCH',cookie:org,data:{registration_open:false,capacity:2}});
   assert.equal((await request('/public/'+token,{method:'POST',data:{...p,email:'second@example.com'}})).status,409);
   const g=await request('/ticket/'+ticket);assert.equal(g.status,200);assert.equal(g.body.name,p.name);assert.equal(g.body.email,undefined);
   assert.ok(Array.isArray(g.body.program));assert.equal(g.body.program[0]?.title,'Нетворкинг');assert.equal(Object.hasOwn(g.body,'event_id'),false);
   assert.equal((await fetch(base+'/ticket/'+ticket)).status,200);
 });
 await t.test('guest cancels own registration and can register again',async()=>{
   const id=(await request('/events',{method:'POST',cookie:org,data:{title:'Отмена гостем',type:'Встреча',starts_at:'2026-12-20T10:00',location:'Зал',capacity:1,budget:0}})).body.id;
   const pub=(await request('/events/'+id,{cookie:org})).body.event.public_token;
   const guest={name:'Отменяющий гость',email:'leave@example.com',consent:true};
   const first=(await request('/public/'+pub,{method:'POST',data:guest})).body.ticket;
   assert.equal((await request('/ticket/'+first)).body.can_cancel,true);
   assert.equal((await request('/public/'+pub,{method:'POST',data:{...guest,email:'other@example.com'}})).status,409);
   const cancelled=await request('/ticket/'+first+'/cancel',{method:'POST'});assert.equal(cancelled.status,200);assert.equal(cancelled.body.status,'cancelled');
   const after=(await request('/ticket/'+first)).body;assert.equal(after.status,'cancelled');assert.equal(after.can_cancel,false);
   assert.equal((await request('/events/'+id,{cookie:org})).body.event.guests.registered,0);
   const again=await request('/public/'+pub,{method:'POST',data:guest});assert.equal(again.status,201);assert.notEqual(again.body.ticket,first);
   assert.equal((await request('/events/'+id+'/checkin',{method:'POST',cookie:org,data:{ticket:again.body.ticket}})).status,200);
   assert.equal((await request('/ticket/'+again.body.ticket+'/cancel',{method:'POST'})).status,409);
   assert.equal((await request('/ticket/'+'0'.repeat(32)+'/cancel',{method:'POST'})).status,404);
   assert.equal((await request('/events/'+id,{method:'DELETE',cookie:org})).status,200);
 });
 await t.test('check-in rejects wrong event, repeat and cancelled tickets',async()=>{
   assert.equal((await request('/events/1/checkin',{method:'POST',cookie:org,data:{ticket}})).status,404);
   assert.equal((await request(`/events/${eventId}/checkin`,{method:'POST',cookie:member,data:{ticket}})).status,403);
   assert.equal((await request(`/events/${eventId}/checkin`,{method:'POST',cookie:org,data:{ticket:'EG:'+ticket}})).status,200);
   assert.equal((await request(`/events/${eventId}/checkin`,{method:'POST',cookie:org,data:{ticket}})).status,409);
   const e=(await request('/events/'+eventId,{cookie:org})).body;assert.equal(e.event.guests.attended,1);
   const checked=e.guests.find(g=>g.ticket===ticket);
   assert.equal((await request('/guests/'+checked.id,{method:'PATCH',cookie:member,data:{status:'confirmed'}})).status,403);
   assert.equal((await request('/guests/'+checked.id,{method:'PATCH',cookie:org,data:{status:'confirmed'}})).status,200);
   const undone=(await request('/events/'+eventId,{cookie:org})).body;assert.equal(undone.event.guests.attended,0);assert.equal(undone.guests.find(g=>g.id===checked.id).checked_in_at,null);
   assert.equal((await request(`/events/${eventId}/checkin`,{method:'POST',cookie:org,data:{ticket}})).status,200);
   await request('/events/'+eventId,{method:'PATCH',cookie:org,data:{registration_open:true}});
   const r=await request('/public/'+token,{method:'POST',data:{name:'Отменённый гость',email:'cancel@example.com',consent:true}});assert.equal(r.status,201);
   const guests=(await request('/events/'+eventId,{cookie:org})).body.guests;const g=guests.find(g=>g.email==='cancel@example.com');
   await request('/guests/'+g.id,{method:'PATCH',cookie:org,data:{status:'cancelled'}});
   assert.equal((await request(`/events/${eventId}/checkin`,{method:'POST',cookie:org,data:{ticket:r.body.ticket}})).status,409);
 });
 await t.test('uploads and downloads preserve bytes; exports are safe',async()=>{
   const bytes=Buffer.from('Test attachment\nПривет!');const r=await fetch(base+`/api/events/${eventId}/files?name=${encodeURIComponent('../тест.html')}&task_id=${taskId}`,{method:'POST',headers:{Cookie:member,'X-EventGo':'1'},body:bytes});assert.equal(r.status,201);fileId=(await r.json()).id;
   const download=await fetch(base+'/api/files/'+fileId,{headers:{Cookie:org}});assert.equal(download.headers.get('content-type'),'application/octet-stream');assert.match(download.headers.get('content-disposition'),/^attachment/);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
   assert.equal((await request('/files/'+fileId)).status,401);
   const csv=await request(`/events/${eventId}/guests.csv`,{cookie:org});assert.equal(csv.status,200);assert.ok(csv.body.includes("'=HYPERLINK"));
   assert.equal((await request(`/events/${eventId}/guests.csv`,{cookie:member})).status,403);
   assert.equal((await request(`/events/${eventId}/report.json`,{cookie:org})).status,200);
 });
 await t.test('server rejects a file larger than 4 GiB before receiving its body',async()=>{
   const status=await new Promise((resolve,reject)=>{
     const req=httpRequest(base+`/api/events/${eventId}/files?name=too-large.mp4`,{method:'POST',headers:{Cookie:org,'X-EventGo':'1','Content-Length':String(MAX_FILE_BYTES+1)}},res=>{res.resume();resolve(res.statusCode);});req.on('error',reject);req.end();
   });assert.equal(status,413);const health=(await request('/health')).body;assert.equal(health.maxFileBytes,MAX_FILE_BYTES);assert.equal(health.version,JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version);
 });
 await t.test('exactly 4 GiB can be uploaded and downloaded without buffering the file',{skip:process.env.EVENTGO_TEST_LARGE_UPLOAD!=='1',timeout:600000},async()=>{
   const block=Buffer.alloc(1024*1024,0x5a),expected=createHash('sha256');
   async function* content(){for(let i=0;i<4096;i++){expected.update(block);yield block;}}
   const r=await fetch(base+`/api/events/${eventId}/files?name=boundary-4GiB.mp4`,{method:'POST',headers:{Cookie:org,'X-EventGo':'1','Content-Type':'application/octet-stream','Content-Length':String(MAX_FILE_BYTES)},body:content(),duplex:'half'});
   assert.equal(r.status,201,await r.clone().text());const file=await r.json();
   const download=await fetch(base+'/api/files/'+file.id,{headers:{Cookie:org}});assert.equal(download.status,200);assert.equal(Number(download.headers.get('content-length')),MAX_FILE_BYTES);
   const actual=createHash('sha256');let count=0;for await(const part of download.body){count+=part.length;actual.update(part);}assert.equal(count,MAX_FILE_BYTES);assert.equal(actual.digest('hex'),expected.digest('hex'));
   const detail=(await request('/events/'+eventId,{cookie:org})).body;assert.equal(detail.files.find(f=>f.id===file.id).size,MAX_FILE_BYTES);
   assert.equal((await request('/files/'+file.id,{method:'DELETE',cookie:org})).status,200);
 });
 await t.test('database backup is valid SQLite',async()=>{
   const r=await fetch(base+'/api/backup',{headers:{Cookie:org}});assert.equal(r.status,200);const file=join(directory,'test-backup.sqlite');await writeFile(file,Buffer.from(await r.arrayBuffer()));const copy=new DatabaseSync(file,{readOnly:true});assert.equal(copy.prepare('PRAGMA integrity_check').get().integrity_check,'ok');assert.equal(copy.prepare('SELECT title FROM events WHERE id=?').get(eventId).title,'Проверка переноса');copy.close();
 });
 await t.test('state survives a server restart',async()=>{
   await stop();await start();org=await login('organizer@eventgo.local','EventGo2026!');const result=await request('/events/'+eventId,{cookie:org});assert.equal(result.status,200);assert.equal(result.body.tasks[0].status,'done');assert.equal(result.body.event.expense.actual,11000);assert.equal(result.body.event.guests.attended,1);assert.equal(result.body.files[0].id,fileId);assert.equal((await request(`/events/${eventId}/chat`,{cookie:org})).body.messages.at(-1).id,chatLastId);
 });
 await t.test('cascading removal and password changes',async()=>{
   assert.equal((await request('/events/'+eventId,{method:'DELETE',cookie:org})).status,200);assert.equal((await request('/tasks/'+taskId+'/comments',{cookie:org})).status,404);assert.equal((await request('/files/'+fileId,{cookie:org})).status,404);assert.equal((await request('/ticket/'+ticket)).status,404);assert.equal((await request(`/events/${eventId}/chat`,{cookie:org})).status,404);const check=new DatabaseSync(join(directory,'eventgo.sqlite'),{readOnly:true});assert.equal(check.prepare('SELECT count(*) n FROM chat_messages WHERE event_id=?').get(eventId).n,0);assert.equal(check.prepare('SELECT count(*) n FROM program_items WHERE event_id=?').get(eventId).n,0);check.close();
   assert.equal((await request('/password',{method:'POST',cookie:org,data:{current:'EventGo2026!',password:'Changed2026!'}})).status,200);assert.equal((await request('/events',{cookie:org})).status,401);await login('organizer@eventgo.local','Changed2026!');
 });
 }finally{await stop();if(directory&&resolve(directory).startsWith(resolve(tmpdir())+ (process.platform==='win32'?'\\':'/'))&&dirname(directory)===resolve(tmpdir()))await rm(directory,{recursive:true,force:true});}
});

test('QR matrix matches independent version 3-L byte-mode reference',()=>{
 const matrix=qrMatrix('EG:0123456789abcdef0123456789abcdef');assert.equal(matrix.length,29);assert.equal(matrix[0].length,29);assert.ok(matrix.flat().every(x=>typeof x==='boolean'));
 // SHA-256 reference generated independently with ReportLab qrencoder, mask 0.
 const serialized=matrix.map(row=>row.map(x=>x?'1':'0').join('')).join('');
 assert.equal(createHash('sha256').update(serialized).digest('hex'),'8e18944f5610adbb0256e92dc8f31c6122a9edc6e8b20f4df87d829921ebb907');
 // Finder patterns and payload limits are also checked without a network dependency.
 assert.deepEqual(matrix.slice(0,7).map(r=>r.slice(0,7).map(Number).join('')),['1111111','1000001','1011101','1011101','1011101','1000001','1111111']);
 assert.throws(()=>qrMatrix('x'.repeat(54)));
});


test('chat migration preserves existing accounts, events and files',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'eventgo-migration-'));
 try{
   let db=openDatabase(folder);db.exec("DROP TABLE chat_messages; PRAGMA user_version=1; UPDATE events SET title='Существующее мероприятие' WHERE id=1");
   const before={events:db.prepare('SELECT count(*) n FROM events').get().n,users:db.prepare('SELECT count(*) n FROM users').get().n,files:db.prepare('SELECT count(*) n FROM files').get().n};db.close();
   db=openDatabase(folder);
   try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,13);assert.ok(db.prepare('PRAGMA table_info(expenses)').all().some(c=>c.name==='contractor_id'));assert.ok(db.prepare('PRAGMA table_info(events)').all().some(c=>c.name==='expected_guests'));assert.ok(db.prepare('PRAGMA table_info(events)').all().some(c=>c.name==='ends_at'));assert.equal(db.prepare('SELECT title FROM events WHERE id=1').get().title,'Существующее мероприятие');for(const table of ['events','users','files'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,before[table]);assert.equal(db.prepare('SELECT count(*) n FROM chat_messages').get().n,0);assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='program_items'").get());assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='surveys'").get());assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='registration_fields'").get());assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_items'").get());assert.ok(db.prepare('SELECT count(*) n FROM catalog_items').get().n>=10);assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='outbox'").get());assert.equal(db.prepare('SELECT count(*) n FROM announcements WHERE event_id=1').get().n,1);}finally{db.close();}
 }finally{if(dirname(folder)===resolve(tmpdir()))await rm(folder,{recursive:true,force:true});}
});
