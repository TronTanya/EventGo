import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { get as httpGet, request as httpRequest } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
 processHandle=spawn(process.execPath,['--no-warnings',join(root,'server.mjs')],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',EVENTGO_DATA_DIR:directory,EVENTGO_SECRET_DIR:join(directory,'secrets'),OPENAI_API_KEY:'',OPENAI_MODEL:'',DEEPSEEK_API_KEY:'',DEEPSEEK_MODEL:'',EVENTGO_AI_PROVIDER:'openai'},stdio:['ignore','pipe','pipe'],windowsHide:true});
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
   });assert.equal(status,413);assert.equal((await request('/health')).body.maxFileBytes,MAX_FILE_BYTES);
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
   try{assert.equal(db.prepare('PRAGMA user_version').get().user_version,4);assert.equal(db.prepare('SELECT title FROM events WHERE id=1').get().title,'Существующее мероприятие');for(const table of ['events','users','files'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n,before[table]);assert.equal(db.prepare('SELECT count(*) n FROM chat_messages').get().n,0);assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='program_items'").get());}finally{db.close();}
 }finally{if(dirname(folder)===resolve(tmpdir()))await rm(folder,{recursive:true,force:true});}
});
