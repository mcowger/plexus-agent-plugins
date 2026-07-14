# Agent Guide — plexus-oh-my-pi

## OMP extension loader: don't bare-import `@oh-my-pi/pi-catalog` at runtime

`omp plugin install` validates every extension entry point before committing
the install. The validator (`packages/coding-agent/src/extensibility/plugins/legacy-pi-compat.ts`
in the `oh-my-pi` repo, see `collectExtensionModules`) statically walks the
extension's import graph to install hot-reload hooks. Bare imports from the
extension's *own* entry file are followed one hop into the target package's
source tree, and — critically — relative imports inside that target package
keep being walked indefinitely (bare imports inside it are not followed
further, but relative ones are).

`@oh-my-pi/pi-catalog` ships as raw, unbundled TypeScript source
(`"main": "./src/index.ts"`) with a deep relative-import tree that eventually
reaches its `arktype` dependency via a relative path. When the loader hooks
`arktype/out/index.js` this way, it appends a `?mtime=<tag>` cache-bust suffix
to the module specifier, which breaks arktype's own internal resolution of
`@ark/schema` — even though `@ark/schema` is correctly installed on disk.
Install then fails validation with:

```
ResolveMessage: Cannot find module '@ark/schema' from '.../arktype/out/index.js?mtime=...'
```

This reproduces for **any** extension that bare-imports `@oh-my-pi/pi-catalog`
at runtime, bundled or not — it's a bug in the OMP loader's graph walk, not
something specific to how we build. First-party OMP extensions
(`@oh-my-pi/swarm-extension`, and third-party extensions like
`omp-openai-provider-tools`) avoid it entirely by never bare-importing
`@oh-my-pi/pi-catalog`, `@oh-my-pi/pi-ai`, or `@oh-my-pi/pi-coding-agent` at
runtime.

### The pattern to follow here

- `@oh-my-pi/pi-ai` and `@oh-my-pi/pi-coding-agent` — `import type` only.
  Erased at build time, never appear as a runtime specifier.
- Real runtime helpers that only need something small (e.g. `getAgentDir`) —
  import from `@oh-my-pi/pi-utils` instead. It's a lightweight package with no
  `arktype`/schema-validation dependency, and it's what
  `@oh-my-pi/swarm-extension` itself uses. Keep it listed as `external` in
  `build.ts` and as a `peerDependencies` entry in `package.json` — the host
  always provides it, same as `pi-ai`/`pi-coding-agent`.
- `getBundledModel` from `@oh-my-pi/pi-catalog` (used in `mapper.ts` for
  built-in model metadata enrichment) — this one has no equivalent on the
  `ExtensionAPI` surface exposed to `pi`, so it's a genuine build-time-only
  dependency. **Do not list it in `build.ts`'s `external` array.** Let `bun
  build` inline it (and its `arktype`/`zod` dependency chain) directly into
  `dist/extension.js`, so no `@oh-my-pi/pi-catalog` or `arktype` bare
  specifier survives in the bundle for the OMP loader to trip over. It stays
  a `devDependency` only (no `peerDependencies` entry) since it's never
  resolved at the host's runtime.

After any change touching `mapper.ts` or `build.ts`'s `external` list, sanity
check the built bundle before committing:

```sh
bun run build.ts
grep -n 'from "@oh-my-pi' dist/extension.js   # only pi-ai/pi-coding-agent (type-only, shouldn't appear) or pi-utils
grep -n '"arktype"\|"@ark/' dist/extension.js  # should be empty or non-import string literals only
```

Then verify against a real OMP install (not just a clean build):

```sh
omp plugin install /path/to/packages/plexus-oh-my-pi
```

A `bun -e "import('...arktype/out/index.js')"` succeeding in isolation is
**not** sufficient to confirm the fix — the bug only manifests through OMP's
`?mtime=` hook rewriting, so the real `omp plugin install` (or `omp plugin
link` via a local path) is required to catch a regression.
