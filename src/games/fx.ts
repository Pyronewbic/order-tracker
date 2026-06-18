import type { Currency } from "../money/fx.js";

/**
 * Currency of a game platform, from its region suffix (eShop US/AR/JP, Amazon
 * JP). Amount parsing and USD conversion live in the shared `../money/fx` module.
 */
export function currencyFor(platform: string): Currency {
  if (platform.endsWith(" AR")) return "ARS";
  if (platform.endsWith(" JP")) return "JPY";
  return "USD"; // eShop US and anything else default to USD
}
