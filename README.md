<p align="center">
  <img src="icon.svg" alt="" width="112">
</p>

<h1 align="center">oss!idle sim</h1>

<p align="center">
  An add-on for <a href="https://github.com/oss-idle/oss-idle">oss!idle</a> that simulates plays on every map you have downloaded
</p>

<p align="center">
  Press <strong>Ctrl+Shift+F</strong> in game to open the overlay. Needs oss!idle 1.2 or later.
</p>

## How it works

It runs oss!idle's own `CharacterBot` + `ManiaGame` against each chart, the same simulation the server uses for authoritative scores, then ranks the results.

It uses XP/second for each skill, and can approximate pp gains.

A scan runs in two passes. Every map is screened once at a few rates, then the
best 50 are simulated again, averaged over the runs you set, at every rate
around their best. Memory is simulated halfway through a session's plays of
each map, since that is what a playlist farms.

## Rates

Each map is simulated at the rates you tick among those your character's Speed upgrades unlock. Screening takes every third of them (plus x1 and the fastest), and skips a map's faster rates once two in a row always fail. The table lists each difficulty once, at its best rate.

## Playlists

Use the top n maps rather that the single best one to avoid mindblock.

Saved entries can be locked at their rate (all of them, all but x1, or none), so a playlist can mix rates. An unlocked entry follows the rate set in song select, so with no locks a generated playlist sticks to its best rate, which the save button names. Tick "Several rates of one difficulty" to let the playlist hold a difficulty more than once; mindblock counts all of its plays.

After saving playlists, reopen the song select screen to see the changes.

Works on your downloaded maps.

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
