// eslint 10 removed eslintrc entirely: `.eslintrc.json` is no longer read, and the CLI
// exits 2 with "the default configuration file is now eslint.config.*" plus a list of
// removed options (extensions, resolvePluginsRelativeTo, ignorePath, rulePaths,
// reportUnusedDisableDirectives). Measured on this tree with eslint 10.10.0.
//
// The rules are unchanged: eslint-config-next 16 ships the same core-web-vitals preset as
// a flat config array, so this file extends exactly what .eslintrc.json extended. It is a
// format migration, not a policy change — apps/api was already on a flat config.
import nextCoreWebVitals from 'eslint-config-next/core-web-vitals';

export default [
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
  ...nextCoreWebVitals,
];
