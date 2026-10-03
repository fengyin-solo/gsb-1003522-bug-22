// 用 esbuild 把 TS 测试打成 CJS 后注入 localStorage shim 运行。
const esbuild = require('esbuild')
const path = require('path')
const vm = require('vm')

const srcDir = path.join(__dirname, '..', 'src')

async function main() {
  const result = await esbuild.build({
    entryPoints: [path.join(__dirname, 'waterlevel-behavior.test.ts')],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
    alias: { '@': srcDir },
  })
  const code = result.outputFiles[0].text

  // localStorage shim
  const store = new Map()
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      store.set(k, String(v))
    },
    removeItem: (k) => store.delete(k),
  }
  const sandbox = {
    require,
    module: { exports: {} },
    exports: {},
    process,
    console,
    setTimeout,
    clearTimeout,
    URL,
    Blob: class {},
    window: { localStorage },
    localStorage,
    document: { createElement: () => ({}), body: { appendChild() {}, removeChild() {} } },
  }
  sandbox.global = sandbox
  vm.createContext(sandbox)
  try {
    vm.runInContext(code, sandbox, { filename: 'waterlevel-behavior.test.cjs' })
  } catch (err) {
    console.error(err)
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
