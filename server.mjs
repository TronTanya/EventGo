import http from 'node:http';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, extname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { backup } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { openDatabase } from './db.mjs';
import { AIService } from './ai-service.mjs';
import { MAX_FILE_BYTES, receiveUpload, downloadFile } from './file-storage.mjs';

const ROOT=dirname(fileURLToPath(import.meta.url));
const DATA=resolve(process.env.EVENTGO_DATA_DIR || join(ROOT,'data'));
const db=openDatabase(DATA);
const aiService=new AIService({db});
const PORT=Number(process.env.PORT || 3000);
const HOST=process.env.HOST || '127.0.0.1';
const all=(sql,...args)=>db.prepare(sql).all(...args);
const one=(sql,...args)=>db.prepare(sql).get(...args);
const run=(sql,...args)=>db.prepare(sql).run(...args);
const sha=x=>createHash('sha256').update(x).digest('hex');
const publicUser=u=>({id:u.id,name:u.name,email:u.email,role:u.role});
const activity=(id,u,text)=>run('INSERT INTO activities(event_id,actor,text) VALUES(?,?,?)',id,u.name,text);
function fail(status,message){throw Object.assign(new Error(message),{status});}
function json(res,status,data,headers={}) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(JSON.stringify(data));}
function str(value,label,max=500,required=true){if(typeof value!=='string'||value.length>max||(required&&!value.trim()))fail(400,`Проверьте поле «${label}».`);return value.trim();}
function num(value,label,max=1e10){if(typeof value!=='number'||!Number.isFinite(value)||value<0||value>max)fail(400,`Проверьте поле «${label}».`);return value;}
function choice(value,options,label){if(!options.includes(value))fail(400,`Некорректное значение: ${label}.`);return value;}
function date(value,withTime=false){const pattern=withTime?/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/:/^\d{4}-\d{2}-\d{2}$/;if(typeof value!=='string'||!pattern.test(value)||!Number.isFinite(Date.parse(value))||new Date(value.slice(0,10)+'T12:00:00Z').toISOString().slice(0,10)!==value.slice(0,10)|| (withTime && (+value.slice(11,13)>23 || +value.slice(14,16)>59)))fail(400,'Укажите корректную дату.');return value;}
function email(value){const s=str(value,'Электронная почта',200).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s))fail(400,'Укажите корректный адрес почты.');return s;}
async function body(req,limit=65536){let size=0,parts=[];for await(const part of req){size+=part.length;if(size>limit)fail(413,'Запрос слишком большой.');parts.push(part);}return Buffer.concat(parts);}
async function payload(req,limit){try{const value=JSON.parse((await body(req,limit)).toString());if(!value||typeof value!=='object'||Array.isArray(value))fail(400,'Передайте данные формы в виде объекта.');return value;}catch(e){if(e.status)throw e;fail(400,'Не удалось прочитать данные формы.');}}
function userFor(req){let token;try{token=req.headers.cookie?.split(';').map(x=>x.trim()).find(x=>x.startsWith('eventgo_session='))?.slice(16);}catch{}if(!token)return null;return one('SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=? AND s.expires>?',sha(token),Date.now());}
function needUser(req){const u=userFor(req);if(!u)fail(401,'Войдите в аккаунт.');return u;}
function organizer(u){if(u.role!=='organizer')fail(403,'Это действие доступно организатору.');}
function eventFor(id,u){const e=one('SELECT * FROM events WHERE id=?',id);if(!e)fail(404,'Мероприятие не найдено.');if(e.owner_id!==u.id&&!one('SELECT id FROM team WHERE event_id=? AND user_id=?',id,u.id))fail(403,'У вас нет доступа к мероприятию.');return e;}
function manage(id,u){const e=eventFor(id,u);organizer(u);if(e.owner_id!==u.id)fail(403,'Изменения доступны владельцу мероприятия.');return e;}
function taskFor(id,u,write=false){const t=one('SELECT * FROM tasks WHERE id=?',id);if(!t)fail(404,'Задача не найдена.');eventFor(t.event_id,u);if(write&&u.role!=='organizer'&&!one('SELECT id FROM team WHERE id=? AND user_id=?',t.assignee_id,u.id))fail(403,'Вы можете изменять только назначенные вам задачи.');return t;}
function summary(e,u){const tasks=one("SELECT count(*) total,coalesce(sum(status='done'),0) done,coalesce(sum(status!='done' AND due_date<date('now','+9 hours')),0) overdue,coalesce(sum(status='progress'),0) progress FROM tasks WHERE event_id=?",e.id);const guests=one("SELECT count(*) total,coalesce(sum(status!='cancelled'),0) registered,coalesce(sum(status='attended'),0) attended FROM guests WHERE event_id=?",e.id);const expense=one('SELECT coalesce(sum(planned),0) planned,coalesce(sum(actual),0) actual FROM expenses WHERE event_id=?',e.id);const result={...e,tasks,guests,expense,readiness:tasks.total?Math.round(tasks.done/tasks.total*100):0};if(u?.role!=='organizer'){delete result.budget;delete result.expense;}return result;}
function safeTeam(rows,u){return rows.map(row=>{if(u.role==='organizer')return row;const {cost,...safe}=row;return safe;});}
function safeGuests(rows,u){if(u.role==='organizer')return rows;return rows.map(({id,event_id,name,company,status,checked_in_at,created_at})=>({id,event_id,name,company,status,checked_in_at,created_at}));}
function notificationsFor(u){
 const events=all('SELECT DISTINCT e.* FROM events e LEFT JOIN team t ON t.event_id=e.id WHERE e.owner_id=? OR t.user_id=?',u.id,u.id);if(!events.length)return {items:[],unread:0};
 const ids=events.map(e=>e.id),marks=ids.map(()=>'?').join(','),day=one("SELECT date('now','+9 hours') d").d;
 const state=one('SELECT seen_guest_id FROM notification_state WHERE user_id=?',u.id);
 const newGuests=state?['id>?',state.seen_guest_id]:["created_at>datetime('now','-1 day') AND ?=0",0];
 const items=[];
 const tasks=all(`SELECT t.id,t.title,t.due_date,t.event_id,e.title event_title FROM tasks t JOIN events e ON e.id=t.event_id LEFT JOIN team m ON m.id=t.assignee_id WHERE t.event_id IN (${marks}) AND t.status!='done' AND t.due_date<=date(?, '+1 day')${u.role==='organizer'?'':' AND m.user_id=?'} ORDER BY t.due_date,t.id LIMIT 50`,...ids,day,...(u.role==='organizer'?[]:[u.id]));
 for(const t of tasks){const overdue=t.due_date<day;items.push({kind:'task',level:overdue?'danger':'warning',event_id:t.event_id,event_title:t.event_title,task_id:t.id,date:t.due_date,text:overdue?`Просрочена задача «${t.title}»`:t.due_date===day?`Сегодня срок задачи «${t.title}»`:`Завтра срок задачи «${t.title}»`,unread:false});}
 if(u.role==='organizer'){
   const owned=events.filter(e=>e.owner_id===u.id);
   for(const e of owned){const r=one(`SELECT count(*) n,max(created_at) last FROM guests WHERE event_id=? AND ${newGuests[0]}`,e.id,newGuests[1]);if(r.n)items.push({kind:'guests',level:'info',event_id:e.id,event_title:e.title,date:r.last,text:`Новых регистраций: ${r.n}`,unread:true});
     const spent=one('SELECT coalesce(sum(actual),0) actual FROM expenses WHERE event_id=?',e.id).actual;if(spent>e.budget)items.push({kind:'budget',level:'danger',event_id:e.id,event_title:e.title,text:`Бюджет превышен на ${Math.round(spent-e.budget).toLocaleString('ru-RU')} ₽`,unread:false});}
 }
 const order={danger:0,warning:1,info:2};items.sort((a,b)=>order[a.level]-order[b.level]);
 return {items,unread:items.filter(x=>x.unread||x.level==='danger').length};
}
function surveyOf(eventId){return one('SELECT * FROM surveys WHERE event_id=? ORDER BY id LIMIT 1',eventId);}
function surveyQuestions(surveyId){return all('SELECT * FROM survey_questions WHERE survey_id=? ORDER BY sort_order,id',surveyId).map(q=>({...q,required:!!q.required,options:q.options?q.options.split('\n'):[]}));}
function surveyResults(survey){
 const questions=surveyQuestions(survey.id),responses=one('SELECT count(*) n FROM survey_responses WHERE survey_id=?',survey.id).n;
 const results=questions.map(q=>{const values=all('SELECT a.value FROM survey_answers a WHERE a.question_id=?',q.id).map(x=>x.value);
   if(q.kind==='rating'){const counts=[1,2,3,4,5].map(n=>values.filter(v=>Number(v)===n).length);return {...q,answers:values.length,average:values.length?Math.round(values.reduce((s,v)=>s+Number(v),0)/values.length*10)/10:null,counts};}
   if(q.kind==='choice')return {...q,answers:values.length,counts:q.options.map(o=>values.filter(v=>v===o).length)};
   return {...q,answers:values.length,texts:all('SELECT a.value,r.created_at FROM survey_answers a JOIN survey_responses r ON r.id=a.response_id WHERE a.question_id=? ORDER BY a.id DESC LIMIT 100',q.id)};});
 const firstRating=results.find(q=>q.kind==='rating'&&q.average!==null);
 return {survey,questions:results,responses,average:firstRating?.average??null};
}
function surveySummary(eventId){const survey=surveyOf(eventId);if(!survey)return null;const r=surveyResults(survey);return {status:survey.status,responses:r.responses,average:r.average};}
function surveyQuestionValues(list){if(!Array.isArray(list)||!list.length)fail(400,'Добавьте хотя бы один вопрос.');if(list.length>30)fail(400,'В опросе может быть не больше 30 вопросов.');return list.map((q,i)=>{const kind=choice(q.kind,['rating','text','choice'],'тип вопроса');const options=kind==='choice'?(Array.isArray(q.options)?q.options:String(q.options??'').split('\n')).map(x=>String(x).trim()).filter(Boolean):[];if(kind==='choice'&&options.length<2)fail(400,`Укажите минимум два варианта ответа в вопросе ${i+1}.`);if(options.length>20||options.some(o=>o.length>200))fail(400,`Слишком много или слишком длинные варианты в вопросе ${i+1}.`);return {id:Number.isInteger(q.id)?q.id:null,text:str(q.text,`Вопрос ${i+1}`,500),kind,options:options.join('\n'),required:q.required===false?0:1,sort_order:(i+1)*10};});}
function programOf(eventId){return all('SELECT * FROM program_items WHERE event_id=? ORDER BY starts_at, sort_order, id',eventId);}
function csv(rows){const cell=x=>'"'+String(x??'').replace(/^[\s]*[=+\-@\t\r]/,m=>"'"+m).replaceAll('"','""')+'"';return '\ufeff'+rows.map(r=>r.map(cell).join(';')).join('\r\n');}
function download(res,bytes,name,type='application/octet-stream'){res.writeHead(200,{'Content-Type':type,'Content-Disposition':`attachment; filename="download${extname(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,'Cache-Control':'no-store'});res.end(bytes);}
const attempts=new Map();
function rate(key,max=12){const now=Date.now();const r=attempts.get(key);if(!r||r.until<now){attempts.set(key,{count:1,until:now+60000});return;}if(++r.count>max)fail(429,'Слишком много попыток. Попробуйте через минуту.');}
setInterval(()=>{const now=Date.now();for(const[k,v]of attempts)if(v.until<now)attempts.delete(k);run('DELETE FROM sessions WHERE expires<?',now);},60000).unref();

async function api(req,res,url){
 const path=url.pathname, method=req.method;
 if(method!=='GET'&&method!=='HEAD') {
   if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}` && req.headers.origin!==`https://${req.headers.host}`)fail(403,'Запрос с другого сайта запрещён.');
   if(req.headers['x-eventgo']!=='1')fail(403,'Обновите страницу и повторите действие.');
 }
 if(path==='/api/health')return json(res,200,{ok:true,version:'1.4.0',maxFileBytes:MAX_FILE_BYTES});
 if(path==='/api/login'&&method==='POST'){
   rate('login:'+req.socket.remoteAddress);const p=await payload(req);const mail=email(p.email);const password=str(p.password,'Пароль',200);const u=one('SELECT * FROM users WHERE email=?',mail);
   const [salt,hash]=(u?.password_hash || 'missing:'+ '00'.repeat(64)).split(':');const value=scryptSync(password,salt,64);if(!u||!timingSafeEqual(value,Buffer.from(hash,'hex')))fail(401,'Неверная почта или пароль.');
   const token=randomBytes(32).toString('hex');run('INSERT INTO sessions VALUES(?,?,?)',sha(token),u.id,Date.now()+86400000);
   return json(res,200,{user:publicUser(u)},{'Set-Cookie':`eventgo_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`});
 }
 if(path==='/api/logout'&&method==='POST'){const token=req.headers.cookie?.match(/(?:^|;\s*)eventgo_session=([^;]+)/)?.[1];if(token)run('DELETE FROM sessions WHERE token_hash=?',sha(token));return json(res,200,{ok:true},{'Set-Cookie':'eventgo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0'});}
 if(path==='/api/me'&&method==='GET'){const u=userFor(req);return json(res,200,{user:u?publicUser(u):null});}
 if(path==='/api/afisha'&&method==='GET')return json(res,200,all("SELECT public_token,title,type,starts_at,location,description,capacity,registration_open,status FROM events WHERE status IN ('planning','active') ORDER BY CASE WHEN status='active' THEN 0 ELSE 1 END,starts_at").map(e=>({...e,registered:one("SELECT count(*) n FROM guests WHERE event_id=? AND status!='cancelled'",one('SELECT id FROM events WHERE public_token=?',e.public_token).id).n})));
 const pub=path.match(/^\/api\/public\/([a-f0-9]{32})$/);
 if(pub){const e=one('SELECT * FROM events WHERE public_token=?',pub[1]);if(!e)fail(404,'Мероприятие не найдено.');
   if(method==='GET'){const count=one("SELECT count(*) n FROM guests WHERE event_id=? AND status!='cancelled'",e.id).n;return json(res,200,{event:{title:e.title,type:e.type,starts_at:e.starts_at,location:e.location,description:e.description,capacity:e.capacity,registration_open:!!e.registration_open&&e.status!=='finished',registered:count},program:programOf(e.id)});}
   if(method==='POST'){rate('register:'+req.socket.remoteAddress,30);const p=await payload(req);if(!e.registration_open||e.status==='finished')fail(409,'Регистрация на это мероприятие закрыта.');if(p.consent!==true)fail(400,'Подтвердите согласие на обработку данных для регистрации.');const name=str(p.name,'Имя и фамилия',120),mail=email(p.email),phone=str(p.phone??'','Телефон',40,false),company=str(p.company??'','Организация',160,false);const ticket=randomBytes(16).toString('hex');
     db.exec('BEGIN IMMEDIATE');try{if(one('SELECT id FROM guests WHERE event_id=? AND email=?',e.id,mail))fail(409,'Эта почта уже зарегистрирована. Обратитесь к организатору, чтобы получить билет.');if(one("SELECT count(*) n FROM guests WHERE event_id=? AND status!='cancelled'",e.id).n>=e.capacity)fail(409,'Свободные места закончились.');run('INSERT INTO guests(event_id,name,email,phone,company,ticket,consent_at) VALUES(?,?,?,?,?,?,?)',e.id,name,mail,phone,company,ticket,new Date().toISOString());activity(e.id,{name},'зарегистрировался на мероприятие');db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}return json(res,201,{ticket});
   }
 }
 const ticketMatch=path.match(/^\/api\/ticket\/([a-f0-9]{32})$/);
 if(ticketMatch&&method==='GET'){const g=one('SELECT g.name,g.company,g.status,g.ticket,e.id event_id,e.title,e.starts_at,e.location FROM guests g JOIN events e ON e.id=g.event_id WHERE g.ticket=?',ticketMatch[1]);if(!g)fail(404,'Билет не найден.');const {event_id,...ticket}=g;const survey=surveyOf(event_id);return json(res,200,{...ticket,program:programOf(event_id),survey_token:survey?.status==='open'?survey.public_token:null});}
 const surveyMatch=path.match(/^\/api\/survey\/([a-f0-9]{32})$/);
 if(surveyMatch){const survey=one('SELECT s.*,e.title event_title,e.id event_id FROM surveys s JOIN events e ON e.id=s.event_id WHERE s.public_token=?',surveyMatch[1]);if(!survey||survey.status==='draft')fail(404,'Опрос не найден.');const questions=surveyQuestions(survey.id);
   if(method==='GET')return json(res,200,{survey:{title:survey.title,description:survey.description,status:survey.status,event_title:survey.event_title},questions:questions.map(({id,text,kind,options,required})=>({id,text,kind,options,required}))});
   if(method==='POST'){rate('survey:'+req.socket.remoteAddress,20);if(survey.status!=='open')fail(409,'Опрос уже закрыт.');const p=await payload(req);const answers=p.answers&&typeof p.answers==='object'?p.answers:{};
     let guest=null;if(p.ticket!==undefined&&p.ticket!==''){const code=String(p.ticket).replace(/^EG:/i,'');if(!/^[a-f0-9]{32}$/.test(code))fail(400,'Некорректный код билета.');guest=one('SELECT id,name FROM guests WHERE ticket=? AND event_id=?',code,survey.event_id);if(!guest)fail(400,'Билет не относится к этому мероприятию.');if(one('SELECT id FROM survey_responses WHERE survey_id=? AND guest_id=?',survey.id,guest.id))fail(409,'Вы уже ответили на этот опрос. Спасибо!');}
     const values=[];for(const q of questions){const raw=answers[q.id]??answers[String(q.id)];const empty=raw===undefined||raw===null||String(raw).trim()==='';if(empty){if(q.required)fail(400,`Ответьте на вопрос «${q.text}».`);continue;}
       let value=String(raw).trim();if(q.kind==='rating'){if(!/^[1-5]$/.test(value))fail(400,`Поставьте оценку от 1 до 5: «${q.text}».`);}else if(q.kind==='choice'){if(!q.options.includes(value))fail(400,`Выберите вариант из списка: «${q.text}».`);}else if(value.length>2000)fail(400,'Ответ слишком длинный.');values.push([q.id,value]);}
     if(!values.length)fail(400,'Ответьте хотя бы на один вопрос.');
     db.exec('BEGIN IMMEDIATE');try{const r=run('INSERT INTO survey_responses(survey_id,guest_id,guest_name) VALUES(?,?,?)',survey.id,guest?.id??null,guest?.name??'');const rid=Number(r.lastInsertRowid);for(const [qid,value] of values)run('INSERT INTO survey_answers(response_id,question_id,value) VALUES(?,?,?)',rid,qid,value);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
     return json(res,201,{ok:true});}
   fail(405,'Действие недоступно.');
 }
 const u=needUser(req);
 if(path==='/api/ai/settings'){
   if(method==='GET')return json(res,200,{...await aiService.status(),can_configure:u.role==='organizer'});
   if(method==='PATCH'){organizer(u);const p=await payload(req);return json(res,200,{...await aiService.saveSettings({apiKey:p.api_key??'',model:p.model,provider:p.provider}),can_configure:true});}
   fail(405,'Действие недоступно.');
 }
 if(path==='/api/password'&&method==='POST'){const p=await payload(req);const current=str(p.current,'Текущий пароль',200);const [salt,hash]=u.password_hash.split(':');if(!timingSafeEqual(scryptSync(current,salt,64),Buffer.from(hash,'hex')))fail(400,'Текущий пароль неверен.');if(typeof p.password!=='string'||p.password.length<10||p.password.length>200)fail(400,'Новый пароль должен содержать от 10 до 200 символов.');const {hashPassword}=await import('./db.mjs');run('UPDATE users SET password_hash=? WHERE id=?',hashPassword(p.password),u.id);run('DELETE FROM sessions WHERE user_id=?',u.id);return json(res,200,{ok:true},{'Set-Cookie':'eventgo_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'});}
 if(path==='/api/notifications'&&method==='GET')return json(res,200,notificationsFor(u));
 if(path==='/api/notifications/seen'&&method==='POST'){const last=one('SELECT coalesce(max(id),0) id FROM guests').id;run("INSERT INTO notification_state(user_id,seen_guest_id,seen_at) VALUES(?,?,datetime('now')) ON CONFLICT(user_id) DO UPDATE SET seen_guest_id=excluded.seen_guest_id,seen_at=excluded.seen_at",u.id,last);return json(res,200,notificationsFor(u));}
 if(path==='/api/events'){
   if(method==='GET')return json(res,200,all('SELECT DISTINCT e.* FROM events e LEFT JOIN team t ON t.event_id=e.id WHERE e.owner_id=? OR t.user_id=? ORDER BY e.starts_at',u.id,u.id).map(e=>summary(e,u)));
   if(method==='POST'){organizer(u);const p=await payload(req);const values=eventValues(p);db.exec('BEGIN');try{const r=run('INSERT INTO events(title,type,starts_at,location,description,goal,capacity,budget,status,registration_open,owner_id,public_token) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',...values,u.id,randomBytes(16).toString('hex'));const id=Number(r.lastInsertRowid);run('INSERT INTO team(event_id,name,role,email,user_id) VALUES(?,?,?,?,?)',id,u.name,'Организатор',u.email,u.id);activity(id,u,'создал мероприятие');db.exec('COMMIT');return json(res,201,{id});}catch(error){db.exec('ROLLBACK');throw error;}}
 }
 const em=path.match(/^\/api\/events\/(\d+)(?:\/(.*))?$/);
 if(em){const id=Number(em[1]),part=em[2]||'', e=eventFor(id,u);
   if(!part){if(method==='GET')return json(res,200,{event:summary(e,u),tasks:all('SELECT t.*,m.name assignee_name,m.user_id assignee_user_id FROM tasks t LEFT JOIN team m ON m.id=t.assignee_id WHERE t.event_id=? ORDER BY t.due_date,t.id',id),team:safeTeam(all('SELECT * FROM team WHERE event_id=?',id),u),...(u.role==='organizer'?{expenses:all('SELECT * FROM expenses WHERE event_id=? ORDER BY id',id),survey:surveySummary(id)}:{}),guests:safeGuests(all('SELECT * FROM guests WHERE event_id=? ORDER BY id DESC',id),u),files:all('SELECT f.*,u.name author,t.title task_title FROM files f JOIN users u ON u.id=f.created_by LEFT JOIN tasks t ON t.id=f.task_id WHERE f.event_id=? ORDER BY f.id DESC',id),program:programOf(id),activities:all('SELECT * FROM activities WHERE event_id=? ORDER BY id DESC LIMIT 20',id)});
     if(method==='PATCH'){manage(id,u);const p=await payload(req),values=eventValues({...e,...p});if(values[6]<one("SELECT count(*) n FROM guests WHERE event_id=? AND status!='cancelled'",id).n)fail(400,'Количество мест не может быть меньше числа зарегистрированных гостей.');run('UPDATE events SET title=?,type=?,starts_at=?,location=?,description=?,goal=?,capacity=?,budget=?,status=?,registration_open=? WHERE id=?',...values,id);activity(id,u,'обновил параметры мероприятия');return json(res,200,{ok:true});}
     if(method==='DELETE'){manage(id,u);const files=all('SELECT stored_name FROM files WHERE event_id=?',id);run('DELETE FROM events WHERE id=?',id);await Promise.all(files.map(f=>unlink(join(DATA,'uploads',f.stored_name)).catch(()=>{})));return json(res,200,{ok:true});}
   }
   if(part==='assistant'){
     if(method==='GET'){const raw=url.searchParams.get('before');if(raw!==null&&!/^\d+$/.test(raw))fail(400,'Некорректный номер сообщения.');return json(res,200,{...aiService.history(id,u,raw===null?undefined:Number(raw)),...await aiService.status(),can_configure:u.role==='organizer'});}
     if(method==='POST'){const p=await payload(req);rate('assistant:'+u.id,12);return json(res,200,await aiService.ask(id,u,p));}
     if(method==='DELETE')return json(res,200,aiService.clear(id,u));
     fail(405,'Действие недоступно.');
   }
   if(part==='chat'){
     const select='SELECT m.id,m.event_id,m.user_id,m.text,m.created_at,u.name author,u.role author_role FROM chat_messages m JOIN users u ON u.id=m.user_id';
     if(method==='GET'){
       const after=url.searchParams.get('after'),before=url.searchParams.get('before');
       if(after!==null&&before!==null)fail(400,'Выберите одно направление загрузки сообщений.');
       const raw=after??before;let cursor=0;
       if(raw!==null){if(!/^\d+$/.test(raw)||!Number.isSafeInteger(Number(raw)))fail(400,'Некорректный номер сообщения.');cursor=Number(raw);}
       const condition=raw===null?'':after!==null?' AND m.id>?':' AND m.id<?';
       const order=after!==null?'ASC':'DESC';
       const rows=all(`${select} WHERE m.event_id=?${condition} ORDER BY m.id ${order} LIMIT 51`,id,...(raw===null?[]:[cursor]));
       const messages=rows.slice(0,50);if(order==='DESC')messages.reverse();
       return json(res,200,{messages,has_more:rows.length>50});
     }
     if(method==='POST'){
       const p=await payload(req);eventFor(id,u);rate('chat:'+u.id,90);
       const text=str(p.text,'Сообщение',4000);
       const token=p.client_token===undefined?randomBytes(16).toString('hex'):str(p.client_token,'Код сообщения',80);
       if(!/^[a-zA-Z0-9_-]{16,80}$/.test(token))fail(400,'Некорректный код сообщения.');
       const result=run('INSERT OR IGNORE INTO chat_messages(event_id,user_id,text,client_token) VALUES(?,?,?,?)',id,u.id,text,token);
       const message=one(`${select} WHERE m.event_id=? AND m.user_id=? AND m.client_token=?`,id,u.id,token);
       if(message.text!==text)fail(409,'Сообщение с этим кодом уже отправлено.');
       return json(res,result.changes?201:200,{message});
     }
     fail(405,'Действие с чатом недоступно.');
   }
   if(part==='tasks'&&method==='POST'){manage(id,u);const p=await payload(req);const values=taskValues(p,id);const r=run('INSERT INTO tasks(event_id,title,description,assignee_id,due_date,priority,status) VALUES(?,?,?,?,?,?,?)',id,...values);activity(id,u,`добавил задачу «${p.title}»`);return json(res,201,{id:Number(r.lastInsertRowid)});}
   if(part==='team'&&method==='POST'){manage(id,u);const p=await payload(req),v=teamValues(p);const account=v[2]?one('SELECT id FROM users WHERE email=?',v[2]):null;const r=run('INSERT INTO team(event_id,name,role,email,phone,kind,service,cost,status,user_id) VALUES(?,?,?,?,?,?,?,?,?,?)',id,...v,account?.id??null);activity(id,u,`добавил в команду: ${p.name}`);return json(res,201,{id:Number(r.lastInsertRowid)});}
   if(part==='expenses'&&method==='POST'){manage(id,u);const p=await payload(req);const r=run('INSERT INTO expenses(event_id,name,category,planned,actual) VALUES(?,?,?,?,?)',id,...expenseValues(p));activity(id,u,'добавил статью расходов');return json(res,201,{id:Number(r.lastInsertRowid)});}
   if(part==='survey'){organizer(u);
     if(method==='GET'){const survey=surveyOf(id);return json(res,200,survey?surveyResults(survey):{survey:null});}
     if(method==='PUT'){manage(id,u);const p=await payload(req,262144);const title=str(p.title,'Название опроса',200),description=str(p.description??'','Описание',2000,false),status=choice(p.status??'draft',['draft','open','closed'],'статус опроса'),questions=surveyQuestionValues(p.questions);
       db.exec('BEGIN IMMEDIATE');try{let survey=surveyOf(id);if(survey)run('UPDATE surveys SET title=?,description=?,status=? WHERE id=?',title,description,status,survey.id);else survey={id:Number(run('INSERT INTO surveys(event_id,title,description,status,public_token) VALUES(?,?,?,?,?)',id,title,description,status,randomBytes(16).toString('hex')).lastInsertRowid)};
         const existing=new Set(all('SELECT id FROM survey_questions WHERE survey_id=?',survey.id).map(q=>q.id)),keep=new Set();
         for(const q of questions){if(q.id&&existing.has(q.id)){run('UPDATE survey_questions SET text=?,kind=?,options=?,required=?,sort_order=? WHERE id=?',q.text,q.kind,q.options,q.required,q.sort_order,q.id);keep.add(q.id);}else run('INSERT INTO survey_questions(survey_id,text,kind,options,required,sort_order) VALUES(?,?,?,?,?,?)',survey.id,q.text,q.kind,q.options,q.required,q.sort_order);}
         for(const qid of existing)if(!keep.has(qid))run('DELETE FROM survey_questions WHERE id=?',qid);
         activity(id,u,'обновил опрос гостей');db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
       return json(res,200,surveyResults(surveyOf(id)));}
     if(method==='DELETE'){manage(id,u);run('DELETE FROM surveys WHERE event_id=?',id);return json(res,200,{ok:true});}
     fail(405,'Действие недоступно.');
   }
   if(part==='guests'&&method==='POST'){manage(id,u);const p=await payload(req);const v=guestValues(p),status=choice(p.status??'confirmed',['registered','confirmed'],'статус гостя'),ticket=randomBytes(16).toString('hex');
     db.exec('BEGIN IMMEDIATE');try{if(one('SELECT id FROM guests WHERE event_id=? AND email=?',id,v[1]))fail(409,'Гость с этой почтой уже есть в списке.');if(one("SELECT count(*) n FROM guests WHERE event_id=? AND status!='cancelled'",id).n>=e.capacity)fail(409,'Свободные места закончились.');run('INSERT INTO guests(event_id,name,email,phone,company,status,ticket,consent_at) VALUES(?,?,?,?,?,?,?,?)',id,...v,status,ticket,new Date().toISOString());activity(id,u,`добавил гостя: ${v[0]}`);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
     return json(res,201,{ticket});}
   if(part==='guests/import'&&method==='POST'){manage(id,u);const p=await payload(req,1048576);if(!Array.isArray(p.rows)||!p.rows.length)fail(400,'В файле нет строк с гостями.');if(p.rows.length>2000)fail(400,'За один раз можно загрузить не больше 2000 гостей.');const status=choice(p.status??'confirmed',['registered','confirmed'],'статус гостя');const skipped=[];let added=0;
     db.exec('BEGIN IMMEDIATE');try{let taken=one("SELECT count(*) n FROM guests WHERE event_id=? AND status!='cancelled'",id).n;const seen=new Set(all('SELECT email FROM guests WHERE event_id=?',id).map(g=>g.email));
       p.rows.forEach((row,i)=>{const line=Number.isInteger(row?.line)?row.line:i+1;let v;try{v=guestValues(row||{});}catch(error){skipped.push({line,reason:error.message});return;}if(seen.has(v[1])){skipped.push({line,reason:`Почта ${v[1]} уже есть в списке.`});return;}if(taken>=e.capacity){skipped.push({line,reason:'Свободные места закончились.'});return;}run('INSERT INTO guests(event_id,name,email,phone,company,status,ticket,consent_at) VALUES(?,?,?,?,?,?,?,?)',id,...v,status,randomBytes(16).toString('hex'),new Date().toISOString());seen.add(v[1]);taken++;added++;});
       if(added)activity(id,u,`импортировал гостей: ${added}`);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
     return json(res,200,{added,skipped});}
   if(part==='program'&&method==='POST'){manage(id,u);const p=await payload(req);const values=programValues(p);const r=run('INSERT INTO program_items(event_id,starts_at,ends_at,title,speaker,hall,description,sort_order) VALUES(?,?,?,?,?,?,?,?)',id,...values);activity(id,u,`добавил в программу: ${p.title}`);return json(res,201,{id:Number(r.lastInsertRowid)});}
   if(part==='guests.csv'&&method==='GET'){organizer(u);return download(res,csv([['Имя','Почта','Телефон','Организация','Статус','Время входа'],...all('SELECT * FROM guests WHERE event_id=? ORDER BY id',id).map(g=>[g.name,g.email,g.phone,g.company,({registered:'Зарегистрирован',confirmed:'Подтверждён',attended:'Пришёл',cancelled:'Отменён'})[g.status],g.checked_in_at])]),'participants.csv','text/csv; charset=utf-8');}
   if(part==='budget.csv'&&method==='GET'){organizer(u);return download(res,csv([['Статья','Категория','План, ₽','Факт, ₽'],...all('SELECT * FROM expenses WHERE event_id=?',id).map(x=>[x.name,x.category,x.planned,x.actual])]),'budget.csv','text/csv; charset=utf-8');}
   if(part==='report.json'&&method==='GET'){organizer(u);return download(res,JSON.stringify({generated_at:new Date().toISOString(),event:summary(e,u),survey:surveySummary(id)},null,2),'eventgo-report.json','application/json; charset=utf-8');}
   if(part==='checkin'&&method==='POST'){manage(id,u);const p=await payload(req);let code=str(p.ticket,'Код билета',300).trim();code=code.replace(/^EG:/i,'').replace(/^https?:\/\/[^/]+\/ticket\//,'');if(!/^[a-f0-9]{32}$/.test(code))fail(400,'Не удалось распознать код билета.');const g=one('SELECT * FROM guests WHERE event_id=? AND ticket=?',id,code);if(!g)fail(404,'Билет не найден на этом мероприятии.');if(g.status==='cancelled')fail(409,'Билет отменён. Вход запрещён.');if(g.checked_in_at||g.status==='attended')fail(409,'По этому билету вход уже отмечен.');run("UPDATE guests SET status='attended',checked_in_at=? WHERE id=?",new Date().toISOString(),g.id);activity(id,u,`отметил вход: ${g.name}`);return json(res,200,{name:g.name,status:'attended'});}
   if(part==='files'&&method==='POST'){if(u.role!=='organizer'&&!one('SELECT id FROM team WHERE event_id=? AND user_id=?',id,u.id))fail(403,'Нет доступа.');let name=str(url.searchParams.get('name'),'Имя файла',200);name=basename(name.replaceAll('\\','/')).replace(/[\r\n\x00-\x1f]/g,'');if(!name)fail(400,'Укажите имя файла.');const taskId=Number(url.searchParams.get('task_id'))||null;if(taskId){const t=taskFor(taskId,u,true);if(t.event_id!==id)fail(400,'Задача относится к другому мероприятию.');}const upload=await receiveUpload(req,join(DATA,'uploads'));try{const r=run('INSERT INTO files(event_id,task_id,name,stored_name,size,created_by) VALUES(?,?,?,?,?,?)',id,taskId,name,upload.storedName,upload.size,u.id);activity(id,u,`загрузил файл «${name}»`);return json(res,201,{id:Number(r.lastInsertRowid)});}catch(error){await unlink(join(DATA,'uploads',upload.storedName)).catch(()=>{});throw error;}}
 }
 const tm=path.match(/^\/api\/tasks\/(\d+)(?:\/(comments))?$/);
 if(tm){const id=Number(tm[1]),t=taskFor(id,u,method!=='GET');
   if(tm[2]==='comments'){if(method==='GET')return json(res,200,all('SELECT c.*,u.name author FROM comments c JOIN users u ON u.id=c.user_id WHERE c.task_id=? ORDER BY c.id',id));if(method==='POST'){const p=await payload(req);run('INSERT INTO comments(task_id,user_id,text) VALUES(?,?,?)',id,u.id,str(p.text,'Комментарий',3000));activity(t.event_id,u,`добавил комментарий к задаче «${t.title}»`);return json(res,201,{ok:true});}}
   if(!tm[2]&&method==='PATCH'){const p=await payload(req);if(u.role!=='organizer'&&Object.keys(p).some(k=>k!=='status'))fail(403,'Вы можете менять статус своей задачи.');run('UPDATE tasks SET title=?,description=?,assignee_id=?,due_date=?,priority=?,status=? WHERE id=?',...taskValues({...t,...p},t.event_id),id);activity(t.event_id,u,`обновил задачу «${t.title}»`);return json(res,200,{ok:true});}
   if(!tm[2]&&method==='DELETE'){manage(t.event_id,u);run('DELETE FROM tasks WHERE id=?',id);return json(res,200,{ok:true});}
 }
 const cm=path.match(/^\/api\/(team|expenses|guests|files|program)\/(\d+)$/);
 if(cm){const table=cm[1]==='program'?'program_items':cm[1],id=Number(cm[2]),item=one(`SELECT * FROM ${table} WHERE id=?`,id);if(!item)fail(404,'Запись не найдена.');eventFor(item.event_id,u);
   if(table==='files'&&method==='GET'){return await downloadFile(res,join(DATA,'uploads',item.stored_name),item.name);}
   if(table==='files'&&method==='DELETE'){if(u.role!=='organizer'&&item.created_by!==u.id)fail(403,'Вы можете удалять только свои файлы.');run('DELETE FROM files WHERE id=?',id);await unlink(join(DATA,'uploads',item.stored_name)).catch(()=>{});return json(res,200,{ok:true});}
   manage(item.event_id,u);
   if(method==='DELETE'){if(table==='team'&&item.user_id===one('SELECT owner_id FROM events WHERE id=?',item.event_id).owner_id)fail(400,'Организатор должен оставаться в команде.');run(`DELETE FROM ${table} WHERE id=?`,id);return json(res,200,{ok:true});}
   if(method==='PATCH'){const p=await payload(req);
     if(table==='expenses')run('UPDATE expenses SET name=?,category=?,planned=?,actual=? WHERE id=?',...expenseValues({...item,...p}),id);
     else if(table==='team'){const merged={...item,...p},v=teamValues(merged);const account=one('SELECT id FROM users WHERE email=?',v[2]);run('UPDATE team SET name=?,role=?,email=?,phone=?,kind=?,service=?,cost=?,status=?,user_id=? WHERE id=?',...v,account?.id??null,id);}
     else if(table==='guests'){const status=choice(p.status,['registered','confirmed','cancelled'],'статус гостя');if(item.checked_in_at||item.status==='attended'){run('UPDATE guests SET status=?,checked_in_at=NULL WHERE id=?',status,id);activity(item.event_id,u,`снял отметку входа: ${item.name}`);return json(res,200,{ok:true});}if(item.status==='cancelled'&&status!=='cancelled'){const e=one('SELECT capacity FROM events WHERE id=?',item.event_id);if(one("SELECT count(*) n FROM guests WHERE event_id=? AND status!='cancelled'",item.event_id).n>=e.capacity)fail(409,'Свободные места закончились.');}run('UPDATE guests SET status=? WHERE id=?',status,id);}
     else if(table==='program_items')run('UPDATE program_items SET starts_at=?,ends_at=?,title=?,speaker=?,hall=?,description=?,sort_order=? WHERE id=?',...programValues({...item,...p}),id);
     else fail(405,'Действие недоступно.');return json(res,200,{ok:true});
   }
 }
 if(path==='/api/backup'&&method==='GET'){organizer(u);const folder=join(DATA,'backups');mkdirSync(folder,{recursive:true});const dest=join(folder,`${randomBytes(12).toString('hex')}.sqlite`);try{await backup(db,dest);return download(res,await readFile(dest),'eventgo-backup.sqlite');}finally{await unlink(dest).catch(()=>{});}}
 fail(404,'Запрошенный адрес не найден.');
}

function eventValues(p){const capacity=num(p.capacity,'Число участников',1000000);if(!Number.isInteger(capacity)||capacity<1)fail(400,'Количество участников должно быть целым и больше нуля.');return [str(p.title,'Название',160),str(p.type,'Тип',80),date(p.starts_at,true),str(p.location,'Место',500),str(p.description??'','Описание',5000,false),str(p.goal??'','Цель',2000,false),capacity,num(p.budget,'Бюджет'),choice(p.status??'planning',['planning','active','finished'],'статус события'),p.registration_open===false||p.registration_open===0?0:1];}
function taskValues(p,eventId){const assignee=p.assignee_id?Number(p.assignee_id):null;if(assignee&&!one('SELECT id FROM team WHERE id=? AND event_id=?',assignee,eventId))fail(400,'Выберите ответственного из команды мероприятия.');return [str(p.title,'Название задачи',200),str(p.description??'','Описание',4000,false),assignee,date(p.due_date),choice(p.priority??'normal',['low','normal','high'],'приоритет'),choice(p.status??'todo',['todo','progress','done'],'статус задачи')];}
function expenseValues(p){return [str(p.name,'Статья расходов',200),str(p.category,'Категория',80),num(p.planned,'План'),num(p.actual,'Факт')];}
function teamValues(p){return [str(p.name,'Имя или компания',120),str(p.role,'Роль',120),p.email?email(p.email):'',str(p.phone??'','Телефон',40,false),choice(p.kind??'team',['team','contractor'],'тип участника'),str(p.service??'','Услуга',500,false),num(p.cost??0,'Стоимость'),choice(p.status??'active',['active','pending','done'],'статус')];}
function guestValues(p){return [str(p.name,'Имя и фамилия',120),email(p.email),str(p.phone??'','Телефон',40,false),str(p.company??'','Организация',160,false)];}
function programValues(p){const starts=date(p.starts_at,true);const ends=p.ends_at?date(p.ends_at,true):'';if(ends&&ends<starts)fail(400,'Время окончания не может быть раньше начала.');const order=p.sort_order===undefined||p.sort_order===''?0:num(Number(p.sort_order),'Порядок',100000);if(!Number.isInteger(order))fail(400,'Порядок должен быть целым числом.');return [starts,ends,str(p.title,'Название',200),str(p.speaker??'','Спикер',160,false),str(p.hall??'','Зал',120,false),str(p.description??'','Описание',2000,false),order];}

const server=http.createServer(async(req,res)=>{
 try{
   res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
   // Prevent DNS rebinding when listening on loopback; LAN mode is explicit.
   const host=req.headers.host?.split(':')[0];if(HOST==='127.0.0.1'&&!['127.0.0.1','localhost'].includes(host))fail(403,'Недопустимый адрес сервера.');
   const url=new URL(req.url,`http://${req.headers.host}`);
   if(url.pathname.startsWith('/api/'))return await api(req,res,url);
   if(req.method!=='GET'&&req.method!=='HEAD')fail(405,'Метод недоступен.');
   let file;if(['/','/afisha','/my-tickets'].includes(url.pathname)||/^\/(register|ticket|survey)\/[a-f0-9]{32}$/.test(url.pathname))file=join(ROOT,'public','index.html');else{let decoded;try{decoded=decodeURIComponent(url.pathname);}catch{fail(400,'Некорректный адрес.');}file=resolve(ROOT,'public','.'+decoded);if(!file.startsWith(join(ROOT,'public')+ '\\')&&!file.startsWith(join(ROOT,'public')+'/'))fail(403,'Нет доступа.');}
   const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.woff2':'font/woff2','.ttf':'font/ttf','.png':'image/png'};
   const bytes=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:bytes);
 }catch(error){const status=error.status||(error.code==='ENOENT'?404:500);if(status===500)console.error(error);if(!res.headersSent){if(status===413)res.setHeader('Connection','close');if(req.method==='POST')req.resume();json(res,status,{error:status===500?'Не удалось выполнить действие. Повторите попытку.':error.message});}else res.end();}
});
server.requestTimeout=2*60*60*1000;server.headersTimeout=15000;
if(process.argv.includes('--init')){db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();console.log('Database initialized.');}
else{
 let retries=0;server.on('error',error=>{if(error.code==='EADDRINUSE'&&!process.env.PORT&&retries<20){retries++;server.listen(PORT+retries,HOST);}else{console.error('Cannot start EventGo:',error.message);process.exit(1);}});
 server.listen(PORT,HOST,()=>{const port=server.address().port;const url=`http://127.0.0.1:${port}`;console.log(`\n  EventGo is ready: ${url}\n  Keep this window open. Press Ctrl+C to stop.\n`);if(process.argv.includes('--open')&&process.env.EVENTGO_NO_BROWSER!=='1'){const command=process.platform==='win32'?'cmd.exe':process.platform==='darwin'?'open':'xdg-open';const args=process.platform==='win32'?['/d','/s','/c',`start "" "${url}"`]:[url];spawn(command,args,{windowsHide:true,windowsVerbatimArguments:process.platform==='win32',stdio:'ignore'}).on('error',()=>{});}});
 const stop=()=>server.close(()=>{db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();process.exit(0);});process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
