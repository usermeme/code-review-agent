import type { ReviewThread } from '@code-review-agent/shared-types';

/** First non-empty line of a comment, without markdown heading marks. */
export function firstLine(body: string, maxChars: number): string {
  const line = body.split('\n').find((l) => l.trim()) ?? '';
  return truncate(line.replace(/^#+\s*/, '').trim(), maxChars);
}

export function truncate(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > maxChars ? `${flat.slice(0, maxChars)}…` : flat;
}

export function threadStatus(thread: ReviewThread): string {
  const state = thread.isResolved ? 'resolved' : 'open';
  return thread.isOutdated ? `${state}, outdated` : state;
}

export function threadLocation(thread: ReviewThread): string {
  return thread.line === null ? thread.path : `${thread.path}:${thread.line}`;
}
