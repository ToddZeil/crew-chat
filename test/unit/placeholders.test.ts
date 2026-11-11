import { describe, expect, it } from 'vitest';
import type { FirstmateNote } from '../../shared/types.ts';
import type { BacklogTask } from '../../server/parse.ts';
import { buildPlaceholders, placeholderDetail, placeholderSummary, threadNotes, words, overlap } from '../../server/placeholders.ts';

const NOW = Date.parse('2026-11-12T09:00:00Z');
const task = (t: Partial<BacklogTask> & { id: string; repo: string; title: string; state: string }): BacklogTask => ({
  kind: 'ship',
  created: '',
  closed: '',
  held: false,
  holdKind: null,
  holdReason: null,
  blocked: false,
  blockedBy: null,
  links: null,
  ...t,
});
const note = (id: string, body: string, at: string, acknowledged = false, reply?: string): FirstmateNote => ({
  id,
  requestId: null,
  at: Date.parse(at),
  body,
  acknowledged,
  announced: true,
  reply: reply ? { at: Date.parse(at) + 60_000, body: reply } : null,
});

describe('placeholders', () => {
  const tasks = [
    task({ id: 'question-length', state: 'queued', repo: 'storefront', title: 'Storefront: remove the 100-character limit on product questions in the listing form', created: '2026-11-12' }),
    task({ id: 'remove-banner', state: 'done', repo: 'storefront', title: 'SHOP-981: remove the coming soon banner', closed: '2026-11-12' }),
    task({ id: 'funnel-stats', state: 'done', repo: 'mobile-app', title: "Checkout funnel: yesterday's stats and the save-card opt-ins", closed: '2026-11-12' }),
    task({ id: 'old-held', state: 'queued', repo: 'storefront', title: 'Old parked decision', created: '2026-09-01', held: true, holdReason: 'waiting on the captain' }),
    task({ id: 'fresh-held', state: 'queued', repo: 'storefront', title: 'Fresh held thing', created: '2026-11-11', held: true, holdReason: 'needs a tracker permission' }),
  ];
  const notes = [
    note('n-ts', 'New worker request - project: storefront. Check what character count the product question allows and match the listing form.\nModel: auto\nPlanning: yes', '2026-11-11T20:33:00Z', true, 'The limit is 100.'),
    note('n-ats', "New worker request - project: mobile-app. Check the stats from yesterday's checkout funnel", '2026-11-11T20:30:00Z', true, 'On it.'),
    note('n-new', 'New worker request - project: crew-chat. Add a search box.\nModel: opus\nEffort: high\nPlanning: no', '2026-11-12T08:59:00Z'),
    note('n-old', 'New worker request - project: not sure. Something old', '2026-11-11T04:00:00Z', true, 'done'),
    note('n-tag', '[re: question-length] Make it 500 instead', '2026-11-12T08:00:00Z', true, 'Noted, 500.'),
    note('n-plain', 'How is it going?', '2026-11-12T08:30:00Z'),
  ];

  it('scores key-word overlap', () => {
    expect(overlap(words('Check the stats from yesterday checkout funnel'), words("Checkout funnel: yesterday's stats"))).toBeGreaterThanOrEqual(3);
  });

  it('shows queued work without a live worker, links requests by project and wording, and hides what is done', () => {
    const { placeholders, liveLinks } = buildPlaceholders(tasks, notes, [{ id: 'crew-chat-ui', project: 'crew-chat', spawnedAt: Date.parse('2026-11-11T00:00:00Z'), title: 'crew-chat v1' }], NOW);
    expect(placeholders.map((p) => [p.id, p.kind])).toEqual([
      ['question-length', 'queued'],
      ['fresh-held', 'queued'],
      ['request-n-new', 'requested'],
    ]);
    const ts = placeholders[0];
    expect(ts.requests.map((r) => r.note.id)).toEqual(['n-ts']);
    expect(threadNotes(ts, notes).map((n) => n.id)).toEqual(['n-ts', 'n-tag']);
    expect(liveLinks.get('crew-chat-ui')).toEqual([]);
  });

  it('builds a readable summary and detail', () => {
    const { placeholders } = buildPlaceholders(tasks, notes, [], NOW);
    const ts = placeholders.find((p) => p.id === 'question-length')!;
    const s = placeholderSummary(ts, notes, NOW);
    expect(s).toMatchObject({ badge: 'queued', placeholder: 'queued', project: 'storefront', model: 'auto', incomingCount: 2 });
    expect(s.stateLine).toBe('queued in the backlog · no worker yet · planning first');
    const d = placeholderDetail(ts, notes, NOW);
    expect(d.items.map((i) => (i.type === 'outgoing' ? `you:${i.body.split('\n')[0]}` : `${i.author}:${i.verb}`))).toEqual([
      'you:New worker request - project: storefront. Check what character count the product question allows and match the listing form.',
      'firstmate:reply',
      'you:Make it 500 instead',
      'firstmate:reply',
      'firstmate:queued',
    ]);
    const status = d.items.at(-1)!;
    expect(status.type === 'incoming' && status.text).toContain('You asked for a planning phase first');
    const held = placeholderDetail(placeholders.find((p) => p.id === 'fresh-held')!, notes, NOW).items.at(-1)!;
    expect(held.type === 'incoming' && held.text).toContain('Held: needs a tracker permission');
  });

  it('hands a request to a live worker that starts later', () => {
    const live = [{ id: 'crew-search', project: 'crew-chat', spawnedAt: Date.parse('2026-11-12T09:05:00Z'), title: 'crew-chat: add a search box to the sidebar' }];
    const { placeholders, liveLinks } = buildPlaceholders([], notes, live, NOW + 10 * 60_000);
    expect(placeholders.some((p) => p.id === 'request-n-new')).toBe(false);
    expect(liveLinks.get('crew-search')!.map((r) => r.note.id)).toEqual(['n-new']);
  });
});
