import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { chromium } from 'playwright'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(root, '.client-build')
await mkdir(output, { recursive: true })
// Expose the private component only in this test build; the shipped API stays unchanged.
const source = (await readFile(resolve(root, 'src/client/index.tsx'), 'utf8'))
  .replaceAll("from './", "from '../src/client/")
await writeFile(resolve(output, 'slider-under-test.tsx'), source + '\nexport { EffortSlider }\n')
await build({
  entryPoints: [resolve(root, 'tests/browser/fixture.tsx')],
  outfile: resolve(output, 'browser-fixture.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  loader: { '.png': 'dataurl', '.md': 'text' },
})
const browser = await chromium.launch({
  headless: true,
  ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
})
const context = await browser.newContext({ viewport: { width: 800, height: 600 }, reducedMotion: 'reduce' })
const page = await context.newPage()
const results = []
const errors = []
page.on('pageerror', error => errors.push(error.message))
await page.setContent('<html><body style="margin:40px"><div id="app" style="width:300px"></div></body></html>')
await page.addScriptTag({ path: resolve(output, 'browser-fixture.js') })
const input = page.locator('input[type=range]')
const ready = async (id) => {
  await page.waitForFunction(id => {
    const input = document.querySelector('input[type=range]')
    return input?.getAttribute('aria-valuetext') === id && !input.disabled
  }, id)
}
const mount = async (ids, initial = 'high', mode = 'normal') => {
  await page.evaluate(({ ids, initial, mode }) => window.fixture.mount(ids, initial, mode), { ids, initial, mode })
  await ready(initial)
}
const clickIndex = async (index, count) => {
  const box = await input.boundingBox()
  const x = box.x + Math.max(1, Math.min(box.width - 1, box.width * index / (count - 1)))
  await page.mouse.move(x, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.up()
}
const calls = () => page.evaluate(() => window.fixture.calls)
const test = async (name, action) => {
  await action()
  results.push({ name, passed: true })
  console.log('PASS:', name)
}
const all = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
try {
  await test('native pointer positions match all seven effort IDs', async () => {
    await mount(all)
    for (let i = 0; i < all.length; i++) {
      await clickIndex(i, all.length)
      await ready(all[i])
      assert.equal((await calls()).at(-1).reasoningEffort, all[i])
    }
  })
  await test('keyboard arrows, Home and End submit matching IDs', async () => {
    await mount(all)
    await input.press('Home'); await ready('off')
    await input.press('ArrowRight'); await ready('minimal')
    await input.press('End'); await ready('max')
    await input.press('ArrowLeft'); await ready('xhigh')
    assert.deepEqual((await calls()).map(c => c.reasoningEffort), ['off', 'minimal', 'max', 'xhigh'])
  })
  await test('catalog expansion during commit preserves low instead of off', async () => {
    await mount(['low', 'high', 'max'], 'high', 'expand')
    await clickIndex(0, 3)
    await ready('low')
    assert.deepEqual((await calls()).map(c => c.reasoningEffort), ['low'])
    assert.equal(await input.inputValue(), '1')
  })
  await test('removed max produces visible error without submitting high', async () => {
    await mount(['off', 'low', 'high', 'max'], 'high', 'remove-max')
    await clickIndex(3, 4)
    await page.locator('.re-effort.is-error').waitFor()
    assert.match(await page.locator('.re-effort').getAttribute('title'), /effort\.failed/)
    assert.deepEqual(await calls(), [])
    await ready('high')
  })
  await test('stale high projection does not snap max backwards after successful RPC', async () => {
    await mount(['off', 'low', 'high', 'max'], 'high', 'lag')
    await clickIndex(3, 4)
    await page.waitForTimeout(40)
    assert.equal(await input.getAttribute('aria-valuetext'), 'max')
    assert.equal(await input.isDisabled(), true)
    assert.equal((await calls()).at(-1).reasoningEffort, 'max')
    await ready('max')
  })
  await test('stale off projection does not overwrite low preview', async () => {
    await mount(['off', 'low', 'high', 'max'], 'off', 'lag')
    await clickIndex(1, 4)
    await page.waitForTimeout(40)
    assert.equal(await input.getAttribute('aria-valuetext'), 'low')
    assert.equal((await calls()).at(-1).reasoningEffort, 'low')
    await ready('low')
  })
  for (const ids of [['off', 'low', 'high', 'max'], ['max', 'high', 'low']]) {
    await test(`catalog changes between pointerdown/up cancel rather than remap (${ids.join('/')})`, async () => {
      await mount(['low', 'high', 'max'])
      const box = await input.boundingBox()
      await page.mouse.move(box.x + 1, box.y + box.height / 2)
      await page.mouse.down()
      assert.equal(await input.getAttribute('aria-valuetext'), 'low')
      await page.evaluate(ids => window.fixture.current.publish(window.fixture.current.state(ids, 'high')), ids)
      await page.locator('.re-effort.is-error').waitFor()
      await page.mouse.up()
      await ready('high')
      assert.deepEqual(await calls(), [])
      assert.equal(await page.locator('.re-effort.is-dragging').count(), 0)
    })
  }
  await test('model change during an active drag clears dragging and submits nothing', async () => {
    await mount(all)
    const box = await input.boundingBox()
    await page.mouse.move(box.x + 1, box.y + box.height / 2)
    await page.mouse.down()
    await page.evaluate(ids => window.fixture.changeModel(ids), all)
    await ready('high')
    assert.equal(await page.locator('.re-effort.is-dragging').count(), 0)
    await page.mouse.up()
    assert.deepEqual(await calls(), [])
  })
  await test('failed model A selection cannot leave its error on model B', async () => {
    await mount(['off', 'low', 'high', 'max'], 'high', 'remove-max')
    await clickIndex(3, 4)
    await page.locator('.re-effort.is-error').waitFor()
    await page.evaluate(ids => window.fixture.changeModel(ids), all)
    await ready('high')
    assert.equal(await page.locator('.re-effort.is-error').count(), 0)
  })
  await test('model change during catalog loading cancels old operation and clears busy', async () => {
    await mount(all, 'high', 'slow')
    await clickIndex(6, 7)
    await page.evaluate(ids => window.fixture.changeModel(ids), all)
    await ready('high')
    await page.waitForTimeout(150)
    assert.deepEqual(await calls(), [])
    assert.equal(await input.isDisabled(), false)
    assert.equal(await input.getAttribute('aria-valuetext'), 'high')
  })
  await test('unmount during projection wait removes all subscriptions', async () => {
    await mount(all, 'high', 'lag')
    await clickIndex(6, 7)
    await page.evaluate(() => window.fixture.unmount())
    await page.waitForTimeout(180)
    assert.equal(await page.evaluate(() => window.fixture.current.listeners.size), 0)
  })
  assert.deepEqual(errors, [])
  await writeFile(resolve(output, 'browser-results.json'), JSON.stringify({ browser: await browser.version(), results, pageErrors: errors }, null, 2))
  console.log(`${results.length} isolated real-browser checks passed; zero page errors.`)
} finally {
  await context.close()
  await browser.close()
}
