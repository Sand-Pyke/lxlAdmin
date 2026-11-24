import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shopFormValues,
  shopPayload,
  validateShopImage,
  MAX_IMAGE_BYTES,
} from '../src/api/shop.ts';
import { rechargeBody } from '../src/api/recharge.ts';

test('editing a functional card preserves its category and backend-only effect fields', () => {
  const card = {
    id: 3,
    category: 'ITEM_CARD',
    name: '免 ban 卡',
    price: 300,
    stock: 0,
    enabled: false,
    durationDays: null,
    icon: '',
    effectType: 'HERO_PROTECTION_CARD',
    effectJson: '{}',
    code: 'hero-card',
    groupCode: 'original-group',
    eligibleMinUserId: null,
    eligibleMaxUserId: null,
  };
  const form = shopFormValues(card);
  const body = shopPayload({ ...form, category: 'TITLE', name: '改名道具', price: 400 }, card);
  assert.equal(body.stock, 0);
  assert.equal(body.enabled, false);
  assert.equal(body.price, 400);
  for (const key of ['category', 'code', 'effectType', 'effectJson', 'groupCode', 'effectValue'])
    assert.equal(Object.hasOwn(body, key), false);
});

test('shop validates free claims, custom images and nullable duration/stock', () => {
  const values = {
    ...shopFormValues(),
    category: 'NAMEPLATE',
    name: '限定铭牌',
    price: 0,
    effectValue: 'custom',
    icon: '/assets/shop-icons/upload.png',
  };
  assert.throws(() => shopPayload(values), /免费商品/);
  const body = shopPayload({ ...values, eligibleMaxUserId: 100 });
  assert.equal(body.eligibleMaxUserId, 100);
  assert.equal(body.durationDays, null);
  assert.equal(body.effectValue, 'custom');
  assert.equal(Object.hasOwn(body, 'stock'), false);
  assert.throws(
    () => shopPayload({ ...values, eligibleMinUserId: 101, eligibleMaxUserId: 100 }),
    /不能大于/,
  );
  assert.throws(() => shopPayload({ ...values, eligibleMaxUserId: 100, icon: '' }), /先上传/);
  assert.throws(() => shopPayload({ ...values, price: 1.5 }), /整数/);
  assert.throws(() => shopPayload({ ...values, price: 1, durationDays: 0 }), /有效期/);
});

test('legacy decorative effects survive editing and built-in presets need no upload', () => {
  const background = {
    category: 'BACKGROUND',
    name: '背景',
    price: 10,
    icon: '✨',
    effectJson: '{"type":"background","value":"/assets/shop-icons/old.webp"}',
    durationDays: null,
    stock: null,
    enabled: true,
    eligibleMinUserId: null,
    eligibleMaxUserId: null,
  };
  assert.equal(
    shopPayload(shopFormValues(background), background).icon,
    '/assets/shop-icons/old.webp',
  );
  assert.equal(
    shopPayload({ ...shopFormValues(), name: '经典金框', price: 10 }).avatarFrameStyle,
    'gold',
  );
  const dynamic = { ...background, effectJson: '{"type":"background","value":"fx:meteor"}' };
  assert.equal(shopPayload(shopFormValues(dynamic), dynamic).dynamicBg, 'meteor');
});

test('upload limits and recharge amounts reject invalid input before submitting', () => {
  validateShopImage({ name: 'icon.svg', size: MAX_IMAGE_BYTES });
  assert.throws(() => validateShopImage({ name: 'file.exe', size: 10 }), /仅支持/);
  assert.throws(() => validateShopImage({ name: 'big.png', size: MAX_IMAGE_BYTES + 1 }), /5MB/);
  assert.deepEqual(rechargeBody(8, 200, ' 活动奖励 '), {
    userId: 8,
    amount: 200,
    note: '活动奖励',
  });
  for (const amount of [0, -1, 1.5, null, 2_147_483_648])
    assert.throws(() => rechargeBody(8, amount), /正整数/);
  assert.throws(() => rechargeBody(undefined, 100), /选择充值用户/);
});
