/**
 * Add-on entry point.
 *
 * osu!idle imports this module from a Blob URL and calls `mount` / `unmount` -
 * that pair is the whole contract, and `defineAddon` produces it.
 */

import { defineAddon } from '@osu-idle/addon-sdk';
import { SimAddon } from './SimAddon.js';

export const { mount, unmount } = defineAddon(() => new SimAddon());
