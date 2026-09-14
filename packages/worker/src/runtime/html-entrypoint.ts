const SCRIPT_ENTRY_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

export async function findHtmlScriptEntrypoint(html: string): Promise<string | undefined> {
  if (typeof HTMLRewriter !== 'function') return undefined;

  let entrypoint: string | undefined;
  const rewriter = new HTMLRewriter().on('script[src]', {
    element(element) {
      if (entrypoint) return;
      const src = element.getAttribute('src');
      if (src && isScriptEntrypoint(src)) entrypoint = src;
    },
  });

  await rewriter.transform(new Response(html)).text();
  return entrypoint;
}

export async function rewriteViteBuildHtml(
  html: string,
  options: {
    jsFilename: string;
    cssFilename?: string;
    removeImportMap?: boolean;
    /**
     * Vite injects `<link rel="stylesheet">` for CSS bundled through the
     * entry when index.html declares none (the create-vite template puts
     * all CSS behind `import './index.css'`). Set true to get that
     * behavior; when false, only an existing stylesheet link is rewritten.
     */
    injectCss?: boolean;
  },
): Promise<string> {
  if (typeof HTMLRewriter !== 'function') return html;

  let sawCssLink = false;
  const rewriter = new HTMLRewriter()
    .on('script', {
      element(element) {
        const type = element.getAttribute('type') || '';
        if (options.removeImportMap && type.toLowerCase() === 'importmap') {
          element.remove();
          return;
        }

        const src = element.getAttribute('src');
        if (src && isScriptEntrypoint(src)) {
          element.setAttribute('src', `/assets/${options.jsFilename}`);
        }
      },
    })
    .on('link[href]', {
      element(element) {
        const href = element.getAttribute('href');
        if (!href || !isCssAsset(href)) return;
        sawCssLink = true;
        if (!options.cssFilename) return;
        element.setAttribute('rel', 'stylesheet');
        element.setAttribute('crossorigin', '');
        element.setAttribute('href', `/assets/${options.cssFilename}`);
      },
    });

  if (options.injectCss && options.cssFilename) {
    // element.onEndTag fires at </head> — after every `link[href]` child
    // has been seen — so the stylesheet lands exactly when the document
    // declares none, the same condition Vite uses for its emitted <link>.
    rewriter.on('head', {
      element(element) {
        element.onEndTag((end) => {
          if (!sawCssLink) {
            end.before(
              `<link rel="stylesheet" crossorigin href="/assets/${options.cssFilename}">`,
              { html: true },
            );
          }
        });
      },
    });
  }

  return await rewriter.transform(new Response(html)).text();
}

function isScriptEntrypoint(src: string): boolean {
  const path = src.split('?', 1)[0].split('#', 1)[0];
  return SCRIPT_ENTRY_EXTENSIONS.some((ext) => path.endsWith(ext));
}

function isCssAsset(href: string): boolean {
  return href.split('?', 1)[0].split('#', 1)[0].endsWith('.css');
}
