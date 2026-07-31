import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCart, addItem, total } from '../src/cart.js';

test('a new cart is empty', () => {
  assert.deepEqual(createCart().items, []);
  assert.equal(total(createCart()), 0);
});

test('addItem adds a line', () => {
  const cart = addItem(createCart(), { sku: 'ABC', price: 10 });
  assert.equal(cart.items.length, 1);
  assert.deepEqual(cart.items[0], { sku: 'ABC', price: 10, qty: 1 });
});

test('addItem merges quantities for the same sku', () => {
  let cart = createCart();
  cart = addItem(cart, { sku: 'ABC', price: 10, qty: 2 });
  cart = addItem(cart, { sku: 'ABC', price: 10, qty: 3 });
  assert.equal(cart.items.length, 1);
  assert.equal(cart.items[0].qty, 5);
});

test('total multiplies price by quantity', () => {
  let cart = createCart();
  cart = addItem(cart, { sku: 'ABC', price: 10, qty: 2 });
  cart = addItem(cart, { sku: 'XYZ', price: 2.5, qty: 4 });
  assert.equal(total(cart), 30);
});

test('addItem rejects bad input', () => {
  assert.throws(() => addItem(createCart(), { sku: '', price: 1 }), TypeError);
  assert.throws(() => addItem(createCart(), { sku: 'A', price: 'free' }), TypeError);
});
