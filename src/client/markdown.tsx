import { useState } from "react";
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

hljs.registerLanguage("bash", bash);
hljs.registerLanguage("shell", bash);
hljs.registerLanguage("css", css);
hljs.registerLanguage("diff", diff);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("js", javascript);
hljs.registerLanguage("json", json);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("ts", typescript);
hljs.registerLanguage("html", xml);
hljs.registerLanguage("xml", xml);

export function MarkdownContent({ text, complete = false }: { text: string; complete?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        skipHtml
        urlTransform={safeUrl}
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          code: ({ children, className }) => {
            const language = /language-([^ ]+)/.exec(className ?? "")?.[1];
            return language ? (
              <CodeBlock code={String(children).replace(/\n$/, "")} language={language} />
            ) : (
              <code>{children}</code>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
      {complete && (
        <button
          className="copy-message"
          type="button"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          }}
        >
          {copied ? "Copied message" : "Copy message"}
        </button>
      )}
    </div>
  );
}

export function CodeBlock({ code, language }: { code: string; language: string }) {
  const [copied, setCopied] = useState(false);
  const highlighted = highlight(code, language);
  return (
    <section className={`code-block ${language === "diff" ? "code-block--diff" : ""}`}>
      <header>
        <span>{language}</span>
        <button
          type="button"
          aria-live="polite"
          onClick={async () => {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 1_500);
          }}
        >
          {copied ? "Copied" : "Copy code"}
        </button>
      </header>
      <pre>
        <code className={`hljs language-${language}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
      </pre>
    </section>
  );
}

export function safeUrl(url: string): string {
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (/^(#|\/|\.\/|\.\.\/)/.test(url)) return url;
  return "";
}

export function highlight(code: string, language: string): string {
  try {
    return hljs.getLanguage(language)
      ? hljs.highlight(code, { language }).value
      : hljs.highlightAuto(code).value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
