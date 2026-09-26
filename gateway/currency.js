'use strict';
/**
 * Currency: the whole system works in Indian rupees (INR).
 * Amounts are plain numbers everywhere (storefront prices, checkout bodies, wallet limits); only printing goes
 * through fmt(), which uses Indian digit grouping: 100000 -> "₹1,00,000".
 */

const SYMBOL = '₹';
const CODE = 'INR';

// Wallet policy. The 3x auto-deny threshold lives in wallet-firewall.js.
const WALLET_TX_LIMIT = 5000;       // per transaction
const WALLET_DAILY_LIMIT = 12500;   // per day

const _nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });

/** Format an amount for humans: fmt(1600) -> "₹1,600". Non-numbers print as-is. */
function fmt(n) {
  const v = Number(n);
  return Number.isFinite(v) ? `${SYMBOL}${_nf.format(v)}` : `${SYMBOL}${n}`;
}

module.exports = { SYMBOL, CODE, WALLET_TX_LIMIT, WALLET_DAILY_LIMIT, fmt };
