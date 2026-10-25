import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {connectDatabase} from '../db.mjs';
const openDatabase=async directory=>{const db=await connectDatabase(directory);db.installationId=(await db.get("SELECT value FROM app_settings WHERE key='installation_id'")).value;return db;};
import {AIService} from '../ai-service.mjs';

const key='sk-test-eventgo-12345678901234567890';
const reply=text=>new Response(JSON.stringify({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]}),{status:200,headers:{'Content-Type':'application/json'}});
test('AI assistant configuration, privacy, context and persistence',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'eventgo-ai-'));let db;
  try{
    db=await openDatabase(join(directory,'data'));const calls=[];
    const service=new AIService({db,installationId:db.installationId,provider:'openai',secretDirectory:join(directory,'secrets'),apiKey:'',model:'',fetchImpl:async(url,options)=>{calls.push({url,headers:options.headers,body:JSON.parse(options.body)});return reply('Проверочный ответ модели.');}});
    const organizer={id:1,role:'organizer'},member={id:2,role:'member'};
    assert.equal((await service.status()).configured,false);await assert.rejects(service.saveSettings({model:'gpt-4.1-mini'}),e=>e.status===400);
    await assert.rejects(service.ask(1,organizer,{question:'Помоги с планом'}),error=>error.status===503);assert.equal(calls.length,0);
    await service.saveSettings({apiKey:key,model:'gpt-4.1-mini'});const status=await service.status();assert.equal(status.configured,true);assert.equal(JSON.stringify(status).includes(key),false);
    assert.equal(JSON.stringify(await db.all('SELECT * FROM app_settings')).includes(key),false);
    await writeFile(service.configFile,'broken settings');await service.saveSettings({apiKey:key,model:'gpt-4.1-mini'});assert.equal((await service.status()).configured,true);
    await assert.rejects(service.saveSettings({apiKey:'x',model:'gpt-4.1-mini'}),e=>e.status===400);
    await assert.rejects(service.saveSettings({model:'bad\nmodel'}),e=>e.status===400);
    const token=randomUUID();
    const first=await service.ask(1,organizer,{question:'Мой личный вопрос организатора',include_context:false,client_token:token});
    assert.equal(first.turn.answer,'Проверочный ответ модели.');assert.equal(calls.length,1);assert.equal(calls[0].url,'https://api.openai.com/v1/responses');assert.equal(calls[0].body.store,false);assert.equal(calls[0].body.max_output_tokens,1200);assert.equal(calls[0].body.instructions.includes('"budget"'),false);
    assert.equal((await service.ask(1,organizer,{question:'Мой личный вопрос организатора',client_token:token})).turn.id,first.turn.id);assert.equal(calls.length,1);
    await assert.rejects(service.ask(1,organizer,{question:'Другой вопрос',client_token:token}),e=>e.status===409);
    await service.ask(1,member,{question:'Личный вопрос сотрудника',include_context:true});const memberRequest=calls.at(-1).body;
    assert.equal(memberRequest.instructions.includes('"budget"'),false);assert.equal(memberRequest.instructions.includes('350000'),false);assert.equal(memberRequest.instructions.includes('organizer@eventgo.local'),false);assert.equal(memberRequest.instructions.includes('guest1@example.com'),false);
    assert.ok(memberRequest.instructions.includes('"tasks"'));
    await service.ask(1,organizer,{question:'Сравни план и факт',include_context:true});const orgRequest=calls.at(-1).body;assert.ok(orgRequest.instructions.includes('"budget"'));assert.ok(orgRequest.instructions.includes('350000'));assert.ok(orgRequest.instructions.includes('"today_yakutsk"'));assert.ok(orgRequest.instructions.includes('"overdue":true'));assert.equal(JSON.stringify(orgRequest.input).includes('Личный вопрос сотрудника'),false);
    assert.equal((await service.history(1,organizer)).turns.length,2);assert.equal((await service.history(1,member)).turns.length,1);
    await assert.rejects(service.ask(1,{id:999,role:'member'},{question:'Чужой запрос'}),e=>e.status===403);
    await assert.rejects(service.history(1,{id:999,role:'member'}),e=>e.status===403);
    await assert.rejects(service.ask(1,member,{question:'   '}),e=>e.status===400);await assert.rejects(service.ask(1,member,{question:'x'.repeat(4001)}),e=>e.status===400);
    await db.close();db=await openDatabase(join(directory,'data'));const restored=new AIService({db,installationId:db.installationId,provider:'openai',secretDirectory:join(directory,'secrets'),apiKey:'',model:'',fetchImpl:()=>{throw new Error('No request expected');}});
    assert.equal((await restored.history(1,organizer)).turns.length,2);assert.equal((await restored.status()).configured,true);
    await restored.clear(1,organizer);assert.equal((await restored.history(1,organizer)).turns.length,0);assert.equal((await restored.history(1,member)).turns.length,1);
  }finally{await db?.close();if(dirname(directory)===resolve(tmpdir()))await rm(directory,{recursive:true,force:true});}
});
test('AI pending requests deduplicate; provider failures expose no credentials',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'eventgo-ai-'));let db;
  try{
    db=await openDatabase(join(directory,'data'));const user={id:1,role:'organizer'};let release,readyResolve,calls=0;const ready=new Promise(r=>readyResolve=r),gate=new Promise(r=>release=r);
    const service=new AIService({db,installationId:db.installationId,provider:'openai',apiKey:key,model:'gpt-4.1-mini',secretDirectory:join(directory,'secrets'),fetchImpl:async()=>{calls++;readyResolve();await gate;return reply('Ответ после ожидания.');}});
    const request={question:'Составь план',client_token:randomUUID()};const first=service.ask(1,user,request);await ready;const duplicate=service.ask(1,user,request);
    await assert.rejects(service.ask(1,user,{question:'Ещё вопрос'}),e=>e.status===409);await assert.rejects(service.clear(1,user),e=>e.status===409);
    release();const [a,b]=await Promise.all([first,duplicate]);assert.equal(a.turn.id,b.turn.id);assert.equal(calls,1);
    for(const [status,expected] of [[401,502],[403,502],[404,502],[429,429],[500,502]]){
      const failed=new AIService({db,installationId:db.installationId,provider:'openai',apiKey:key,model:'gpt-4.1-mini',secretDirectory:join(directory,'secrets'),fetchImpl:async()=>new Response('secret '+key,{status})});
      await assert.rejects(failed.ask(1,user,{question:'Ошибка '+status}),e=>e.status===expected&&!e.message.includes(key));
    }
    for(const [error,expected]of [[new TypeError('offline'),503],[Object.assign(new Error('timeout'),{name:'TimeoutError'}),504]]){
      const failed=new AIService({db,installationId:db.installationId,provider:'openai',apiKey:key,secretDirectory:join(directory,'secrets'),fetchImpl:async()=>{throw error;}});
      await assert.rejects(failed.ask(1,user,{question:'Проверка соединения'}),e=>e.status===expected);
    }
    const empty=new AIService({db,installationId:db.installationId,provider:'openai',apiKey:key,secretDirectory:join(directory,'secrets'),fetchImpl:async()=>new Response(JSON.stringify({output:[]}))});
    await assert.rejects(empty.ask(1,user,{question:'Пустой ответ'}),e=>e.status===502);
    assert.equal((await service.history(1,user)).turns.length,1);
  }finally{await db?.close();if(dirname(directory)===resolve(tmpdir()))await rm(directory,{recursive:true,force:true});}
});

