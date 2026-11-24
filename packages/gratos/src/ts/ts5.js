// The TypeScript 5.9.2 implementation of the `#typescript` facade: a pass-through to the
// `typescript-baseline` devDependency. Only the parity run (vitest.parity.config.ts) loads it, so
// the same engine code runs on both TypeScripts. The CLI never does.
// oxlint-disable-next-line import/export -- typescript-baseline is CommonJS; Node and Vite expose its named exports.
export * from "typescript-baseline";
