<p align="center">
  <img src="icon.svg" alt="" width="112">
</p>

<h1 align="center">oss!idle sim</h1>

<p align="center">
  An add-on for <a href="https://github.com/oss-idle/oss-idle">oss!idle</a> that simulates plays on every map you have downloaded
</p>

<p align="center">
  Press <strong>Ctrl+Shift+F</strong> in game to open the overlay. Needs oss!idle 1.2.7.6 or later.
</p>

## How it works

It runs oss!idle's own `CharacterBot` + `ManiaGame` against each chart, the same simulation the server uses for authoritative scores, and adjusts each play's XP in the server's order: mindblock, fatigue, medals, then mods.

Pick what to farm (total XP, one skill or pp) and for how long, then scan. The overlay opens on the playlist it builds, with a forecast of the session; every map is on the All maps tab, and the rest is in Settings.

A scan runs in three passes. Every map is screened once at a few rates, the best 50 are simulated again, averaged over the runs you set, at every rate around their best, and the best 8 are played tired and cold to learn what warm-up and fatigue cost your character.

## Warm-up and fatigue

A play's worth depends on what came before it: strained minutes warm the character up and later tire it, and it rests while playing light maps and between maps (autopilot's delay). Cold, it plays its physical skills below their level; tired, it plays them worse and earns less on them.

So a playlist is judged by stepping through a whole session with the game's own `fatigue.ts`, play by play. The playlist is the one that earns the most over the session: usually heavy maps that warm you up mixed with light ones that let you rest, so the warm-up bar holds at its peak instead of drifting into fatigue. The chart compares it with the best maps alone.

## Rates and mods

Each map is simulated at the rates you tick among those your character's Speed upgrades unlock, with and without Hard Rock (+10% accuracy XP, tighter hit windows) unless you turn that off. Every saved entry is locked at its rate. Once the game stores mods on playlist entries, each entry keeps its mods too; until then a playlist uses one set of mods, which the save message names.

After saving playlists, reopen the song select screen to see the changes.

Works on your downloaded 4K maps.

## Building it

Built with the [oss!idle Addon SDK](https://github.com/oss-idle/addon-sdk).

The sim bundles the game's simulation from source, so it builds against the
game's sources: the `oss-idle` dependency, a public release's tarball pinned by
commit - which is what the bundle's `gameVersion` claims - and not a working
clone, which carries unreleased work no server runs. To move to another release,
point that dependency at the release's commit and set `gameVersion` in
`addon.config.json` to match; the build refuses a mismatch.

```sh
npm install
npm run verify     # typecheck, tests, build
```

## Releasing

oss!idle builds the add-on from this repository: release a version and it builds that tag.

```sh
npx oss-idle-addon setup          # checks the repository, prints the in-game form's values
npx oss-idle-addon release minor  # builds, tags v<next> and pushes it
```

It runs `npm ci --ignore-scripts` and then `npm run build` offline, so everything
the build needs, the game's sources included, comes from `package-lock.json`.

`dist/oss-idle-sim.js` is the file to paste into the in-game add-on editor
(Options → Add-ons → Manage). It is minified, and the build fails if it would
not fit the game server's 2 MB upload cap.

`npm run bench` prints where a sweep's time goes.

## Licence

AGPL-3.0-only. The add-on bundles oss!idle's simulation, which is AGPL-3.0.
