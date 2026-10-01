# Contributing

Issues and pull requests are welcome. Before opening a change:

1. Use Node.js 22.19 or newer and pnpm 11.7.0.
2. Run `pnpm install`.
3. Run `pnpm run check`.
4. If generated client output changes, commit the updated `lib/` files.

`pnpm test` runs the effort-selection regressions without contacting a model.
`pnpm test:browser` runs the real pointer and keyboard regressions against a
mock directory in an isolated browser. Windows uses the installed Microsoft
Edge; on other platforms, run `pnpm exec playwright install chromium` first.

Please keep changes focused and describe the DSH version used for testing.
