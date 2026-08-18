import type { Locale } from "../config";
import { en, type MessageKey } from "./en";
import { zh } from "./zh";

export type { MessageKey };

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en, zh };

export { en, zh };
