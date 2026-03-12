import * as esbuild from 'esbuild'
import * as fs from 'fs'

const addShebang = (filePath) => {
  let content = fs.readFileSync(filePath, 'utf8')
  if (!content.startsWith('#!/usr/bin/env node')) {
    content = '#!/usr/bin/env node\n' + content
    fs.writeFileSync(filePath, content)
  }
}

const bundles = [
  { entryPoints: ['src/hook/index.ts'], outfile: 'dist/hook.js' },
  { entryPoints: ['src/bridge/daemon.ts'], outfile: 'dist/bridge.js' },
  { entryPoints: ['src/cli/index.ts'], outfile: 'dist/cli.js' },
]

await Promise.all(
  bundles.map(({ entryPoints, outfile }) =>
    esbuild.build({
      entryPoints,
      bundle: true,
      minify: true,
      platform: 'node',
      target: 'node18',
      outfile,
      external: ['node:sqlite'],
    }).then(() => addShebang(outfile))
  )
)
console.log('Build complete')
