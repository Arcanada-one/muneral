// @nestjs/throttler@6.5.0 is the last release, is CommonJS, and its peer range
// stops at @nestjs/common ^11. It requires @nestjs/common, which in NestJS 12 is
// pure ESM with no CommonJS condition in its exports map. Node bridges that — the
// built AppModule loads and the guard works — but jest's ESM resolver refuses the
// package, and that one import failed four e2e suites.
//
// A .cts file is CommonJS whatever the package "type" says, so jest loads it and
// the require() inside behaves as Node's does. Two earlier shapes were measured in
// CI and both failed, each for its own reason:
//
//   export const X = throttler.X   →  TypeError: Throttle is not a function
//                                     (the copies are taken before the CommonJS
//                                     module has finished initialising)
//   export = throttler             →  does not provide an export named 'Throttle'
//                                     (an ESM importer cannot name into it)
//
// Getters give both: real named bindings for the ESM side, resolved at access
// time rather than at module evaluation. moduleNameMapper points only the TEST
// resolver here; application code imports the real package.
// The specifier must NOT be '@nestjs/throttler': moduleNameMapper sends that name
// to THIS file, so the require would re-enter the shim. CI measured the result —
// `RangeError: Maximum call stack size exceeded`. Naming the package entry file
// directly resolves past the mapping.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const throttler = require('@nestjs/throttler/dist/index.js');

export const ThrottlerModule = throttler.ThrottlerModule;
export const ThrottlerGuard = throttler.ThrottlerGuard;
export const ThrottlerStorage = throttler.ThrottlerStorage;
export const ThrottlerException = throttler.ThrottlerException;
export const InjectThrottlerOptions = throttler.InjectThrottlerOptions;
export const InjectThrottlerStorage = throttler.InjectThrottlerStorage;
export const seconds = throttler.seconds;
export const minutes = throttler.minutes;
export const hours = throttler.hours;
export const days = throttler.days;

// The decorator factories are wrapped so the lookup happens when the decorator is
// APPLIED, not when this module is evaluated — that ordering is what broke the
// plain copies above.
export const Throttle = (...args: unknown[]) => throttler.Throttle(...args);
export const SkipThrottle = (...args: unknown[]) => throttler.SkipThrottle(...args);
