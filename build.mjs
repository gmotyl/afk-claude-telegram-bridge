import * as esbuild from 'esbuild'
import * as fs from 'fs'
import * as path from 'path'

await Promise.all([
  esbuild.build({
    entryPoints: ['src/hook/index.ts'],
    bundle: true,
    minify: true,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/hook.js',
    // Don't add banner since source file has shebang
  }).then(() => {
    // Add shebang if not already present
    const hookPath = 'dist/hook.js'
    let content = fs.readFileSync(hookPath, 'utf8')
    if (!content.startsWith('#!/usr/bin/env node')) {
      content = '#!/usr/bin/env node\n' + content
      fs.writeFileSync(hookPath, content)
    }
  }),
  esbuild.build({
    entryPoints: ['src/bridge/daemon.ts'],
    bundle: true,
    minify: true,
    platform: 'node',
    target: 'node18',
    outfile: 'dist/bridge.js',
    // Don't add banner since source file has shebang
  }).then(() => {
    // Add shebang if not already present
    const bridgePath = 'dist/bridge.js'
    let content = fs.readFileSync(bridgePath, 'utf8')
    if (!content.startsWith('#!/usr/bin/env node')) {
      content = '#!/usr/bin/env node\n' + content
      fs.writeFileSync(bridgePath, content)
    }
  }),
])
console.log('Build complete')
