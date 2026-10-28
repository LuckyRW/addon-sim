/**
 * The player's skills, rebuilt from the game's `character` row for the sim.
 *
 * Its own module so the tests can load it without the worker's pp engine.
 */

import { fatigueLevel, warmup } from '@oss-idle/shared/fatigue';
import { makeOrderedSkills } from '@oss-idle/shared/rulesets/mania/4k/skills/factory';
import Memory from '@oss-idle/shared/rulesets/mania/4k/skills/memory';
import { tireSkill } from '@oss-idle/shared/rulesets/mania/4k/tiring';
import { levelProgress, xpGivesLevel } from '@oss-idle/shared/xp';

/**
 * Rebuild the player's skills from a stored `character` row, tired as a
 * character `minutes` of fatigue in, the way the server's `loadCharacterSkills` does.
 *
 * `timesPlayed` seeds the memory skill, which is per map: left at 0, memory earns
 * nothing anywhere.
 */
export const skillsFrom = (row: Record<string, unknown>, timesPlayed: number, minutes: number) => {
	const gear = Number(row.staminaUpgrades) || 0;
	const fatigue = fatigueLevel(minutes);
	const warm = warmup(minutes, gear);
	const skills = makeOrderedSkills();
	for (const skill of skills) {
		const set = (field: 'level' | 'xp' | 'upgrades' | 'overdrive' | 'prestige' | 'lifetimeXp', column: string) => {
			const value = row[column];
			if (typeof value === 'number') skill[field].set(value);
		};
		set('level', skill.name);
		set('xp', `${skill.name}XP`);
		set('upgrades', `${skill.name}Upgrades`);
		set('overdrive', `${skill.name}Overdrive`);
		set('prestige', `${skill.name}Prestige`);
		// since 1.3 a skill plays at what all its xp ever bought (`playLevelOf`): the
		// profile shows that level, and the server's sim plays it. The public skills
		// still read their held level, so hand them the lifetime one where it is higher
		set('lifetimeXp', `${skill.name}LifetimeXp`);
		const lifetime = xpGivesLevel(skill.lifetimeXp.get());
		if (lifetime.level + levelProgress(lifetime.level, lifetime.xp)
			> skill.level.get() + levelProgress(skill.level.get(), skill.xp.get())) {
			skill.level.set(lifetime.level);
			skill.xp.set(lifetime.xp);
		}
		tireSkill(skill, fatigue, warm);
		if (skill instanceof Memory) skill.timesPlayed.set(timesPlayed);
	}
	return skills;
};
