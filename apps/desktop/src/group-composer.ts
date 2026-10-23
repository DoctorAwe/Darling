export const defaultGroupDraft = '@Echo ';

export function mentionQuery(value: string) {
  const match = /(^|\s)@([^\s@]*)$/.exec(value);
  if (!match || !'echo'.startsWith(match[2].toLocaleLowerCase())) return undefined;
  return { start: match.index + match[1].length, end: value.length };
}

export function insertEchoMention(value: string) {
  const query = mentionQuery(value); if (!query) return value;
  return `${value.slice(0, query.start)}@Echo `;
}

export function isBareEchoMention(value: string) { return /^@echo\s*$/i.test(value); }

export async function uploadGroupAttachments<T extends { token: string }>(items: T[], send: (token: string) => Promise<{ ok: boolean; error?: string }>) {
  const failed: T[] = []; let error: string | undefined;
  for (const item of items) { const result = await send(item.token); if (!result.ok) { failed.push(item); error = result.error ?? '群聊附件发送失败'; } }
  return { failed, error };
}
