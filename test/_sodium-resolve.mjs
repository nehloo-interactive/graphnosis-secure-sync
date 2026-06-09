// Test-only loader: libsodium-wrappers-sumo@0.7.16 ships a broken ESM entry
// (its .mjs imports a sibling the package omits from its files array). Production
// consumers fix this with the documented pnpm packageExtensions override (see the
// header comment in src/crypto/index.ts). For running tests with plain Node we route
// the import through a createRequire shim that returns the working CJS build's live
// object, so tests exercise the real compiled crypto without a reinstall.
export async function resolve(spec, ctx, next) {
  if (spec === 'libsodium-wrappers-sumo') {
    const url = new URL('./_sodium-shim.mjs', import.meta.url).href;
    return { url, shortCircuit: true };
  }
  return next(spec, ctx);
}
