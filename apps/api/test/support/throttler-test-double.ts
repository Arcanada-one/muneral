// A test double for @nestjs/throttler, not a bridge to it.
//
// The package is the last release (6.5.0), is CommonJS, and its peer range stops
// at @nestjs/common ^11. It require()s @nestjs/common, which in NestJS 12 is pure
// ESM with no CommonJS condition in its exports map. Node bridges that — the built
// application boots and the real guard runs in production — but jest's ESM resolver
// refuses the package outright, and that single import fails four e2e suites.
//
// Five bridging shapes were measured in CI and each failed for its own reason
// (named copies lose the decorator, `export =` exposes no names, getters recurse
// through moduleNameMapper, the direct dist path lands back on the ESM require).
// The obstacle is not the shape: CommonJS cannot load an ES module synchronously.
//
// So the tests get a double instead. That is honest here because none of the four
// suites asserts anything about rate limiting — they assert the DI graph resolves
// and the routes behave. The real limiter, including the 5-per-minute cap that is
// brute-force protection on /auth, is untouched in the application and exercised
// in production. What is NOT covered by tests is stated rather than hidden: the
// throttler's own behaviour has no test coverage under NestJS 12 until the package
// ships an ESM build.
import { Injectable, Module, SetMetadata } from '@nestjs/common';
import type { CanActivate } from '@nestjs/common';

@Injectable()
export class ThrottlerGuard implements CanActivate {
  canActivate(): boolean {
    return true;
  }
}

export class ThrottlerStorage {}
export class ThrottlerException extends Error {}

export const Throttle = (config: unknown) => SetMetadata('__throttle__', config);
export const SkipThrottle = (skip: unknown = true) =>
  SetMetadata('__skip_throttle__', skip);

export const InjectThrottlerOptions = () => () => undefined;
export const InjectThrottlerStorage = () => () => undefined;

export const seconds = (n: number) => n * 1000;
export const minutes = (n: number) => n * 60_000;
export const hours = (n: number) => n * 3_600_000;
export const days = (n: number) => n * 86_400_000;

// A real @Module class, not an object literal. The first version returned
// `{ module: <plain object>, ... }`, and Nest could not build the graph from it:
// CI reported `Nest can't resolve dependencies of the JwtAuthGuard` 78 times.
// A DynamicModule's `module` field must be an injectable class.
@Module({})
export class ThrottlerModule {
  static forRoot(_options?: unknown) {
    return { module: ThrottlerModule, providers: [], exports: [] };
  }
  static forRootAsync(_options?: unknown) {
    return { module: ThrottlerModule, providers: [], exports: [] };
  }
}
