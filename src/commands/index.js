import * as join from "./join.js";
import * as leave from "./leave.js";
import * as voice from "./voice.js";
import * as speakers from "./speakers.js";
import * as fishvoice from "./fishvoice.js";
import * as dict from "./dict.js";
import * as config from "./config.js";
import * as ignore from "./ignore.js";

export const commands = [
  join,
  leave,
  voice,
  speakers,
  fishvoice,
  dict,
  config,
  ignore,
];

export const commandMap = new Map(commands.map((c) => [c.data.name, c]));
