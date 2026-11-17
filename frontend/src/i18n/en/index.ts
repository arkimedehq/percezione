import { common } from "./common.ts";
import { events } from "./events.ts";
import { cameras } from "./cameras.ts";
import { editor } from "./editor.ts";
import { rules } from "./rules.ts";
import { live } from "./live.ts";
import { history } from "./history.ts";
import { analyzers } from "./analyzers.ts";
import { usage } from "./usage.ts";
import { agents } from "./agents.ts";
import { outputs } from "./outputs.ts";
import { home } from "./home.ts";
import { people } from "./people.ts";
import { tuning } from "./tuning.ts";

/** The English messages: the source every other language follows. */
export const en = { common, events, cameras, editor, rules, live, history, analyzers, usage, agents, outputs, home, people, tuning };

export type Messages = typeof en;
