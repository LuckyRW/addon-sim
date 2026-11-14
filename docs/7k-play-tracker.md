# 7K play tracker: notes while waiting for the update

7K gets no sim API, so maps can't be tested in advance. Everything comes from
real plays. The tracker logs every play, works out base XP/s, keeps track of
which map/rate pairs are still worth testing, and builds the playlist that
tests them.

A first version can run on 4K now (v3.30.0's song select box), since 4K keeps
the same data in the same tables.

## 1. What to note on every play

Taken when a new row shows up in `score`, together with its `score_xp.gains`:

| Field | From | Why |
|---|---|---|
| map, rate, mods, passed, accuracy, playedAt | `score` | which test this was |
| XP per skill, as given | `score_xp.gains` | the raw result |
| **level per skill** at the time | `character` row, read right after the play | "what level was I when I last played this" |
| skill multipliers (upgrades, overdrive, prestige) | `character` row | divided out to get base XP |
| **genetics**: gene tiers + picked genetic | `character.genetics` (newer game versions) | divided out too: each tier gives +5% to its skill (`GENE_XP_BONUS`), and the picked genetic gives `GENETIC_XP_BONUS` = +10% |
| medals multiplier | API `/v1/characters/{id}/medals` | divided out |
| mindblock count | the plays before it in `score` (last 50 in 24 h) | divided out |
| **fatigue before → after** | worked out with `fatigue.ts` (see §3) | strain drift per play |

Base XP = given ÷ (skill multiplier × genetics × medals × mods × mindblock).
Fatigue stays in unless the strain at the time is known (see §3).

**Already in v3.30.0:** levels, skill multipliers and medals noted per play,
with mindblock and mods divided out. **Still to do:** genetics (once the
game version has them) and fatigue.

## 2. Song select box

For the selected map at the picked rate and mods:
- base XP/s of the last play, per skill and in total;
- **the level of each skill when it was played**;
- when it was played;
- whether this map/rate is **untested**, **ruled out** (and by which rule), or worth testing again.

## 3. Fatigue drift

The server keeps strain, and 7K has no sim to report each play's strained
minutes. Two ways to get it:
1. **Estimate:** run your own play log through `fatigue.ts` (`afterPlay` / `restedFatigue`), with each play's strained time taken from its physical-skill XP share. This is rough until it can be checked against something real.
2. **Measure:** if the game ever shows strain (the warm-up bar), read it before and after each play. Drift = after − before, minus the rest during the wait between maps.

What to store per map/rate: drift per play (warming or cooling) and drift per
second. This feeds the warm/cool pairing used in Repeats mode.

Once strain at play time is known, fatigue can be divided out of physical
skills' XP as well (`fatigueXp`).

## 4. Testing list: untested map/rate pairs, cut down by two rules

Every downloaded 7K map × every unlocked rate (× mods if wanted) starts out
untested. A pair leaves the list once it has been tested, or once a rule
rules it out:

- **Too easy:** if a map at rate X gives **0 XP**, rule out every rate **below X**. Slower is only easier.
- **Too hard:** if a map **fails** at rate Y, rule out every rate **above Y**. Faster is only harder.
  - This rule is lifted once **any skill levels up** after that failure. Store the total of all skill levels at the time of the failure, and test the faster rates again once it's higher.
- Rules only cover the same map with the same mods.

With both rules, each map's testable rates shrink to a window between "too easy" and "too hard".

A single fail is enough to rule out the faster rates. There's no retry after
a fail, because failed plays aren't worth replaying.

**Testing order, screen then refine (as addon-sim's scan does):**
1. **Screen:** test each map at every third rate, plus x1 and the fastest rate (`screenRates`). The two rules above cut this grid down further as results come in.
2. **Refine:** for the best maps from screening, test every rate between the two screened rates either side of the map's best one (`refinePlan`). This assumes XP/s rises and then falls once across a map's rates.

## 5. Automatic testing playlist

One button: "Playlist of untested pairs".
- **Mode A, x1 only:** every map not yet tested at x1. A quick first pass that sets each map's window.
- **Mode B, screening:** each map at its untested screening rates from §4. It's rebuilt after each pass, since results remove pairs.
- **Mode C, refining:** the best maps at the rates between their screened neighbours.
- It's saved through the playlist writer addon-sim already has (`replacePlaylist`), with each entry locked to its rate and mods.
- Spread each map's tests out so mindblock doesn't lower the readings, or divide it out as in §1. Fatigue still affects physical XP, so it's best to test at a steady strain.

## 6. Using the results

Once enough is tested, the farm planner (Repeats / warm-cool) runs on
measured base XP/s and measured drift instead of the sim. A map/rate tested
at a lower level can be marked out of date and tested again after big level
gains.

## What the game source says (public source as of Nov 8 2026; the beta server may differ)

- **Skills:** accuracy, speed, stamina, jacks, independence, ln, technical, focus, sv, memory.
  - Physical (fatigue applies): speed, stamina, jacks, ln.
  - Mindblock applies to every skill except the physical ones and memory.
- **XP per play:** `score_xp.gains` is JSON keyed by the play's own skill names, so 7K uses it as-is.
- **Levels and multipliers:** kept in their own table, `character_mania7k` (one row per character, `characterId`). It has the same columns as 4K: `<skill>`, `XP`, `Upgrades`, `Overdrive`, `Prestige`, `TotalXp`, `LifetimeXp`, plus `memoryResetAt`.
- **Genetics:** `character_mania7k.geneticsJson`, so 7K has its own genes.
- **Mod XP:** `modXpMultipliers7k` in `rulesets/mania/7k/modXp.ts`. NF gives nothing, EZ half, and HR ×1.1 accuracy.
- **Still open:** whether strain can be read anywhere, and whether the beta server's version matches this source.
