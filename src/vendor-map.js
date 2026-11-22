// Third-party browser files Rico serves under /vendor/*, from node_modules. Used by the local
// server (served directly) and by scripts/build.mjs (copied into dist/ for Cloudflare).
// D2, Mermaid and Graphviz are optional dependencies: a missing file just means that renderer is unavailable.
import path from 'node:path';

export function vendorFiles(NM) {
  return {
    '/vendor/github-markdown.css': path.join(NM, 'github-markdown-css', 'github-markdown.css'),
    '/vendor/hljs.js': path.join(NM, '@highlightjs', 'cdn-assets', 'highlight.min.js'),
    '/vendor/hljs-light.css': path.join(NM, '@highlightjs', 'cdn-assets', 'styles', 'github.min.css'),
    '/vendor/hljs-dark.css': path.join(NM, '@highlightjs', 'cdn-assets', 'styles', 'github-dark.min.css'),
    '/vendor/purify.js': path.join(NM, 'dompurify', 'dist', 'purify.min.js'),
    '/vendor/d2.js': path.join(NM, '@terrastruct', 'd2', 'dist', 'browser', 'index.js'),
    '/vendor/viz.js': path.join(NM, '@viz-js', 'viz', 'dist', 'viz.js'),
    '/vendor/mermaid.js': path.join(NM, 'mermaid', 'dist', 'mermaid.min.js'),
  };
}