test('DeepSeek uses its own endpoint, context rules and response format',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'eventgo-deepseek-'));let db;
  try{
    db=await openDatabase(join(folder,'data'));const calls=[];
    const service=new AIService({db,installationId:db.installationId,provider:'deepseek',apiKey:'sk-test-deepseek-12345678901234567890',model:'deepseek-flash',secretDirectory:join(folder,'secrets'),fetchImpl:async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return new Response(JSON.stringify({choices:[{message:{content:'DeepSeek отвечает.'},finish_reason:'stop'}]}),{status:200});}});
    assert.equal((await service.status()).provider,'DeepSeek');
    const result=await service.ask(1,{id:2,role:'member'},{question:'Как подготовить мероприятие?',include_context:true});
    assert.equal(result.turn.answer,'DeepSeek отвечает.');assert.equal(calls[0].url,'https://api.deepseek.com/chat/completions');assert.equal(calls[0].body.model,'deepseek-flash');assert.equal(calls[0].body.thinking.type,'disabled');assert.equal(calls[0].body.max_tokens,1200);assert.equal(calls[0].body.messages[0].role,'system');assert.equal(calls[0].body.messages[0].content.includes('"budget"'),false);
    assert.equal(Object.hasOwn(calls[0].body,'store'),false);
    const saved=new AIService({db,installationId:db.installationId,provider:'openai',apiKey:'',model:'',secretDirectory:join(folder,'settings')});
    await saved.saveSettings({provider:'deepseek',apiKey:'sk-test-deepseek-12345678901234567890',model:'deepseek-flash'});
    assert.equal((await saved.status()).provider_id,'deepseek');
    await assert.rejects(saved.saveSettings({provider:'openai',model:'gpt-4.1-mini'}),e=>e.status===400);
    const noBalance=new AIService({db,installationId:db.installationId,provider:'deepseek',apiKey:'sk-test-deepseek-12345678901234567890',secretDirectory:join(folder,'secrets'),fetchImpl:async()=>new Response('{}',{status:402})});
    await assert.rejects(noBalance.ask(1,{id:1,role:'organizer'},{question:'Вопрос'}),e=>e.status===402&&!e.message.includes('sk-test'));
  }finally{await db?.close();if(dirname(folder)===resolve(tmpdir()))await rm(folder,{recursive:true,force:true});}
});
