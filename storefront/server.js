'use strict';
/**
 * Fake Storefront — synthetic inventory, no real payment processor.
 * Runs on two ports:
 *   :3003  Real storefront (state is authoritative)
 *   :3004  Sandbox clone (quarantined agents land here — actions have NO effect on real state)
 *
 * Routes: GET /search, GET /product/:id, POST /cart, POST /checkout
 */

const express = require('express');
const cors = require('cors');

const REAL_PORT = 3003;
const SANDBOX_PORT = 3004;

// Synthetic inventory (authoritative)
const INVENTORY = {
  '1001': { id: '1001', name: 'Concert Ticket x2', price: 120, stock: 50 },
  '1002': { id: '1002', name: 'Limited Sneaker (Pair)', price: 280, stock: 10 },
  '1003': { id: '1003', name: 'Gaming GPU RTX 9080', price: 1240, stock: 5 },
  '1004': { id: '1004', name: 'Premium Package', price: 4000, stock: 2 },
  '1005': { id: '1005', name: 'Office Chair Pro', price: 95, stock: 100 },
  '1006': { id: '1006', name: 'Mechanical Keyboard', price: 65, stock: 200 },
};

// Order log (authoritative) — checked for idempotency
const ORDERS = new Map();
let _orderSeq = 1;

function createStorefront(mode /* 'real' | 'sandbox' */) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10kb' }));

  // Sandbox marker header
  if (mode === 'sandbox') {
    app.use((req, res, next) => {
      res.setHeader('X-Storefront-Mode', 'SANDBOX');
      next();
    });
  }

  // GET /search?q=...
  app.get('/search', (req, res) => {
    const q = (req.query.q || '').toLowerCase();
    const results = Object.values(INVENTORY).filter(p =>
      !q || p.name.toLowerCase().includes(q)
    );
    res.json({ results, sandbox: mode === 'sandbox' });
  });

  // GET /product/:id
  app.get('/product/:id', (req, res) => {
    const product = INVENTORY[req.params.id];
    if (!product) return res.status(404).json({ error: 'not_found' });
    res.json({ product, sandbox: mode === 'sandbox' });
  });

  // POST /cart — add to cart (no real state needed for demo)
  app.post('/cart', (req, res) => {
    const { productId, qty } = req.body || {};
    if (!productId || !INVENTORY[productId]) {
      return res.status(400).json({ error: 'invalid_product' });
    }
    res.json({
      cartItem: { productId, qty: qty || 1, price: INVENTORY[productId].price },
      sandbox: mode === 'sandbox',
    });
  });

  // POST /checkout
  app.post('/checkout', (req, res) => {
    const { productId, qty, amount, item, sessionId } = req.body || {};

    if (mode === 'sandbox') {
      // Sandbox: return synthetic success, do NOT touch real orders
      return res.json({
        status: 'sandbox_success',
        orderId: `SANDBOX-${Date.now()}`,
        message: 'Order recorded in sandbox — no real state changed',
        sandbox: true,
      });
    }

    // Real checkout: basic validation
    if (!amount || typeof amount !== 'number' || amount <= 0) {
      return res.status(400).json({ error: 'invalid_amount' });
    }

    // Check stock
    const product = INVENTORY[productId];
    if (product && product.stock <= 0) {
      return res.status(409).json({ error: 'out_of_stock' });
    }

    // Idempotency: same sessionId + productId + amount = same order
    const idempotencyKey = `${req.headers['x-session-id']}:${productId}:${amount}`;
    if (ORDERS.has(idempotencyKey)) {
      const existing = ORDERS.get(idempotencyKey);
      return res.json({ ...existing, idempotent: true });
    }

    // Decrement stock
    if (product) product.stock = Math.max(0, product.stock - (qty || 1));

    const orderId = `ORD-${Date.now()}-${_orderSeq++}`;
    const order = { status: 'success', orderId, amount, item: item || product?.name, sandbox: false };
    ORDERS.set(idempotencyKey, order);

    res.json(order);
  });

  return app;
}

// Boot both storefronts
const realApp = createStorefront('real');
const sandboxApp = createStorefront('sandbox');

realApp.listen(REAL_PORT, () => {
  console.log(`[Storefront REAL]    listening on :${REAL_PORT}`);
});

sandboxApp.listen(SANDBOX_PORT, () => {
  console.log(`[Storefront SANDBOX] listening on :${SANDBOX_PORT}`);
});
