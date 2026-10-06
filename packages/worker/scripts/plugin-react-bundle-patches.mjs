/**
 * plugin-react-bundle-patches.mjs — the source rewrites
 * bundle-plugin-react.mjs applies to @vitejs/plugin-react's
 * dist/index.mjs before esbuild bundles it. Each is a replaceSeam, so a
 * plugin-react release that moves an anchor fails the build.
 */

import { replaceSeam } from './cirrus-bundle-shared.mjs';

/**
 * @param {string} src  plugin-react's dist/index.mjs
 * @param {{ refreshRuntime: string, refreshUtils: string }} assets
 *   react-refresh's cjs/react-refresh-runtime.development.js and
 *   plugin-react's dist/refreshUtils.js, inlined verbatim.
 * @returns {string}
 */
export function patchPluginReactIndex(src, { refreshRuntime, refreshUtils }) {
  const esc = (s) =>
    s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

  let patched = src;

  // Inline the two fs.readFileSync calls that happen at module
  // init. Both are template-literal substitutions, so we swap
  // them for the escaped file contents.
  patched = replaceSeam(patched, {
    label: 'plugin-react runtime readFileSync',
    find: /\$\{fs\.readFileSync\(runtimeFilePath,\s*"utf-8"\)\}/g,
    replace: () => esc(refreshRuntime),
    count: 1,
  });
  patched = replaceSeam(patched, {
    label: 'plugin-react refreshUtils readFileSync',
    find: /\$\{fs\.readFileSync\(_require\.resolve\("\.\/refreshUtils\.js"\),\s*"utf-8"\)\}/g,
    replace: () => esc(refreshUtils),
    count: 1,
  });

  // The two path-computation calls that populate runtimeFilePath
  // / reactRefreshDir are now dead — neutralise them so the
  // remaining `path.join` / `path.dirname` don't trip on bundle-
  // time `_require.resolve` (it won't exist at runtime).
  patched = replaceSeam(patched, {
    label: 'plugin-react react-refresh dir',
    find: /path\.dirname\(\s*_require\.resolve\("react-refresh\/package\.json"\)\s*\)/g,
    replace: 'String("/__cirrus_stub_react_refresh_dir__")',
    count: 1,
  });
  patched = replaceSeam(patched, {
    label: 'plugin-react runtime file path',
    find: /path\.join\(\s*reactRefreshDir,\s*"cjs\/react-refresh-runtime\.development\.js"\s*\)/g,
    replace: 'String("/__cirrus_stub_runtime_file__")',
    count: 1,
  });

  // Rewire loadPlugin() to use static imports. esbuild will
  // resolve these at bundle time and include the plugins inline.
  // Also add a new well-known entry "@babel/plugin-transform-react-jsx"
  // so our transform-patch (below) can load the JSX transformer.
  patched = replaceSeam(patched, {
    label: 'plugin-react loadPlugin',
    find: /const loadedPlugin = [\s\S]*?return promise;\s*\}/g,
    count: 1,
    replace: () => `
const loadedPlugin = /* @__PURE__ */ new Map();
async function loadPlugin(path) {
  if (loadedPlugin.has(path)) return loadedPlugin.get(path);
  let value;
  switch (path) {
    case "react-refresh/babel":
      value = (await import("react-refresh/babel")).default;
      break;
    case "@babel/plugin-transform-react-jsx-self":
      value = (await import("@babel/plugin-transform-react-jsx-self")).default;
      break;
    case "@babel/plugin-transform-react-jsx-source":
      value = (await import("@babel/plugin-transform-react-jsx-source")).default;
      break;
    case "@babel/plugin-transform-react-jsx":
      value = (await import("@babel/plugin-transform-react-jsx")).default;
      break;
    case "@babel/plugin-transform-typescript":
      value = (await import("@babel/plugin-transform-typescript")).default;
      break;
    default:
      throw new Error("[cirrus-plugin-react] unknown loadPlugin spec: " + path);
  }
  loadedPlugin.set(path, value);
  return value;
}
          `.trim(),
  });

  // Step 7 critical fix: plugin-react 4.x delegates JSX syntax
  // transformation to Vite's esbuild. In real-vite mode we
  // disabled vite:esbuild (workerd forbids eval), so JSX
  // reaches import-analysis unparsed and crashes. Inject the
  // Babel JSX transformer into plugins[] right after the
  // react-refresh/babel push — so every .jsx/.tsx file gets
  // JSX syntax lowered BEFORE import-analysis sees it.
  //
  // We insert the JSX plugin BEFORE the refresh plugin so the
  // refresh-sig detection (which runs on the post-JSX output
  // via the refreshContentRE regex) sees jsx(...) call
  // expressions, not raw JSX elements.
  patched = replaceSeam(patched, {
    label: 'plugin-react JSX/TS transform injection',
    find: /const plugins = \[\.\.\.babelOptions\.plugins\];/g,
    count: 1,
    replace: () => `const plugins = [...babelOptions.plugins];
        /* cirrus-real: inject Babel transforms for both JSX AND
           TypeScript syntax. plugin-react 4.x normally delegates
           both to Vite's esbuild — which we disabled because workerd
           forbids eval. */
        const filepath_cirrus = filepath;
        const isTS_cirrus = /\\.tsx?$/.test(filepath_cirrus);
        const isJSX_cirrus = filepath_cirrus.endsWith(".jsx") || filepath_cirrus.endsWith(".tsx");
        if (isTS_cirrus) {
          const tsPlugin = await loadPlugin("@babel/plugin-transform-typescript");
          plugins.push([tsPlugin, {
            isTSX: isJSX_cirrus,
            allExtensions: true,
            /* Allow namespace (required for some patterns). allowDeclareFields
               is a default-true in Babel 7.25+; noops on older versions. */
            allowNamespaces: true,
            allowDeclareFields: true,
            /* Preserve JSX — the jsx transform runs AFTER this plugin,
               converting JSX to jsx() calls. */
            onlyRemoveTypeImports: false,
          }]);
        }
        if (isJSX_cirrus) {
          const jsxPlugin = await loadPlugin("@babel/plugin-transform-react-jsx");
          plugins.push([jsxPlugin, {
            runtime: opts.jsxRuntime === "classic" ? "classic" : "automatic",
            importSource: opts.jsxImportSource || "react",
            development: !isProduction,
          }]);
        }`,
  });

  return patched;
}
