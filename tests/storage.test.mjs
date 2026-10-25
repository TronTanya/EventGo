import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { MAX_FILE_BYTES, validateFileSize, receiveUpload } from '../file-storage.mjs';

test('file size boundary is exactly 4 GiB',()=>{
 assert.equal(MAX_FILE_BYTES,4294967296);assert.equal(validateFileSize(MAX_FILE_BYTES),MAX_FILE_BYTES);
 assert.throws(()=>validateFileSize(MAX_FILE_BYTES+1),e=>e.status===413);assert.throws(()=>validateFileSize(-1),e=>e.status===400);
});
test('interrupted and oversized streamed uploads leave no partial file',async()=>{
 const folder=await mkdtemp(join(tmpdir(),'eventgo-storage-'));
 try{
   async function* interrupted(){yield Buffer.from('partial');throw new Error('Disconnected');}
   const request=Readable.from(interrupted());request.headers={};request.on('error',()=>{});
   await assert.rejects(receiveUpload(request,folder),/Disconnected/);assert.deepEqual(await readdir(folder),[]);
   const oversized=Readable.from([Buffer.from('123456789')]);oversized.headers={};
   await assert.rejects(receiveUpload(oversized,folder,8),e=>e.status===413);assert.deepEqual(await readdir(folder),[]);
 }finally{if(dirname(folder)===resolve(tmpdir()))await rm(folder,{recursive:true,force:true});}
});
