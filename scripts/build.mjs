#!/usr/bin/env node
/**
 * Build dsh-emotion-analyzer.
 *
 * Layout:
 * - Host: every src/*.ts file transpiled individually to lib/*.js (ESM,
 *   imports preserved, no bundling) so each source file stays small.
 * - Client: src/client/index.ts bundled to one CJS factory, then wrapped in
 *   window.__ModuleLoader__.load({ id, factory(require) }) as lib/client.js.
 * - Standalone widget: demo/widget.iife.js for the mock-data preview page.
 */
import { build } from 'esbuild'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

async function collectHostEntries(dir, out = []) {
  if (!existsSync(dir)) return out
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'client' || entry.name === 'widget' || entry.name === 'shims') continue
      await collectHostEntries(path, out)
    } else if (entry.name.endsWith('.ts')) {
      out.push(path)
    }
  }
  return out
}

async function buildHost() {
  const entryPoints = await collectHostEntries(join(root, 'src'))
  if (entryPoints.length === 0) return
  await build({
    entryPoints,
    outdir: join(root, 'lib'),
    outbase: join(root, 'src'),
    bundle: false,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    sourcemap: false,
    logLevel: 'info',
  })
  // Source uses .ts specifiers so node --test can run it directly; the
  // emitted ESM must import .js. v0.2 has nested host dirs (lib/models/*),
  // so rewrite recursively instead of only lib/*.js.
  for (const entry of entryPoints) {
    const relative = relativePath(join(root, 'src'), entry).replace(/\.ts$/u, '.js')
    const path = join(root, 'lib', relative)
    if (!existsSync(path)) continue
    const code = await readFile(path, 'utf8')
    const rewritten = code.replace(/(from\s+["'])(\.{1,2}\/[^"']+)\.ts(["'])/g, '$1$2.js$3')
    if (rewritten !== code) await writeFile(path, rewritten)
  }
}

/** POSIX-style relative path between two absolute paths. */
function relativePath(from, to) {
  return to.slice(from.length + 1).split('\\').join('/')
}

async function buildClient() {
  const entry = join(root, 'src/client/index.ts')
  if (!existsSync(entry)) return
  const result = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'browser',
    target: ['chrome110', 'safari16', 'firefox115'],
    minify: true,
    legalComments: 'none',
  })
  const code = result.outputFiles[0].text
  const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
    ${code}
    return module.exports.default(require)
  },
})
`
  await writeFile(join(root, 'lib/client.js'), wrapped)
}

async function buildStandaloneWidget() {
  const entry = join(root, 'src/widget/standalone.ts')
  if (!existsSync(entry)) return
  await mkdir(join(root, 'demo'), { recursive: true })
  await build({
    entryPoints: [entry],
    outfile: join(root, 'demo/widget.iife.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome110', 'safari16', 'firefox115'],
    minify: true,
    legalComments: 'none',
  })
}

await rm(join(root, 'lib'), { recursive: true, force: true })
await mkdir(join(root, 'lib'), { recursive: true })
await buildHost()
await buildClient()
await buildStandaloneWidget()
console.log('[build] done')
