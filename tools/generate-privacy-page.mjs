/**
 * Renders `docs/PRIVACY_POLICY.md` into `docs/privacy-policy.html`, which GitHub
 * Pages publishes from `main` at
 * https://mbwallace1390.github.io/rotorlens/privacy-policy.html — the URL for
 * the app stores' privacy-policy fields.
 *
 * Both stores require a privacy policy at a URL that is live before submission.
 * That page and the policy in this repository are the same document, and the
 * only safe way to keep two copies identical is to stop having two: the page is
 * generated, `npm test` fails if the committed one has drifted, and the markdown
 * is the only thing anybody edits.
 *
 * The converter understands exactly the constructs the policy uses and throws on
 * anything else. Silently mangling a legal document is worse than refusing to
 * build it — the same reasoning as the bundle transform in
 * tools/build-advisor-bundle.mjs.
 *
 * The page is self-contained by design. A privacy policy that pulls a font or a
 * script from someone else's server is a tracking vector on the page explaining
 * that the app does not track you.
 */

import {readFile, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(projectRoot, 'docs', 'PRIVACY_POLICY.md');
const outputPath = path.join(projectRoot, 'docs', 'privacy-policy.html');

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Bold, italics, inline code, and links — applied after escaping, never before.
 *
 * Italics were once unsupported and passed through untouched, so the published
 * page showed literal asterisks around two section names. An asterisk left over
 * after conversion now refuses the build instead of reaching the page.
 */
function inline(text) {
  const escaped = escapeHtml(text);

  if (/!\[/.test(escaped)) {
    throw new Error('images are not supported in the policy page');
  }
  if (escaped.includes('&lt;!--')) {
    throw new Error(`a comment must start its own line in the policy: ${text}`);
  }

  const html = escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*\s](?:[^*]*[^*\s])?)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label, href) => {
      if (!/^(https?:|mailto:|#)/.test(href)) {
        throw new Error(`unsupported link target in the policy: ${href}`);
      }
      return `<a href="${href}">${label}</a>`;
    });

  if (html.includes('*')) {
    throw new Error(`unconverted emphasis in the policy: ${text}`);
  }
  return html;
}

function isTableRow(line) {
  return line.startsWith('|') && line.endsWith('|');
}

function tableCells(line) {
  return line.slice(1, -1).split('|').map(cell => cell.trim());
}

function isTableSeparator(cells) {
  return cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

/** Converts the restricted markdown subset the policy is written in. */
export function renderPolicyHtml(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let paragraph = [];
  let list = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      out.push(`<p>${inline(paragraph.join(' '))}</p>`);
      paragraph = [];
    }
  };

  const flushList = () => {
    if (list.length > 0) {
      out.push('<ul>');
      for (const item of list) {
        out.push(`  <li>${inline(item)}</li>`);
      }
      out.push('</ul>');
      list = [];
    }
  };

  const flush = () => {
    flushParagraph();
    flushList();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const line = raw.trim();

    if (line === '') {
      flush();
      continue;
    }

    // A comment is for maintainers reading the markdown — an internal file path,
    // for instance — and is never published. It must start its own line and end
    // on a line with nothing after it; anything else is refused, not guessed at.
    if (line.startsWith('<!--')) {
      flush();
      let closing = index;
      while (closing < lines.length && !lines[closing].includes('-->')) {
        closing += 1;
      }
      if (closing === lines.length) {
        throw new Error(`unterminated comment in the policy: ${line}`);
      }
      const after = lines[closing].slice(lines[closing].indexOf('-->') + 3).trim();
      if (after !== '') {
        throw new Error(`text after a comment in the policy: ${after}`);
      }
      index = closing;
      continue;
    }

    // A wrapped list item continues on an indented line. Judging that after
    // trimming reads the continuation as a new paragraph and cuts the sentence
    // in half — which this converter exists to refuse, not to do quietly.
    if (list.length > 0 && /^\s+/.test(raw) && !line.startsWith('- ')) {
      list[list.length - 1] += ` ${line}`;
      continue;
    }

    if (line.startsWith('#')) {
      flush();
      const level = line.match(/^#+/)[0].length;
      if (level > 2) {
        throw new Error(`only h1 and h2 are supported; found h${level}: ${line}`);
      }
      out.push(`<h${level}>${inline(line.slice(level).trim())}</h${level}>`);
      continue;
    }

    if (line.startsWith('- ')) {
      flushParagraph();
      list.push(line.slice(2).trim());
      continue;
    }

    if (isTableRow(line)) {
      flush();
      const rows = [];
      while (index < lines.length && isTableRow(lines[index].trim())) {
        rows.push(tableCells(lines[index].trim()));
        index += 1;
      }
      index -= 1;

      // The first row is the header and the second the separator, always. An
      // entirely empty header is layout rather than content and renders no
      // header row at all. It must never promote the first DATA row into the
      // header: that is what this once did, by discarding the empty header
      // together with the separator, and "Accounts or email" was published in
      // bold as if it were a column heading.
      if (rows.length < 2 || !isTableSeparator(rows[1])) {
        throw new Error(`a policy table needs a header row then a separator row: ${line}`);
      }
      const [header, , ...body] = rows;
      for (const cells of body) {
        if (isTableSeparator(cells) || cells.length !== header.length) {
          throw new Error(`malformed table row in the policy: | ${cells.join(' | ')} |`);
        }
      }

      out.push('<table>');
      if (header.some(cell => cell !== '')) {
        out.push(`  <tr>${header.map(cell => `<th>${inline(cell)}</th>`).join('')}</tr>`);
      }
      for (const cells of body) {
        out.push(`  <tr>${cells.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`);
      }
      out.push('</table>');
      continue;
    }

    if (/^(>|\d+\.|```|\||!\[)/.test(line)) {
      throw new Error(`unsupported markdown in the policy: ${line}`);
    }

    flushList();
    paragraph.push(line);
  }

  flush();

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RotorLens privacy policy</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0 auto;
    max-width: 46rem;
    padding: 2rem 1.25rem 4rem;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #ffffff;
    color: #16202b;
  }
  h1 { font-size: 1.7rem; letter-spacing: -0.01em; margin: 0 0 1.5rem; }
  h2 { font-size: 1.15rem; margin: 2.25rem 0 0.75rem; }
  p, li { overflow-wrap: anywhere; }
  ul { padding-left: 1.25rem; }
  li { margin-bottom: 0.4rem; }
  code { font-size: 0.92em; background: rgba(127, 140, 155, 0.16); padding: 0.1em 0.35em; border-radius: 4px; }
  a { color: #0b62c4; }
  table { width: 100%; border-collapse: collapse; margin: 0.75rem 0; display: block; overflow-x: auto; }
  th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid rgba(127, 140, 155, 0.35); vertical-align: top; }
  th { font-weight: 600; }
  @media (prefers-color-scheme: dark) {
    body { background: #0e1116; color: #e6edf3; }
    a { color: #4aa8ff; }
  }
</style>
</head>
<body>
${out.join('\n')}
</body>
</html>
`;
}

export async function renderCommittedPolicyPage() {
  return renderPolicyHtml(await readFile(sourcePath, 'utf8'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const html = await renderCommittedPolicyPage();
  await writeFile(outputPath, html, 'utf8');
  process.stdout.write(`docs/privacy-policy.html — ${html.length} bytes\n`);
}
