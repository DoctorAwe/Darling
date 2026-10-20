import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
const id = z.string().min(1).max(4096).refine(value => value !== 'default');
export const AudioPair = z.object({ inputId: id, outputId: id }).strict();
const Entry = AudioPair.extend({ aecEnabled: z.boolean() });
const File = z.object({ version: z.literal(1), entries: z.array(Entry).max(256) }).strict();
type Pair = z.infer<typeof AudioPair>;
// Only explicit endpoint IDs are persisted. No credentials or PCM are stored.
export class AudioPreferences {
  constructor(private path: string) {}
  private read() {
    if (!existsSync(this.path)) return { version: 1 as const, entries: [] as z.infer<typeof Entry>[] };
    if (statSync(this.path).size > 1024*1024) throw new Error('音频偏好文件过大');
    const file=File.parse(JSON.parse(readFileSync(this.path,'utf8')));
    const keys=file.entries.map(e=>JSON.stringify([e.inputId,e.outputId]));
    if (new Set(keys).size!==keys.length) throw new Error('音频偏好包含重复设备对');
    return file;
  }
  get(value: Pair) {
    const pair=AudioPair.parse(value);
    const entry=this.read().entries.find(e=>e.inputId===pair.inputId && e.outputId===pair.outputId);
    return { aecEnabled: entry?.aecEnabled ?? false, saved: !!entry };
  }
  set(value: Pair, aecEnabled: boolean) {
    const entry=Entry.parse({...AudioPair.parse(value),aecEnabled});
    const file=this.read(); // Invalid files are preserved, never silently overwritten.
    file.entries=file.entries.filter(e=>e.inputId!==entry.inputId || e.outputId!==entry.outputId);
    file.entries.push(entry); File.parse(file);
    const serialized=JSON.stringify(file,null,2);
    if (Buffer.byteLength(serialized)>1024*1024) throw new Error('音频偏好达到容量限制');
    mkdirSync(dirname(this.path),{recursive:true});
    const temporary=this.path+'.'+randomUUID()+'.tmp';
    writeFileSync(temporary,serialized,{encoding:'utf8',flag:'wx'});
    renameSync(temporary,this.path);
    return { aecEnabled, saved:true };
  }
}
