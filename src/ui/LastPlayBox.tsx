/**
 * A small box at the left of song select: the selected difficulty's last play
 * at the rate and mods picked, in base XP per second, and the levels it was
 * played at. It reads the selection off the song select cards (the active one
 * carries its difficulty's id, and a playlist lock its rate and mods) and the
 * picked rate and mods from the game's own settings in localStorage.
 */

import { useEffect, useRef, useState } from 'react';
import { beatmapStore, gameCharacter, type CharacterRow } from '@oss-idle/addon-sdk';
import { modsKey, parseMods, type Mod } from '@oss-idle/shared/mods';
import { allowedRate } from '@oss-idle/shared/rate';
import { libraryIndex, type MapInfo } from '../engine/client.js';
import { lastPlayOf, notePlays, type LastPlay } from '../engine/lastPlay.js';
import { baseOf, progress7k, readAttempts, RULESET_7K, statusOf, testsOf, type RateStatus } from '../engine/seven.js';

/** The ruleset the player picked: the game's add-on host says it (1.3 has only 4K). */
const ruleset = (): string => {
	try { return (globalThis as { ossIdle?: { ruleset?: { current?: () => string } } }).ossIdle?.ruleset?.current?.() ?? 'mania4k'; } catch { return 'mania4k'; }
};
import { formatXp, skillLabel } from './parts.js';

const SELECTION_MS = 300;
const CHARACTER_MS = 3000;

const stored = <T,>(key: string, fallback: T): T => {
	try {
		const value = localStorage.getItem(key);
		return value === null ? fallback : JSON.parse(value) as T;
	} catch {
		return fallback;
	}
};

/** The selected difficulty, with the rate and mods it would play at. */
const selection = (speedUpgrades: number): { beatmapId: number; rate: number; mods: string } | undefined => {
	const card = document.querySelector<HTMLElement>('.bm-card.is-active[data-id]');
	if (!card) return undefined;
	const beatmapId = Number(card.dataset.id);
	if (!beatmapId) return undefined;
	// a playlist lock, `rate+MODS`, wins over what is picked
	const lock = card.dataset.lock;
	if (lock) {
		const [rate, mods = ''] = lock.split('+');
		const letters = (mods.match(/.{2}/g) ?? []) as Mod[];
		return { beatmapId, rate: Number(rate), mods: modsKey(letters) };
	}
	const rate = allowedRate(stored('rate', 1), speedUpgrades);
	return { beatmapId, rate, mods: modsKey(parseMods(stored<Mod[]>('mods', []).join(','))) };
};

const ago = (ms: number) => {
	const minutes = Math.round((Date.now() - ms) / 60000);
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
};

