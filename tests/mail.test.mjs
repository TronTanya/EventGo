import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mailConfig, buildMessage, sendMail } from '../mailer.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fakeSmtp({ rejectRecipient = false, requireAuth = null } = {}) {
  const letters = [];
  const server = net.createServer(socket => {
    let buffer = '', inData = false, data = '', letter = { auth: null };
    const say = line => socket.write(line + '\r\n');
    say('220 fake.smtp ready');
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') { inData = false; letter.data = data; letters.push(letter); letter = { auth: letter.auth }; data = ''; say('250 queued'); }
          else data += line + '\r\n';
          continue;
        }
        if (/^EHLO /i.test(line)) { socket.write('250-fake.smtp\r\n250-AUTH PLAIN LOGIN\r\n250 OK\r\n'); }
        else if (/^AUTH PLAIN /i.test(line)) {
          const [, user, pass] = Buffer.from(line.slice(11), 'base64').toString('utf8').split('\0');
          letter.auth = { user, pass };
          say(requireAuth && (user !== requireAuth.user || pass !== requireAuth.pass) ? '535 5.7.8 authentication failed' : '235 ok');
        }
        else if (/^MAIL FROM:/i.test(line)) { letter.from = line.slice(10); say('250 ok'); }
        else if (/^RCPT TO:/i.test(line)) { letter.to = line.slice(8); say(rejectRecipient ? '550 5.1.1 mailbox unavailable' : '250 ok'); }
        else if (/^DATA$/i.test(line)) { inData = true; say('354 go ahead'); }
        else if (/^QUIT$/i.test(line)) { say('221 bye'); socket.end(); }
        else say('502 unknown');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, letters, port: server.address().port })));
}

const decodeBody = data => Buffer.from(data.split('\r\n\r\n').slice(1).join('').replace(/\s+/g, ''), 'base64').toString('utf8');

test('mail settings: demo without host, defaults by port, validation', () => {
  assert.equal(mailConfig({}), null);
  assert.equal(mailConfig({ EVENTGO_SMTP_HOST: '  ' }), null);
  const yandex = mailConfig({ EVENTGO_SMTP_HOST: 'smtp.yandex.ru', EVENTGO_SMTP_USER: 'events@yandex.ru', EVENTGO_SMTP_PASS: 'app-pass' });
  assert.equal(yandex.port, 465); assert.equal(yandex.security, 'ssl'); assert.equal(yandex.from, 'events@yandex.ru');
  assert.equal(mailConfig({ EVENTGO_SMTP_HOST: 'h', EVENTGO_SMTP_PORT: '587', EVENTGO_SMTP_FROM: 'a@b.ru' }).security, 'starttls');
  assert.equal(mailConfig({ EVENTGO_SMTP_HOST: 'h', EVENTGO_SMTP_PORT: '1025', EVENTGO_SMTP_FROM: 'a@b.ru' }).security, 'none');
  assert.throws(() => mailConfig({ EVENTGO_SMTP_HOST: 'h' }), /отправителя/);
  assert.throws(() => mailConfig({ EVENTGO_SMTP_HOST: 'h', EVENTGO_SMTP_FROM: 'a@b.ru', EVENTGO_SMTP_SECURITY: 'tls13' }), /ssl, starttls или none/);
  assert.throws(() => mailConfig({ EVENTGO_SMTP_HOST: 'h', EVENTGO_SMTP_FROM: 'a@b.ru', EVENTGO_SMTP_PORT: '99999' }), /PORT/);
});

test('message encodes Cyrillic headers and body and refuses header injection', () => {
  const config = mailConfig({ EVENTGO_SMTP_HOST: 'h', EVENTGO_SMTP_FROM: 'events@example.ru', EVENTGO_SMTP_FROM_NAME: 'EventGo Якутск' });
  const message = buildMessage(config, { to: 'guest@example.ru', toName: 'Иван Петров', subject: 'Ваш билет: IT-Форум 2026 — очень длинное название мероприятия для проверки переноса', text: 'Здравствуйте!\n.\nСтрока с точкой' });
  assert.match(message, /^From: =\?UTF-8\?B\?/m);
  assert.match(message, /^To: =\?UTF-8\?B\?.+\?= <guest@example\.ru>$/m);
  assert.ok(message.split('\r\n').every(line => line.length <= 998));
  assert.ok(!/^\.$/m.test(message), 'body must not contain a bare dot line');
  assert.equal(decodeBody(message), 'Здравствуйте!\r\n.\r\nСтрока с точкой');
  assert.throws(() => buildMessage(config, { to: 'a@b.ru>\r\nBcc: x@y.ru', subject: 's', text: 't' }), /получателя/);
});

