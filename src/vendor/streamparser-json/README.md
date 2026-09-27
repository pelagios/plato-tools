# @streamparser/json 0.0.26, vendored with one change

The ES module build (`dist/mjs/*.js`) of [@streamparser/json](https://github.com/juanjoDiaz/streamparser-json)
0.0.26 by Juanjo Diaz, MIT licence (`LICENSE`, from the package). Taken from the published tarball,
whose sha512 is the one `package-lock.json` recorded for it
(`46597LNFI+MFdUnzX2QJWwmdTRdq0XVD+vVNJTtGVzIrnCuhG9pFo1OAzbNBqci8UJgk/X5KJZ6LcV+y7PTuDQ==`).
The type declarations and source maps are left out, and the `sourceMappingURL` comments with them.

**The change**, in `utils/bufferedString.js`, in both of its `TextDecoder`s:

```diff
- new TextDecoder("utf-8", { fatal: true })
+ new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
```

**Why.** The parser decodes each run of a string's bytes with its own decoder, and a `TextDecoder`
strips a leading U+FEFF unless told not to. Inside a JSON string U+FEFF is data (Pleiades place
585129 has one leading an attested form), so it was lost wherever a run began with it: at the start
of a string, after an escape sequence, or at a chunk boundary. `test/bom.test.js` checks it.

**Why vendored.** The change was applied with `patch-package` in a `postinstall` script, but
`patch-package` is a development dependency, which npm does not install when the tools are
installed as a git dependency, as `npx github:pelagios/plato-tools` does: the install failed with
exit status 127 and linked nothing. A copy in the source tree works the same under `npm install`,
`npm ci`, `npx`, the Vite build and CI, and has no dependency layout to rely on.

To update: take the new version's `dist/mjs/*.js` from its tarball, drop the `sourceMappingURL`
lines, reapply the change if upstream has not made it, and run `npm test`.
