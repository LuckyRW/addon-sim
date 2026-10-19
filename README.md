<p align="center">
  <img src="icon.svg" alt="" width="112">
</p>

<h1 align="center">oss!idle sim</h1>

<p align="center">
  An add-on for <a href="https://github.com/oss-idle/oss-idle">oss!idle</a> that simulates plays on every map you have downloaded
</p>

<p align="center">
  Press <strong>Ctrl+Shift+F</strong> in game to open the overlay.
</p>

## How it works

It runs oss!idle's own `CharacterBot` + `ManiaGame` against each chart, the same simulation the server uses for authoritative scores, then ranks the results.

It uses XP/second for each skill, and can approximate pp gains.

## Rates

Each map is simulated at the rates you tick among those your character's Speed upgrades unlock (each rate is a full extra sweep). The table lists each difficulty once, at its best rate.

## Playlists

Use the top n maps rather that the single best one to avoid mindblock.

Saved entries can be locked at their rate (all of them, all but x1, or none), so a playlist can mix rates. An unlocked entry follows the rate set in song select, so with no locks a generated playlist sticks to its best rate, which the save button names. Tick "Several rates of one difficulty" to let the playlist hold a difficulty more than once; mindblock counts all of its plays.

After saving playlists, reopen the song select screen to see the changes.

Works on your downloaded maps. Each map is averaged over several runs.

## Building it

Built with the [oss!idle Addon SDK](https://github.com/oss-idle/addon-sdk).

The sim bundles the game's simulation from source, so it builds against a
checkout of the game. That checkout is the pinned submodule - a public release,
which is what the bundle's `gameVersion` claims - and not a working clone, which
carries unreleased work no server runs.

```sh
npm install

git submodule update --init --depth 1 vendor/oss-idle
npm install --prefix vendor/oss-idle

npm run verify     # typecheck, tests, build
```

`dist/oss-idle-sim.js` is the file to paste into the in-game add-on editor
(Options → Add-ons → Manage).

`npm run bench` prints where a sweep's time goes.

## Licence

AGPL-3.0-only. The add-on bundles oss!idle's simulation, which is AGPL-3.0.
