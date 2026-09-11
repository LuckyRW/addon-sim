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

## Playlists

Use the top n maps rather that the single best one to avoid mindblock.

After saving playlists, reopen the song select screen to see the changes.

Works on your downloaded maps. Each map is averaged over several runs.

## Building it

Built with the [osu!idle Addon SDK](https://github.com/osu-idle/addon-sdk).

The sim bundles the game's simulation from source, so it builds against a
checkout of the game with the game's own dependencies installed. Either recipe
below is complete on its own.

Against the pinned submodule:

```sh
npm install

git submodule update --init --depth 1 vendor/osu-idle
npm install --prefix vendor/osu-idle

npm run verify
```

Against a clone you already have:

```sh
npm install

game=/path/to/osu-idle
echo "OSU_IDLE_PATH=$game" > .env
npm install --prefix "$game"

npm run verify
```

`dist/osu-idle-sim.js` is the file to paste into the in-game add-on editor
(Options → Add-ons → Manage).

`npm run bench` prints where a sweep's time goes.

## Licence

AGPL-3.0-only. The add-on bundles osu!idle's simulation, which is AGPL-3.0.
