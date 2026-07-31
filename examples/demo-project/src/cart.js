/**
 * A deliberately small shopping cart, used as the nightshift demo project.
 *
 * It is intentionally incomplete — the tasks in NIGHT_PLAN.md fill in the gaps.
 */

export function createCart() {
  return { items: [] };
}

export function addItem(cart, { sku, price, qty = 1 }) {
  if (typeof sku !== 'string' || sku === '') {
    throw new TypeError('sku must be a non-empty string');
  }
  if (typeof price !== 'number' || Number.isNaN(price)) {
    throw new TypeError('price must be a number');
  }

  const existing = cart.items.find((i) => i.sku === sku);
  if (existing) {
    existing.qty += qty;
    return cart;
  }

  cart.items.push({ sku, price, qty });
  return cart;
}

export function total(cart) {
  return cart.items.reduce((sum, i) => sum + i.price * i.qty, 0);
}
