import React, { useEffect, useMemo, useState } from 'react';

type Point = { x: number; y: number };
type Rect = { x: number; y: number; width: number; height: number };

function rectangle(a: Point, b: Point): Rect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
}

export function ScreenshotSurface() {
  const [image, setImage] = useState('');
  const [start, setStart] = useState<Point>();
  const [end, setEnd] = useState<Point>();
  const [dragging, setDragging] = useState(false);
  const selection = useMemo(() => start && end ? rectangle(start, end) : undefined, [start, end]);
  const valid = !!selection && selection.width >= 4 && selection.height >= 4;
  const cancel = () => window.darling.screenshotComplete();
  const confirm = () => { if (valid) window.darling.screenshotComplete(selection); };
  useEffect(() => { const off = window.darling.subscribeScreenshot(setImage); window.darling.screenshotReady(); return off; }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') cancel();
      else if (event.key === 'Enter') confirm();
    };
    window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key);
  });
  return <div className="screenshot-surface"
    onPointerDown={event => { if ((event.target as HTMLElement).closest('.screenshot-tools')) return; const point = { x: event.clientX, y: event.clientY }; setStart(point); setEnd(point); setDragging(true); event.currentTarget.setPointerCapture(event.pointerId); }}
    onPointerMove={event => { if (dragging) setEnd({ x: event.clientX, y: event.clientY }); }}
    onPointerUp={event => { if (dragging) { setEnd({ x: event.clientX, y: event.clientY }); setDragging(false); event.currentTarget.releasePointerCapture(event.pointerId); } }}>
    {image && <img src={image} alt="屏幕截图" draggable={false}/>}
    {selection && <div className={`screenshot-selection ${valid ? '' : 'invalid'}`} style={{ left: selection.x, top: selection.y, width: selection.width, height: selection.height }}/>} 
    <div className="screenshot-hint">拖动鼠标框选截图区域 · Esc 取消</div>
    {valid && <div className="screenshot-tools" style={{ left: Math.min(selection!.x + selection!.width, window.innerWidth - 104), top: Math.min(selection!.y + selection!.height + 10, window.innerHeight - 52) }}>
      <button className="screenshot-cancel" aria-label="取消截图" onClick={cancel}>×</button>
      <button className="screenshot-confirm" aria-label="确认截图" onClick={confirm}>✓</button>
    </div>}
  </div>;
}
