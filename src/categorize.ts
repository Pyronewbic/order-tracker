import type { OrderCategory } from "./types.js";

/** Signals used to categorise an order: the parsed item name + email metadata. */
export interface ItemSignal {
  itemName: string;
  from: string;
  subject: string;
}

// Deterministic, keyword-based item categorisation. Checked in priority order so
// the more specific signal wins (a "Super Mario Encyclopedia" is a Book, not a
// Game; a "case for Nintendo Switch" is an Accessory, not Electronics). Returns
// null when nothing matches confidently, so a row is left blank for manual
// curation rather than mislabelled. The keyword lists are intentionally easy to
// extend; arbitrary game titles need the optional LLM categoriser to be reliable.

const DIGITAL_SENDER = /digital-?no-?reply@|digitalorder-?update@|digital-no-reply|digitalorder/i;
const DIGITAL_TEXT =
  /\b(online code|download code|digital code|redemption code|redeem code|digital download|prepaid|gift ?card|e-?gift)\b|オンラインコード|ダウンロード版|引き換えコード|プリペイド|ギフト券/i;

const ACCESSORY =
  /\b(?:controllers?|joy-?cons?|joysticks?|gamepads?|grips?|cases?|covers?|pouches?|sleeves?|cables?|chargers?|charging|docks?|stands?|mounts?|screen protectors?|tempered glass|head ?sets?|earbuds?|skins?|straps?|adapters?|thumb ?grips?)\b/i;

const BOOK =
  /\b(?:books?|encyclopedias?|guides?|art ?books?|mangas?|novels?|hardcovers?|paperbacks?|strategy guides?|official guides?|chronicles?|compendiums?|companions?|lore)\b/i;

const ELECTRONICS =
  /\b(?:consoles?|nintendo switch 2|ps5|playstation 5|xbox|monitors?|ssd|hard drives?|routers?|laptops?|tablets?|speakers?)\b/i;

// Franchise/title keywords → Game. Extend with the series you buy.
const GAME =
  /\b(zelda|mario|metroid|kirby|splatoon|pok[eé]mon|xenoblade|fire emblem|animal crossing|donkey kong|bayonetta|pikmin|smash bros|final fantasy|dragon quest|persona|elden ring|amiibo|expansion pass|season pass|\bdlc\b)\b|ファイアーエムブレム|ゼノブレイド/i;

/**
 * Categorise an order from its item name + sender + subject, or return null if
 * no rule matches confidently. Priority: Digital → Accessory → Book →
 * Electronics → Game.
 */
export function classifyItem(signal: ItemSignal): OrderCategory | null {
  const hay = `${signal.itemName}\n${signal.subject}`;
  if (DIGITAL_SENDER.test(signal.from) || DIGITAL_TEXT.test(hay)) return "Digital";
  if (ACCESSORY.test(hay)) return "Accessory";
  if (BOOK.test(hay)) return "Book";
  if (ELECTRONICS.test(hay)) return "Electronics";
  if (GAME.test(hay)) return "Game";
  return null;
}

// Franchise name → canonical tag. Extend with the series you buy.
const FRANCHISES: [RegExp, string][] = [
  [/zelda/i, "Zelda"],
  [/mario/i, "Mario"],
  [/pok[eé]mon|ポケモン/i, "Pokémon"],
  [/xenoblade|ゼノブレイド/i, "Xenoblade"],
  [/fire emblem|ファイアーエムブレム/i, "Fire Emblem"],
  [/metroid/i, "Metroid"],
  [/kirby/i, "Kirby"],
  [/splatoon/i, "Splatoon"],
  [/animal crossing/i, "Animal Crossing"],
  [/donkey kong/i, "Donkey Kong"],
  [/final fantasy/i, "Final Fantasy"],
  [/dragon quest/i, "Dragon Quest"],
];

/**
 * Deterministic tags for an order: franchise(s) plus a few attributes
 * (Preorder, Guide, Limited Edition, Switch 2, amiibo, Digital). Returns a
 * de-duplicated list, possibly empty. The optional LLM fills tags only when this
 * (and the category) come up empty.
 */
export function tagsFor(signal: ItemSignal): string[] {
  const hay = `${signal.itemName}\n${signal.subject}`;
  const tags = new Set<string>();
  for (const [re, tag] of FRANCHISES) if (re.test(hay)) tags.add(tag);
  if (/\bpre-?orders?\b|予約/i.test(hay)) tags.add("Preorder");
  if (/\b(guide|encyclopedia|art ?book)\b/i.test(hay)) tags.add("Guide");
  if (/\b(limited|collector'?s|special|deluxe) edition\b/i.test(hay)) tags.add("Limited Edition");
  if (/\bswitch 2\b/i.test(hay)) tags.add("Switch 2");
  if (/\bamiibo\b/i.test(hay)) tags.add("amiibo");
  if (DIGITAL_SENDER.test(signal.from) || DIGITAL_TEXT.test(hay)) tags.add("Digital");
  return [...tags];
}
