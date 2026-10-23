import { useCallback, useLayoutEffect, useRef } from 'react';
import { ConversationScrollMemory } from './conversation-scroll';

type Conversation = 'direct' | 'group';

export function useConversationScroll(conversation: Conversation, historyReady: boolean, contentVersion: string) {
  const elementRef = useRef<HTMLDivElement>(null);
  const memory = useRef(new ConversationScrollMemory<Conversation>());
  const suppressScroll = useRef(false);
  const lastVersion = useRef(new Map<Conversation, string>());
  const settleCleanup = useRef<(() => void) | undefined>(undefined);

  const saveCurrent = useCallback(() => {
    const element = elementRef.current; if (element) memory.current.save(conversation, element);
  }, [conversation]);
  const onScroll = useCallback(() => {
    const element = elementRef.current; if (element && !suppressScroll.current) memory.current.save(conversation, element);
  }, [conversation]);
  const writeTop = useCallback((top: number) => {
    const element = elementRef.current; if (!element) return;
    suppressScroll.current = true; element.scrollTop = top;
    memory.current.updateAfterProgrammaticScroll(conversation, element.scrollTop, element);
    requestAnimationFrame(() => { suppressScroll.current = false; });
  }, [conversation]);
  const settleBottomOnce = useCallback(() => {
    settleCleanup.current?.(); const element = elementRef.current; if (!element || !memory.current.followsBottom(conversation)) return;
    let frame = 0; let quiet = 0;
    const finish = () => {
      if (!elementRef.current || !memory.current.followsBottom(conversation)) return cleanup();
      writeTop(Math.max(0, element.scrollHeight - element.clientHeight));
      if (!element.querySelector('[data-preview-state="loading"]') && ++quiet >= 2) cleanup();
      else frame = requestAnimationFrame(finish);
    };
    const observer = new ResizeObserver(() => { quiet = 0; }); observer.observe(element);
    const timeout = setTimeout(() => cleanup(), 4000);
    const cleanup = () => { cancelAnimationFrame(frame); clearTimeout(timeout); observer.disconnect(); if (settleCleanup.current === cleanup) settleCleanup.current = undefined; };
    settleCleanup.current = cleanup; frame = requestAnimationFrame(finish);
  }, [conversation, writeTop]);

  useLayoutEffect(() => {
    if (!historyReady || !elementRef.current) return;
    writeTop(memory.current.target(conversation, elementRef.current));
    if (memory.current.followsBottom(conversation)) settleBottomOnce();
    return () => settleCleanup.current?.();
  }, [conversation, historyReady, settleBottomOnce, writeTop]);

  useLayoutEffect(() => {
    if (!historyReady || !elementRef.current) return;
    const previous = lastVersion.current.get(conversation); lastVersion.current.set(conversation, contentVersion);
    if (previous === undefined || previous === contentVersion || !memory.current.followsBottom(conversation)) return;
    writeTop(Math.max(0, elementRef.current.scrollHeight - elementRef.current.clientHeight)); settleBottomOnce();
  }, [contentVersion, conversation, historyReady, settleBottomOnce, writeTop]);

  return { elementRef, onScroll, saveCurrent };
}
