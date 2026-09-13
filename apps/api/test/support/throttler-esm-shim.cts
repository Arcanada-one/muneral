// @nestjs/throttler@6.5.0 is CommonJS and require()s @nestjs/common, which is
// pure ESM in NestJS 12 with no CommonJS condition in its exports map (measured:
// type "module", exports {".": "./index.js"}). Node bridges that fine — the built
// application boots and the guard works — but jest's ESM resolver refuses the
// package with `Must use import to load ES Module`, and that one import fails
// four e2e suites.
//
// A .cts file is CommonJS whatever the package "type" says, so jest loads it and
// the require() inside behaves as Node's would. Each binding is re-exported by
// name because an ESM importer cannot destructure a CommonJS namespace. Only the
// TEST resolver is pointed here; application code imports the real package.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const throttler = require('@nestjs/throttler');

export const ThrottlerModule = throttler.ThrottlerModule;
export const ThrottlerGuard = throttler.ThrottlerGuard;
export const Throttle = throttler.Throttle;
export const SkipThrottle = throttler.SkipThrottle;
export const ThrottlerException = throttler.ThrottlerException;
export const ThrottlerStorage = throttler.ThrottlerStorage;
export const InjectThrottlerOptions = throttler.InjectThrottlerOptions;
export const InjectThrottlerStorage = throttler.InjectThrottlerStorage;
export const seconds = throttler.seconds;
export const minutes = throttler.minutes;
export const hours = throttler.hours;
export const days = throttler.days;
