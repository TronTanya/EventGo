import { open, unlink, stat, statfs } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { join, extname } from 'node:path';

export const MAX_FILE_BYTES = 4 * 1024 ** 3;
const error = (status, message) => Object.assign(new Error(message), { status });
export function validateFileSize(size, maximum = MAX_FILE_BYTES) {
  if (!Number.isSafeInteger(size) || size < 0) throw error(400, 'Некорректный размер файла.');
  if (size > maximum) throw error(413, 'Максимальный размер файла — 4 ГБ (4 294 967 296 байт).');
  return size;
}
// Chunks go directly to disk. Failed/interrupted uploads leave no partial file.
export async function receiveUpload(request, directory, maximum = MAX_FILE_BYTES) {
  let expected;
  if (request.headers['content-length'] !== undefined) {
    expected = validateFileSize(Number(request.headers['content-length']), maximum);
    const available = await statfs(directory);
    if (expected > available.bavail * available.bsize) throw error(507, 'На диске недостаточно свободного места для этого файла.');
  }
  const storedName = randomBytes(24).toString('hex');
  const path = join(directory, storedName);
  let file, size = 0;
  try {
    file = await open(path, 'wx');
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      validateFileSize(size, maximum);
      let offset = 0;
      while (offset < chunk.length) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.length - offset);
        if (!bytesWritten) throw error(500, 'Не удалось записать файл.');
        offset += bytesWritten;
      }
    }
    if (!size) throw error(400, 'Файл пуст.');
    if (expected !== undefined && size !== expected) throw error(400, 'Передача файла прервана. Повторите загрузку.');
    await file.close();
    file = null;
    return { storedName, size };
  } catch (failure) {
    await file?.close().catch(() => {});
    await unlink(path).catch(() => {});
    request.resume();
    if (failure.code === 'ENOSPC') throw error(507, 'На диске закончилось свободное место.');
    throw failure;
  }
}
export async function downloadFile(response, path, name) {
  const info = await stat(path);
  response.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': info.size,
    'Content-Disposition': `attachment; filename="download${extname(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'Cache-Control': 'no-store'
  });
  try { await pipeline(createReadStream(path), response); }
  catch (failure) { if (!['ERR_STREAM_PREMATURE_CLOSE','ECONNRESET'].includes(failure.code)) throw failure; }
}
