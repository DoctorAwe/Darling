import React, { useEffect, useState } from 'react';
import type { Attachment } from '../../../packages/protocol/src/index';
import { Icon } from './Icon';

const sizeText = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(1)} MB`;
const extension = (name: string) => name.includes('.') ? name.split('.').pop()!.slice(0, 6).toUpperCase() : 'FILE';

export function AttachmentMessage({ attachment, group = false }: { attachment: Attachment; group?: boolean }) {
  const image = attachment.mime.startsWith('image/'); const [url, setUrl] = useState<string>(); const [open, setOpen] = useState(false); const [error, setError] = useState('');
  useEffect(() => {
    if (!image) return; let disposed = false; let objectUrl = '';
    void (group ? window.darling.groupAttachmentRead(attachment.id) : window.darling.attachmentRead(attachment.id)).then(value => { if (disposed) return; objectUrl = URL.createObjectURL(new Blob([value.data], { type: value.mime })); setUrl(objectUrl); }).catch(() => setError('图片加载失败'));
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [attachment.id, image]);
  const save = () => void (group ? window.darling.groupAttachmentSave(attachment.id, attachment.name) : window.darling.attachmentSave(attachment.id, attachment.name)).then(result => { if (!result.ok && !result.cancelled) setError(result.error ?? '保存失败'); });
  return <>
    {image ? <button className="attachment-image" data-preview-state={url ? 'ready' : error ? 'error' : 'loading'} onClick={() => setOpen(true)} disabled={!url}>{url ? <img src={url} alt={attachment.name}/> : <span>{error || '正在加载图片…'}</span>}<small>{attachment.name} · {sizeText(attachment.size)}</small></button>
      : <button className="attachment-file" onClick={() => setOpen(true)}><span className="file-type">{extension(attachment.name)}</span><span><strong>{attachment.name}</strong><small>{attachment.mime} · {sizeText(attachment.size)}</small></span><Icon name="download"/></button>}
    {open && <div className="attachment-modal" role="dialog" aria-modal="true" aria-label={attachment.name} onClick={() => setOpen(false)}><div className={`attachment-dialog ${image ? 'image-dialog' : ''}`} onClick={event => event.stopPropagation()}><header><div><strong>{attachment.name}</strong><span>{attachment.mime} · {sizeText(attachment.size)}</span></div><button aria-label="关闭" onClick={() => setOpen(false)}>×</button></header>{image && url ? <img src={url} alt={attachment.name}/> : !image ? <div className="file-detail"><span className="file-type large">{extension(attachment.name)}</span><p>文件大小：{sizeText(attachment.size)}</p><p>文件类型：{attachment.mime}</p></div> : null}<footer>{error && <span>{error}</span>}<button className="save-attachment" onClick={save}><Icon name="download"/>保存到电脑</button></footer></div></div>}
  </>;
}
