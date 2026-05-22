import * as join from "./join.js";
import * as leave from "./leave.js";
import * as voice from "./voice.js";
import * as speakers from "./speakers.js";
import * as dict from "./dict.js";

export const commands = [join, leave, voice, speakers, dict];

export const commandMap = new Map(commands.map((c) => [c.data.name, c]));
