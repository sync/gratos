# interfaces/InterfaceMergedIntoNode.invalid.ts5.ts

## Input

```ts title="interfaces/InterfaceMergedIntoNode.invalid.ts5.ts"
// Note: Node is a built in class.
/** @gqlInterface */
interface Node {
  /** @gqlField */
  id: string;
}
```

## Output

### Error Report

```text
test/ts7Fixtures/interfaces/InterfaceMergedIntoNode.invalid.ts5.ts:3:11 - error: Unexpected merged interface. If an interface is declared multiple times in a scope, TypeScript merges them. To avoid ambiguity Grats does not support using merged interfaces as GraphQL definitions. Consider using a unique name for your TypeScript interface and renaming it.

 Learn more: https://grats.capt.dev/docs/docblock-tags/interfaces/#merged-interfaces

3 interface Node {
            ~~~~

  <typescript>/lib/lib.dom.d.ts:21658:11
    21658 interface Node extends EventTarget {
                    ~~~~
    Other declaration
```