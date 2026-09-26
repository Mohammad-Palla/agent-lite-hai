'use strict';
/**
 * The shop's catalog, in Indian rupees. One source of truth: the storefront serves it and the scripted agents
 * read it, so what an agent buys always matches what the shop sells. (The storefront mutates `stock` in its own process.)
 */

const INVENTORY = {
  '1001': { id: '1001', name: 'Concert Ticket x2', price: 3000, stock: 50 },
  '1002': { id: '1002', name: 'Limited Sneaker (Pair)', price: 7000, stock: 10 },
  '1003': { id: '1003', name: 'Gaming GPU RTX 9080', price: 31000, stock: 5 },
  '1004': { id: '1004', name: 'Premium Package', price: 100000, stock: 2 },
  '1005': { id: '1005', name: 'Office Chair Pro', price: 2400, stock: 100 },
  '1006': { id: '1006', name: 'Mechanical Keyboard', price: 1600, stock: 200 },
};

module.exports = { INVENTORY };
