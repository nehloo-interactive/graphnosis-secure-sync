// See _sodium-resolve.mjs. Returns the live libsodium object (CJS require gives the
// same instance the wrapper populates after `ready`, unlike Node's ESM-interop snapshot).
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const sodium = require('libsodium-wrappers-sumo');
export default sodium;
