import DOMPurify from 'dompurify';
import { marked } from 'marked';

// Worker text and files are untrusted: Markdown is rendered to HTML and then
// sanitised, and every link opens in a new tab.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noreferrer noopener');
  }
});

export function renderMarkdown(text: string): string {
  const html = marked.parse(text, { gfm: true, breaks: false, async: false });
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

export function Markdown({ text, className = 'md' }: { text: string; className?: string }) {
  return <div className={className} dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}