export default function LastPlayBox({ sevenVersion = 0 }: { sevenVersion?: number }) {
	const [character, setCharacter] = useState<CharacterRow>();
	const [library, setLibrary] = useState<Map<number, MapInfo>>(new Map());
	const [picked, setPicked] = useState<{ beatmapId: number; rate: number; mods: string }>();
	const [play, setPlay] = useState<LastPlay | null>();
	const [seven, setSeven] = useState(false);
	const [status, setStatus] = useState<RateStatus>();
	const [speed7k, setSpeed7k] = useState(0);
	const [lengths, setLengths] = useState<Map<number, number>>(new Map());
	const pickedKey = picked && `${picked.beatmapId}@${picked.rate}@${picked.mods}`;
	const asked = useRef('');

	useEffect(() => { void libraryIndex().then(setLibrary).catch(() => undefined); }, []);
	// every difficulty's length, 7K's too: the library index holds 4K's only
	useEffect(() => {
		void beatmapStore.difficulties()
			.then(list => setLengths(new Map(list.map(({ version }) => [version.id, version.total_length / 1000]))))
			.catch(() => undefined);
	}, []);

	// the character, and noting each play as it comes in
	useEffect(() => {
		let gone = false;
		const tick = async () => {
			try {
				const row = await gameCharacter.live();
				if (gone || !row) return;
				setCharacter(row);
				await notePlays(row);
			} catch { /* the database is not open yet */ }
		};
		void tick();
		const timer = setInterval(() => void tick(), CHARACTER_MS);
		return () => { gone = true; clearInterval(timer); };
	}, []);

	// the selection
	useEffect(() => {
		const timer = setInterval(() => {
			const is7k = ruleset() === RULESET_7K;
			setSeven(is7k);
			const now = selection(is7k ? speed7k : Number(character?.speedUpgrades) || 0);
			setPicked(old => (old?.beatmapId === now?.beatmapId && old?.rate === now?.rate && old?.mods === now?.mods ? old : now));
		}, SELECTION_MS);
		return () => clearInterval(timer);
	}, [character?.speedUpgrades, speed7k]);

	// its last play, again whenever the selection changes or a play comes in
	const newest = character ? `${character.id}|${character.overallTotalXp}` : '';
	useEffect(() => {
		if (!character || !picked) { setPlay(undefined); return; }
		if (seven) {
			const length = lengths.get(picked.beatmapId);
			if (!length) { setPlay(undefined); return; }
			void progress7k(Number(character.id)).then(progress => {
				setSpeed7k(progress?.speedUpgrades ?? 0);
				const all = readAttempts().filter(a => a.characterId === Number(character.id)).sort((a, b) => a.startedAt - b.startedAt);
				const tests = testsOf(all, progress?.levelSum ?? 0).get(`${picked.beatmapId}|${picked.mods}`);
				setStatus(statusOf(tests, picked.rate));
				const last = tests?.byRate.get(picked.rate)?.filter(a => !a.failed).at(-1);
				setPlay(last ? {
					playedAt: last.startedAt, rate: last.rate, mods: last.mods, base: baseOf(last, all), seconds: length / last.rate,
					levels: last.levels, recent: 0,
				} : null);
			});
			return;
		}
		const length = library.get(picked.beatmapId)?.lengthSec;
		if (!length) { setPlay(undefined); return; }
		const key = `${pickedKey}|${newest}`;
		asked.current = key;
		void lastPlayOf(character, picked.beatmapId, picked.rate, picked.mods, length)
			.then(found => { if (asked.current === key) setPlay(found ?? null); })
			.catch(() => { if (asked.current === key) setPlay(undefined); });
	}, [pickedKey, newest, library, seven, lengths, sevenVersion]);

	if (!picked || play === undefined) return null;
	const label = `x${picked.rate}${picked.mods ? ` +${picked.mods.replace(/,/g, '')}` : ''}`;
	const skills = play ? Object.entries(play.base).filter(([, xp]) => xp > 0).sort((a, b) => b[1] - a[1]) : [];
	const total = skills.reduce((sum, [, xp]) => sum + xp, 0);

	return (
		<div className="last-play" role="status" aria-label="Last play at this rate">
			<div className="last-play__head">{seven ? '7K · ' : ''}Last play at {label}</div>
			{seven && status && status !== 'tested' && (
				<div className="last-play__none" style={{ color: status === 'untested' ? '#fbbf24' : '#888' }}>
					{status === 'untested' ? 'Untested: worth a try' : status === 'failed' ? 'Failed here: not passed yet' : `Ruled out: ${status}`}
				</div>
			)}
			{play === null ? (
				<div className="last-play__none">Never played at this rate and mods</div>
			) : (
				<>
					<div className="last-play__total">{formatXp(total / play.seconds)} <span>base XP/s</span></div>
					{skills.slice(0, 4).map(([skill, xp]) => (
						<div className="last-play__row" key={skill}>
							<span>{skillLabel(skill)}</span>
							<span>{formatXp(xp / play.seconds)}/s</span>
							<span className="last-play__lvl">{play.levels ? `Lv ${play.levels[skill]?.toFixed(1) ?? '?'}` : ''}</span>
						</div>
					))}
					<div className="last-play__foot">
						{ago(play.playedAt)}
						{play.levels ? '' : ' · level not noted (played before tracking)'}
						{seven ? ' · fatigue taken out' : ''}
						{play.recent ? ` · mindblock taken out (${play.recent} recent)` : ''}
					</div>
				</>
			)}
		</div>
	);
}
