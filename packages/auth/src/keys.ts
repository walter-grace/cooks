import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { desc, isNull } from 'drizzle-orm';
import { exportJWK, generateKeyPair, importJWK, type JWK, type SignJWT } from 'jose';

export type SigningKeyLike = Parameters<SignJWT['sign']>[0];
import { signingKeys, type DbOrTx } from '@cooks/db';

function enc(plain: string, kek: string | undefined): string {
  if (!kek) return `plain:${plain}`;
  const key = Buffer.from(kek, 'base64');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}
function dec(blob: string, kek: string | undefined): string {
  if (blob.startsWith('plain:')) return blob.slice(6);
  if (!kek) throw new Error('Signing key is encrypted but COOKS_KEK is not set');
  const key = Buffer.from(kek, 'base64');
  const buf = Buffer.from(blob, 'base64url');
  const d = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

export interface ActiveKey {
  kid: string;
  alg: 'ES256';
  privateKey: SigningKeyLike;
  publicJwk: JWK;
}

/** Load the newest active ES256 key, generating one on first boot. */
export async function ensureSigningKey(db: DbOrTx, kek: string | undefined): Promise<ActiveKey> {
  const [row] = await db.select().from(signingKeys).where(isNull(signingKeys.retiredAt)).orderBy(desc(signingKeys.createdAt)).limit(1);
  if (row) {
    const priv = JSON.parse(dec(row.privateJwkEncrypted, kek)) as JWK;
    return { kid: row.kid, alg: 'ES256', privateKey: (await importJWK(priv, 'ES256')) as SigningKeyLike, publicJwk: row.publicJwk as JWK };
  }
  const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true });
  const kid = randomBytes(8).toString('hex');
  const pub = { ...(await exportJWK(publicKey)), kid, alg: 'ES256', use: 'sig' };
  const priv = { ...(await exportJWK(privateKey)), kid };
  await db.insert(signingKeys).values({ kid, alg: 'ES256', publicJwk: pub, privateJwkEncrypted: enc(JSON.stringify(priv), kek) });
  return { kid, alg: 'ES256', privateKey, publicJwk: pub };
}

export async function publicJwks(db: DbOrTx): Promise<{ keys: JWK[] }> {
  const rows = await db.select().from(signingKeys).where(isNull(signingKeys.retiredAt));
  return { keys: rows.map((r) => r.publicJwk as JWK) };
}
