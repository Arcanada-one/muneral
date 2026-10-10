// eslint 10 removed eslintrc entirely: `.eslintrc.json` is no longer read, and the CLI
// exits 2 with "the default configuration file is now eslint.config.*" plus a list of
// removed options (extensions, resolvePluginsRelativeTo, ignorePath, rulePaths,
// reportUnusedDisableDirectives). Measured on this tree with eslint 10.10.0.
//
// The rules are unchanged: eslint-config-next 16 ships the same core-web-vitals preset as
// a flat config array, so this file extends exactly what .eslintrc.json extended. It is a
// format migration, not a policy change — apps/api was already on a flat config.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';
import tseslint from 'typescript-eslint';

// Named, then exported: the flat config is itself linted, and a bare array default
// export trips import/no-anonymous-default-export from the preset it is loading.
const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
  ...nextCoreWebVitals,
  {
    // Pin the React version instead of letting the plugin detect it. eslint 10
    // removed `context.getFilename()` in favour of `context.filename`, and
    // eslint-plugin-react@7.37.5 still calls the old one from resolveBasedir
    // (lib/util/version.js:31) — measured: `contextOrFilename.getFilename is not a
    // function`, exit 2, the linter unable to load its own rules. Detection is the
    // only path into that function, so declaring the version skips it. 19.1 is what
    // apps/web actually depends on (react ^19.1.0), so this states a fact rather
    // than working around one.
    settings: { react: { version: '19.1' } },
  },
  {
    // eslint 10 finalises every parse with `scopeManager.addGlobals()`. The preset parses
    // JS files with the Babel parser Next vendors (next/dist/compiled/babel/eslint-parser),
    // whose scope manager has no such method — measured with eslint 10.11.0 and
    // next 16.3.4: `TypeError: scopeManager.addGlobals is not a function`, exit 2, on the
    // one JS file here (this config). TS files already go through typescript-eslint's
    // parser, which has it. Route JS through the same parser instead of ignoring the file:
    // the rules and globals stay the preset's, only the parser changes. Last block wins.
    //
    // Known and accepted: eslint-plugin-{react@7.37.5,jsx-a11y@6.10.2,import@2.32.0} still
    // declare `eslint` peers ending at ^9 (`pnpm peers check`). That is a declaration, not a
    // failure: a planted violation for each of them — and for react-hooks and @next/next —
    // is reported under eslint 10 exactly as under 9 (A2-320 red control). Drop this note
    // once their peer ranges include ^10.
    files: ['**/*.{js,jsx,mjs,cjs}'],
    languageOptions: { parser: tseslint.parser },
  },
];

export default config;
