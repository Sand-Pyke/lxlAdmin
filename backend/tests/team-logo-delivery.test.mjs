import assert from 'node:assert/strict';
import test from 'node:test';
import { sourceLoader } from './helpers/load-source.mjs';

const { createImageDelivery } = sourceLoader()('server/image-delivery.ts');

test('serves captain team logos from OSS only under team-logos', async () => {
  const name = 'm80_u20_671ea6f1-14e3-4044-850e-a000227ef4a7.jpg';
  const keys = [];
  const delivery = createImageDelivery({
    storage: () => ({
      head: async (key) => {
        keys.push(key);
        return { res: { headers: { etag: 'original' } } };
      },
    }),
    sign: (key) => 'https://example.test/' + key,
    publicUrl: () => null,
    objectKey: (kind, name) => kind + '/' + name,
    uploadRoot: () => '.',
    publicRoot: '.',
  });

  const response = await delivery.serve('team-logos', name);
  assert.equal(response.status, 307);
  assert.equal(response.headers.get('location'), 'https://example.test/team-logos/' + name);
  assert.equal((await delivery.serve('avatars', name)).status, 404);
  assert.equal((await delivery.serve('team-logos', 'm80_u20_bad.jpg')).status, 404);
  assert.equal((await delivery.serve('team-logos', '../' + name)).status, 404);
  assert.deepEqual(keys, ['team-logos/' + name]);
});
