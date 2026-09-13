// @nestjs/throttler@6.5.0 is the last release, is CommonJS, and its peer range
// stops at @nestjs/common ^11. It requires @nestjs/common, which in NestJS 12 is
// pure ESM with no CommonJS condition in its exports map. Node bridges that — the
// built AppModule loads and the guard works — but jest's ESM resolver refuses the
// package, and that one import failed four e2e suites.
//
// A .cts file is CommonJS whatever the package "type" says, so jest loads it and
// the require() inside behaves as Node's does. `export =` hands the module object
// through untouched: re-exporting each binding with `export const` was tried and
// broke the decorators — `TypeError: Throttle is not a function` — because the
// per-name copies lose what the interop layer wraps. moduleNameMapper points only
// the TEST resolver here; application code imports the real package.
import throttler = require('@nestjs/throttler');

export = throttler;
