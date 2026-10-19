# A note on strictness

The sim compiles oss!idle's simulation **from source** into its own program, so
its `tsconfig.json` has to accept the compiler settings that source was written
under - notably it cannot turn on `noUncheckedIndexedAccess` or
`noImplicitOverride`, which the game does not use and which report errors inside
`@oss-idle/shared/sim/**`.

The SDK imports none of the game's source, so it keeps the stricter setting.

The checkout is always `vendor/oss-idle`, so the path mapping to
`@oss-idle/shared` is committed in `tsconfig.json` and an editor resolves it
without any generated file:

```sh
npm run typecheck
```
