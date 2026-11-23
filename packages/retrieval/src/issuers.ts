import { and, eq, isNotNull } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { exchangeListings, figiMappings, leiIsins, secListings, securityIssuers } from '@open-foresight/db';

/**
 * Issuers whose filings count as evidence for a security: SEC filers through the listing to security link,
 * and ESEF issuers through GLEIF ISINs matched to the security's resolved listings.
 * A security with several share classes shares its issuer's filings. Links made by hand in `security_issuers` are added.
 */
export async function issuerKeysForSecurity(db: PostgresJsDatabase, securityId: string): Promise<string[]> {
  const ciks = await db.selectDistinct({ cik: secListings.cik }).from(secListings).innerJoin(figiMappings, eq(figiMappings.listingId, secListings.id)).where(eq(figiMappings.securityId, securityId));
  const leis = await db.selectDistinct({ lei: leiIsins.lei }).from(leiIsins).innerJoin(exchangeListings, eq(exchangeListings.isin, leiIsins.isin)).where(eq(exchangeListings.securityId, securityId));
  const linked = await db.select({ key: securityIssuers.issuerKey }).from(securityIssuers).where(eq(securityIssuers.securityId, securityId));
  return [...new Set([...ciks.map(c => `cik:${c.cik}`), ...leis.map(l => `lei:${l.lei}`), ...linked.map(l => l.key)])].sort();
}

/**
 * Links each aliased listing's security to its issuer in `security_issuers`. Safe to repeat.
 * A symbol with no resolved security in the store is reported, not linked, because there is nothing to attach the issuer to.
 */
export async function linkIssuerAliases(db: PostgresJsDatabase, aliases: ReadonlyArray<{ symbol: string; issuerKey: string; note: string }>): Promise<{ linked: number; missing: string[] }> {
  let linked = 0;
  const missing: string[] = [];
  for (const a of aliases) {
    const [row] = await db.select({ securityId: exchangeListings.securityId }).from(exchangeListings).where(and(eq(exchangeListings.symbol, a.symbol), isNotNull(exchangeListings.securityId))).limit(1);
    if (!row?.securityId) { missing.push(a.symbol); continue; }
    const added = await db.insert(securityIssuers).values({ securityId: row.securityId, issuerKey: a.issuerKey, note: a.note }).onConflictDoNothing().returning({ key: securityIssuers.issuerKey });
    linked += added.length;
  }
  return { linked, missing };
}
