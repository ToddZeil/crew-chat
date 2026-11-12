import type { AppConfig, ClaudeLimits, TerminalAvailability, CleanupResult, FirstmateDetail, NoteResult, ThreadDetail, ThreadSummary, UploadResult, WriteResult } from '../shared/types.ts';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

async function postJson(url: string, body: unknown): Promise<WriteResult> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as WriteResult;
  } catch (err) {
    return { ok: false, outcome: 'refused', exitCode: null, stdout: '', stderr: '', error: `Could not reach crew-chat: ${(err as Error).message}` };
  }
}

const enc = encodeURIComponent;

export const api = {
  config: () => getJson<AppConfig>('/api/config'),
  threads: () => getJson<ThreadSummary[]>('/api/threads'),
  thread: (id: string) => getJson<ThreadDetail>(`/api/threads/${enc(id)}`),
  send: (id: string, text: string) => postJson(`/api/threads/${enc(id)}/messages`, { text }),
  answer: (id: string, key: string, text: string) => postJson(`/api/threads/${enc(id)}/answer`, { key, text }),
  upload: async (file: Blob): Promise<UploadResult> => {
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ''));
        reader.onerror = () => reject(reader.error ?? new Error('could not read the image'));
        reader.readAsDataURL(file);
      });
      const res = await fetch('/api/uploads', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: file.type, data }),
      });
      return (await res.json()) as UploadResult;
    } catch (err) {
      return { ok: false, error: `Could not save the image: ${(err as Error).message}` };
    }
  },
  firstmate: () => getJson<FirstmateDetail>('/api/firstmate'),
  sendNote: async (text: string, requestId: string): Promise<NoteResult> => {
    try {
      const res = await fetch('/api/firstmate/notes', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, requestId }),
      });
      return (await res.json()) as NoteResult;
    } catch (err) {
      return { outcome: 'refused', exitCode: null, noteId: null, stdout: '', stderr: '', error: `Could not reach crew-chat: ${(err as Error).message}` };
    }
  },
  limits: async (): Promise<ClaudeLimits | null> => ((await (await fetch('/api/limits', { cache: 'no-store' })).json()) as { limits: ClaudeLimits | null }).limits,
  firstmateTerminal: () => getJson<TerminalAvailability>('/api/firstmate/terminal'),
  openFirstmateTerminal: () => postJson('/api/firstmate/terminal', {}),
  setHidden: (id: string, hidden: boolean) => postJson(`/api/threads/${enc(id)}/hide`, { hidden }),
  openTerminal: (id: string) => postJson(`/api/threads/${enc(id)}/terminal`, {}),
  cleanup: async (id: string, confirmId?: string): Promise<CleanupResult> => {
    try {
      const res = await fetch(`/api/threads/${enc(id)}/cleanup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(confirmId === undefined ? {} : { force: true, confirmId }),
      });
      return (await res.json()) as CleanupResult;
    } catch (err) {
      return { outcome: 'error', exitCode: null, stdout: '', stderr: '', error: `Could not reach crew-chat: ${(err as Error).message}` };
    }
  },
};
