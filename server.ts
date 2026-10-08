/**
 * The checkout as a V2 plugin directory (issue #140).
 *
 * OpenCode 2.0.25 accepts a plugin entry only as a directory, and resolves it
 * to `<directory>/server`, then `<directory>/index` — never `package.json`
 * `main` or `exports`. This file is what makes `"plugins": ["<checkout>"]` load
 * the Test Tool, which is the one form that can also carry plugin options.
 */

export { default } from "./src/adapter/plugin.ts"