test('sendMail authenticates and delivers; refused recipient and bad password raise errors', async () => {
  const smtp = await fakeSmtp({ requireAuth: { user: 'events@example.ru', pass: 'secret' } });
  try {
    const base = { EVENTGO_SMTP_HOST: '127.0.0.1', EVENTGO_SMTP_PORT: String(smtp.port), EVENTGO_SMTP_SECURITY: 'none', EVENTGO_SMTP_USER: 'events@example.ru' };
    await sendMail(mailConfig({ ...base, EVENTGO_SMTP_PASS: 'secret' }), { to: 'guest@example.ru', toName: 'Гость', subject: 'Проверка', text: 'Привет' });
    assert.equal(smtp.letters.length, 1);
    assert.equal(smtp.letters[0].from, '<events@example.ru>');
    assert.equal(smtp.letters[0].to, '<guest@example.ru>');
    assert.equal(decodeBody(smtp.letters[0].data), 'Привет');
    await assert.rejects(sendMail(mailConfig({ ...base, EVENTGO_SMTP_PASS: 'wrong' }), { to: 'guest@example.ru', subject: 's', text: 't' }), /SMTP 535/);
  } finally { smtp.server.close(); }
  const refusing = await fakeSmtp({ rejectRecipient: true });
  try {
    await assert.rejects(sendMail(mailConfig({ EVENTGO_SMTP_HOST: '127.0.0.1', EVENTGO_SMTP_PORT: String(refusing.port), EVENTGO_SMTP_SECURITY: 'none', EVENTGO_SMTP_FROM: 'a@b.ru' }), { to: 'nobody@example.ru', subject: 's', text: 't' }), /SMTP 550/);
  } finally { refusing.server.close(); }
  await assert.rejects(sendMail(mailConfig({ EVENTGO_SMTP_HOST: '127.0.0.1', EVENTGO_SMTP_PORT: '1', EVENTGO_SMTP_SECURITY: 'none', EVENTGO_SMTP_FROM: 'a@b.ru', EVENTGO_SMTP_TIMEOUT: '3000' }), { to: 'x@y.ru', subject: 's', text: 't' }));
});

test('server sends registration letters through SMTP and records delivery status', async () => {
  const smtp = await fakeSmtp();
  const directory = await mkdtemp(join(tmpdir(), 'eventgo-mail-'));
  const child = spawn(process.execPath, ['--no-warnings', join(root, 'server.mjs')], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', EVENTGO_DATA_DIR: directory, EVENTGO_SECRET_DIR: join(directory, 'secrets'), OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '', EVENTGO_SMTP_HOST: '127.0.0.1', EVENTGO_SMTP_PORT: String(smtp.port), EVENTGO_SMTP_SECURITY: 'none', EVENTGO_SMTP_FROM: 'events@example.ru', EVENTGO_SMTP_USER: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  try {
    const base = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('Server start timeout: ' + out)), 15000);
      child.stdout.on('data', b => { out += b; const m = out.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); resolve(m[0]); } });
      child.stderr.on('data', b => out += b);
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + out)); });
    });
    const call = async (path, { method = 'GET', data, cookie } = {}) => {
      const r = await fetch(base + '/api' + path, { method, headers: { 'X-EventGo': '1', ...(cookie ? { Cookie: cookie } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
      return { status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
    };
    const org = (await call('/login', { method: 'POST', data: { email: 'organizer@eventgo.local', password: 'EventGo2026!' } })).cookie;
    const member = (await call('/login', { method: 'POST', data: { email: 'team@eventgo.local', password: 'TeamGo2026!' } })).cookie;
    assert.equal((await call('/mail', { cookie: org })).body.mode, 'smtp');
    assert.equal((await call('/mail', { cookie: member })).status, 403);
    const id = (await call('/events', { method: 'POST', cookie: org, data: { title: 'Почта', type: 'Встреча', starts_at: '2026-12-20T10:00', location: 'Зал', capacity: 10, budget: 0 } })).body.id;
    const token = (await call('/events/' + id, { cookie: org })).body.event.public_token;
    assert.equal((await call('/public/' + token, { method: 'POST', data: { name: 'Мария Гость', email: 'maria@example.ru', consent: true } })).status, 201);
    let outbox;
    for (let i = 0; i < 50; i++) {
      outbox = (await call(`/events/${id}/outbox`, { cookie: org })).body;
      if (outbox.items[0]?.status === 'sent') break;
      await new Promise(r => setTimeout(r, 100));
    }
    assert.equal(outbox.mail.mode, 'smtp');
    assert.equal(outbox.items[0].status, 'sent');
    assert.ok(outbox.items[0].sent_at);
    const letter = smtp.letters.find(l => l.to === '<maria@example.ru>');
    assert.ok(letter, 'letter reached SMTP server');
    assert.match(decodeBody(letter.data), /\/ticket\/[a-f0-9]{32}/);
    const tested = await call('/mail/test', { method: 'POST', cookie: org, data: { email: 'admin@example.ru' } });
    assert.equal(tested.status, 200);
    assert.ok(smtp.letters.some(l => l.to === '<admin@example.ru>'));
    assert.equal((await call(`/events/${id}/outbox/retry`, { method: 'POST', cookie: org })).body.queued, 0);
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    smtp.server.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('demo mode keeps letters in the journal without sending', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eventgo-demo-mail-'));
  const child = spawn(process.execPath, ['--no-warnings', join(root, 'server.mjs')], {
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', EVENTGO_DATA_DIR: directory, EVENTGO_SECRET_DIR: join(directory, 'secrets'), OPENAI_API_KEY: '', DEEPSEEK_API_KEY: '', EVENTGO_SMTP_HOST: '' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  try {
    const base = await new Promise((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('Server start timeout: ' + out)), 15000);
      child.stdout.on('data', b => { out += b; const m = out.match(/http:\/\/127\.0\.0\.1:\d+/); if (m) { clearTimeout(timer); assert.match(out + '', /demo mode|Mail:/); resolve(m[0]); } });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Server exited ' + code + ': ' + out)); });
    });
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'X-EventGo': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'organizer@eventgo.local', password: 'EventGo2026!' }) });
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const get = async path => (await fetch(base + '/api' + path, { headers: { Cookie: cookie } })).json();
    assert.equal((await get('/mail')).mode, 'demo');
    const outbox = await get('/events/1/outbox');
    assert.equal(outbox.mail.mode, 'demo');
    assert.ok(outbox.items.every(m => m.status === 'demo'));
    const test = await fetch(base + '/api/mail/test', { method: 'POST', headers: { 'X-EventGo': '1', Cookie: cookie, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(test.status, 409);
  } finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(directory, { recursive: true, force: true });
  }
});
