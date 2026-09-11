# A note on strictness

The sim compiles osu!idle's simulation **from source** into its own program, so
its `tsconfig.json` has to accept the compiler settings that source was written
under - notably it cannot turn on `noUncheckedIndexedAccess` or
`noImplicitOverride`, which the game does not use and which report errors inside
`@osu-idle/shared/sim/**`.

The SDK imports none of the game's source, so it keeps the stricter setting.

Typechecking uses a generated config, because the checkout's location is a local
choice:

```sh
npm run typecheck     # generates tsconfig.generated.json, then runs tsc
```
