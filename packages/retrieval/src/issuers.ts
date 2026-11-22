import { eq } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { exchangeListings, figiMappings, leiIsins, secListings } from '@open-foresight/db';

/**
 * Issuers whose filings count as evidence for a security: SEC filers through the listing to security link,
 * and ESEF issuers through GLEIF ISINs matched to the security's resolved listings.
 * A security with several share classes shares its issuer's filings.
 */
export async function issuerKeysForSecurity(db: PostgresJsDatabase, securityId: string): Promise<string[]> {
  const ciks = await db.selectDistinct({ cik: secListings.cik }).from(secListings).innerJoin(figiMappings, eq(figiMappings.listingId, secListings.id)).where(eq(figiMappings.securityId, securityId));
  const leis = await db.selectDistinct({ lei: leiIsins.lei }).from(leiIsins).innerJoin(exchangeListings, eq(exchangeListings.isin, leiIsins.isin)).where(eq(exchangeListings.securityId, securityId));
  return [...ciks.map(c => `cik:${c.cik}`), ...leis.map(l => `lei:${l.lei}`)].sort();
}
