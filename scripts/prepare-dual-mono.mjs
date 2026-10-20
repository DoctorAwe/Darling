import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// Only losslessly select one channel when stereo channels are bit-identical.
const paths = process.argv.slice(2);
if (paths.length !== 2) throw new Error('Usage: node scripts/prepare-dual-mono.mjs far.wav near.wav');
const directory = resolve('.local/aec3-speech-inputs', randomUUID());
const prepared = paths.map((path, index) => {
  const source = readFileSync(path);
  if (source.toString('ascii', 0, 4) !== 'RIFF' || source.toString('ascii', 8, 12) !== 'WAVE' || source.readUInt32LE(4)+8 !== source.length) throw new Error('Invalid RIFF');
  let format, data;
  for (let p=12; p<source.length;) {
    if (p+8>source.length) throw new Error('Truncated chunk');
    const size=source.readUInt32LE(p+4), end=p+8+size;
    if (end+(size%2)>source.length) throw new Error('Truncated payload');
    const tag=source.toString('ascii',p,p+4);
    if (tag==='fmt ') { if (format) throw new Error('Duplicate fmt'); format=source.subarray(p+8,end); }
    if (tag==='data') { if (data) throw new Error('Duplicate data'); data=source.subarray(p+8,end); }
    p=end+(size%2);
  }
  if (!format || format.length<16 || format.readUInt16LE(0)!==1 || format.readUInt16LE(2)!==2 || format.readUInt32LE(4)!==48000 || format.readUInt32LE(8)!==192000 || format.readUInt16LE(12)!==4 || format.readUInt16LE(14)!==16 || !data?.length || data.length%4) throw new Error('Expected stereo PCM16 48kHz');
  const output=Buffer.alloc(44+data.length/2);
  output.write('RIFF'); output.writeUInt32LE(output.length-8,4); output.write('WAVEfmt ',8);
  output.writeUInt32LE(16,16); output.writeUInt16LE(1,20); output.writeUInt16LE(1,22);
  output.writeUInt32LE(48000,24); output.writeUInt32LE(96000,28); output.writeUInt16LE(2,32); output.writeUInt16LE(16,34);
  output.write('data',36); output.writeUInt32LE(data.length/2,40);
  for (let i=0;i<data.length;i+=4) {
    if (data.readInt16LE(i)!==data.readInt16LE(i+2)) throw new Error('Channels differ; refusing automatic conversion');
    output.writeInt16LE(data.readInt16LE(i),44+i/2);
  }
  const hash=b=>createHash('sha256').update(b).digest('hex');
  return { output, record: {source:resolve(path),sourceSha256:hash(source),output:join(directory,index===0?'far.wav':'near.wav'),outputSha256:hash(output),seconds:data.length/192000,operation:'select left channel; channels bit-identical; no gain or resampling'} };
});
mkdirSync(directory,{recursive:true});
for (const item of prepared) writeFileSync(item.record.output,item.output,{flag:'wx'});
writeFileSync(join(directory,'manifest.json'),JSON.stringify(prepared.map(x=>x.record),null,2),{flag:'wx'});
console.log(directory);
