import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Renders assistant text as formatted Markdown (bold, italics, headings, lists,
// code, tables) — links open externally, never navigating the app away.
export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
