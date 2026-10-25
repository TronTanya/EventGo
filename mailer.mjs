import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

const SECURITY = ['ssl', 'starttls', 'none'];

/** SMTP settings from environment variables; null means demo mode (letters stay in the outbox journal). */
export function mailConfig(env = process.env) {
  const host = (env.EVENTGO_SMTP_HOST || '').trim();
  if (!host) return null;
  const port = Number(env.EVENTGO_SMTP_PORT || 465);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('EVENTGO_SMTP_PORT должен быть числом от 1 до 65535.');
  const security = (env.EVENTGO_SMTP_SECURITY || (port === 465 ? 'ssl' : port === 587 ? 'starttls' : 'none')).trim().toLowerCase();
  if (!SECURITY.includes(security)) throw new Error('EVENTGO_SMTP_SECURITY: допустимо ssl, starttls или none.');
  const user = env.EVENTGO_SMTP_USER || '';
  const from = (env.EVENTGO_SMTP_FROM || user).trim();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(from)) throw new Error('Укажите адрес отправителя в EVENTGO_SMTP_FROM (или логин-почту в EVENTGO_SMTP_USER).');
  return {
    host, port, security, user, pass: env.EVENTGO_SMTP_PASS || '', from,
    fromName: env.EVENTGO_SMTP_FROM_NAME || 'EventGo',
    rejectUnauthorized: env.EVENTGO_SMTP_INSECURE !== '1',
    timeout: Number(env.EVENTGO_SMTP_TIMEOUT || 20000)
  };
}

const b64 = value => Buffer.from(value, 'utf8').toString('base64');

function encodeWord(text) {
  const chunks = [];
  let current = '';
  for (const char of String(text)) {
    if (Buffer.byteLength(current + char) > 45) { chunks.push(current); current = ''; }
    current += char;
  }
  chunks.push(current);
  return chunks.map(chunk => `=?UTF-8?B?${b64(chunk)}?=`).join('\r\n ');
}

function address(email) {
  const value = String(email || '').trim();
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(value)) throw new Error('Некорректный адрес получателя.');
  return value;
}

export function buildMessage(config, { to, toName = '', subject, text }) {
  const domain = config.from.split('@')[1];
  const body = b64(String(text).replace(/\r?\n/g, '\r\n')).replace(/.{1,76}/g, '$&\r\n');
  return [
    `From: ${encodeWord(config.fromName)} <${config.from}>`,
    `To: ${toName ? encodeWord(toName) + ' ' : ''}<${address(to)}>`,
    `Subject: ${encodeWord(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body
  ].join('\r\n');
}

function replies(socket) {
  let buffer = '', lines = [], waiting = null, failure = null;
  const ready = [];
  const deliver = () => { if (waiting && ready.length) { const w = waiting; waiting = null; w.resolve(ready.shift()); } };
  const fail = error => { failure ||= error; if (waiting) { const w = waiting; waiting = null; w.reject(failure); } };
  const onData = chunk => {
    buffer += chunk.toString('utf8');
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) { ready.push({ code: Number(line.slice(0, 3)), text: lines.join('\n') }); lines = []; }
    }
    deliver();
  };
  const onClose = () => fail(new Error('SMTP-сервер закрыл соединение.'));
  socket.on('data', onData);
  socket.on('error', fail);
  socket.on('close', onClose);
  const read = () => new Promise((resolve, reject) => {
    if (ready.length) return resolve(ready.shift());
    if (failure) return reject(failure);
    waiting = { resolve, reject };
  });
  read.detach = () => { socket.off('data', onData); socket.off('error', fail); socket.off('close', onClose); socket.pause(); socket.setTimeout(0); };
  return read;
}

function open(config, socket) {
  return new Promise((resolve, reject) => {
    const options = { host: config.host, port: config.port, servername: config.host, rejectUnauthorized: config.rejectUnauthorized };
    const connection = socket ? tls.connect({ ...options, socket }) : config.security === 'ssl' ? tls.connect(options) : net.connect(options);
    const ready = socket || config.security === 'ssl' ? 'secureConnect' : 'connect';
    connection.setTimeout(config.timeout, () => connection.destroy(new Error('SMTP-сервер не отвечает.')));
    connection.once(ready, () => { connection.off('error', reject); resolve(connection); });
    connection.once('error', reject);
  });
}

/** Sends one plain-text letter. Throws an Error with the server reply when delivery is refused. */
export async function sendMail(config, letter) {
  const message = buildMessage(config, letter);
  let socket = await open(config);
  let read = replies(socket);
  const command = async (line, expected) => {
    if (line !== null) socket.write(line + '\r\n');
    const reply = await read();
    if (!expected.includes(reply.code)) throw new Error(`SMTP ${reply.code}: ${reply.text.replace(/\s+/g, ' ').slice(0, 300)}`);
    return reply;
  };
  try {
    await command(null, [220]);
    const name = config.from.split('@')[1];
    let hello = await command(`EHLO ${name}`, [250]);
    if (config.security === 'starttls') {
      if (!/STARTTLS/i.test(hello.text)) throw new Error('Сервер не поддерживает STARTTLS. Укажите EVENTGO_SMTP_SECURITY=ssl и порт 465.');
      await command('STARTTLS', [220]);
      read.detach();
      socket = await open(config, socket);
      read = replies(socket);
      hello = await command(`EHLO ${name}`, [250]);
    }
    if (config.user) {
      if (/AUTH[ =][^\n]*\bPLAIN\b/i.test(hello.text)) await command('AUTH PLAIN ' + b64(`\0${config.user}\0${config.pass}`), [235]);
      else {
        await command('AUTH LOGIN', [334]);
        await command(b64(config.user), [334]);
        await command(b64(config.pass), [235]);
      }
    }
    await command(`MAIL FROM:<${config.from}>`, [250]);
    await command(`RCPT TO:<${address(letter.to)}>`, [250, 251]);
    await command('DATA', [354]);
    await command(message + '\r\n.', [250]);
    await command('QUIT', [221]).catch(() => {});
  } finally {
    socket.destroy();
  }
}
