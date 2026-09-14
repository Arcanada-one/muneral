// eslint 10 removed eslintrc entirely: `.eslintrc.json` is no longer read, and the CLI
// exits 2 with "the default configuration file is now eslint.config.*" plus a list of
// removed options (extensions, resolvePluginsRelativeTo, ignorePath, rulePaths,
// reportUnusedDisableDirectives). Measured on this tree with eslint 10.10.0.
//
// The rules are unchanged: eslint-config-next 16 ships the same core-web-vitals preset as
// a flat config array, so this file extends exactly what .eslintrc.json extended. It is a
// format migration, not a policy change — apps/api was already on a flat config.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

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
];

export default config;
