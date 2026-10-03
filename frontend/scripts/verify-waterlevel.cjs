#!/usr/bin/env node
// 水位审核链路的可复跑校验：类型脚本由 tsc 编到临时目录后用 require 钩子解析 @/ 别名。
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const Module = require('node:module')
const path = require('node:path')

const root = path.join(__dirname, '..')
const dist = path.join(root, 'scripts', 'dist')
fs.rmSync(dist, { recursive: true, force: true })
execFileSync(
  process.execPath,
  [path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', path.join(__dirname, 'tsconfig.verify.json')],
  { stdio: 'inherit' },
)
fs.writeFileSync(path.join(dist, 'package.json'), JSON.stringify({ type: 'commonjs' }))

const orig = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request.startsWith('@/')) {
    request = path.join(dist, 'src', request.slice(2))
  }
  return orig.call(this, request, ...rest)
}

require(path.join(dist, 'scripts', 'verify-waterlevel.js'))
