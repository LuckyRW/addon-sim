<p align="center">
  <img src="icon.svg" alt="" width="112">
</p>

<h1 align="center">osu!idle sim</h1>

<p align="center">
  An add-on for <a href="https://github.com/osu-idle/osu-idle">osu!idle</a> that simulates plays on every map you have downloaded
</p>

<p align="center">
  Press <strong>Ctrl+Shift+F</strong> in game to open the overlay.
</p>

## How it works

It runs osu!idle's own `CharacterBot` + `ManiaGame` against each chart, the same simulation the server uses for authoritative scores, then ranks the results.

It uses XP/second for each skill, and can approximate pp gains.

## Rates

Each map is simulated at every rate your character's Speed upgrades unlock, or at one rate you pick (each rate is a full extra sweep).

## Playlists

Use the top n maps rather that the single best one to avoid mindblock.

A playlist plays at the one rate set in song select, so a generated playlist sticks to its best rate, which the save message names.

After saving playlists, reopen the song select screen to see the changes.

Works on your downloaded maps. Each map is averaged over several runs.

## Building it

Built with the [osu!idle Addon SDK](https://github.com/osu-idle/addon-sdk).

The sim bundles the game's simulation from source, so it builds against a
checkout of the game. That checkout is the pinned submodule - a public release,
which is what the bundle's `gameVersion` claims - and not a working clone, which
carries unreleased work no server runs.

```sh
npm install

git submodule update --init --depth 1 vendor/osu-idle
npm install --prefix vendor/osu-idle

npm run verify     # typecheck, tests, build
```

`dist/osu-idle-sim.js` is the file to paste into the in-game add-on editor
(Options → Add-ons → Manage).

`npm run bench` prints where a sweep's time goes.

## Licence

AGPL-3.0-only. The add-on bundles osu!idle's simulation, which is AGPL-3.0.
