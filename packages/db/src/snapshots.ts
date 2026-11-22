import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { dataSnapshots, secFacts, secFilings, snapshotFacts, snapshotFilings } from './schema.js';

const isoDate = /^\d{4}-\d{2}-\d{2}$/;
function checkAsOf(asOf: string): void {
  if (!isoDate.test(asOf) || Number.isNaN(Date.parse(`${asOf}T00:00:00Z`)) || new Date(`${asOf}T00:00:00Z`).toISOString().slice(0, 10) !== asOf) {
    throw new Error('asOf must be a valid YYYY-MM-DD date');
  }
}

/**
 * Freezes the filings and facts ingested at or before `ingestedCutoff` (default now).
 * Records ingested later, including late arrivals with old filing dates, are not members.
 */
export async function createSnapshot(input: { db: PostgresJsDatabase; ingestedCutoff?: Date }): Promise<{ id: string; filings: number; facts: number }> {
  const cutoff = input.ingestedCutoff ?? new Date();
  if (Number.isNaN(cutoff.getTime()) || cutoff.getTime() > Date.now()) throw new Error('Snapshot cutoff must be a valid time not in the future');
  return input.db.transaction(async tx => {
    const [snapshot] = await tx.insert(dataSnapshots).values({ ingestedCutoff: cutoff }).returning({ id: dataSnapshots.id });
    if (!snapshot) throw new Error('Snapshot was not saved');
    const filings = await tx.insert(snapshotFilings)
      .select(tx.select({ snapshotId: sql<string>`${snapshot.id}::uuid`.as('snapshot_id'), filingId: secFilings.id }).from(secFilings).where(lte(secFilings.ingestedAt, cutoff)))
      .returning({ id: snapshotFilings.filingId });
    const facts = await tx.insert(snapshotFacts)
      .select(tx.select({ snapshotId: sql<string>`${snapshot.id}::uuid`.as('snapshot_id'), factId: secFacts.id }).from(secFacts).where(lte(secFacts.ingestedAt, cutoff)))
      .returning({ id: snapshotFacts.factId });
    return { id: snapshot.id, filings: filings.length, facts: facts.length };
  });
}

/** Snapshot filings filed on or before `asOf`, oldest first. */
export async function filingsAsOf(input: { db: PostgresJsDatabase; snapshotId: string; asOf: string; cik?: string }) {
  checkAsOf(input.asOf);
  return input.db.select({ id: secFilings.id, cik: secFilings.cik, accession: secFilings.accession, form: secFilings.form, filedAt: secFilings.filedAt, documentSourceId: secFilings.documentSourceId })
    .from(snapshotFilings).innerJoin(secFilings, eq(secFilings.id, snapshotFilings.filingId))
    .where(and(eq(snapshotFilings.snapshotId, input.snapshotId), lte(secFilings.filedAt, input.asOf), input.cik ? eq(secFilings.cik, input.cik) : undefined))
    .orderBy(asc(secFilings.filedAt), asc(secFilings.accession));
}

/**
 * For each cik, concept, unit and period, the snapshot fact most recently filed on or before `asOf`.
 * A restatement filed after `asOf` is invisible; one filed before it supersedes the original.
 */
export async function factsAsOf(input: { db: PostgresJsDatabase; snapshotId: string; asOf: string; cik?: string }) {
  checkAsOf(input.asOf);
  return input.db.selectDistinctOn(
    [secFacts.cik, secFacts.taxonomy, secFacts.concept, secFacts.unit, secFacts.periodStart, secFacts.periodEnd],
    { id: secFacts.id, cik: secFacts.cik, taxonomy: secFacts.taxonomy, concept: secFacts.concept, unit: secFacts.unit, value: secFacts.value, periodStart: secFacts.periodStart, periodEnd: secFacts.periodEnd, filedAt: secFacts.filedAt, accession: secFacts.accession, sourceId: secFacts.sourceId, sourcePointer: secFacts.sourcePointer },
  ).from(snapshotFacts).innerJoin(secFacts, eq(secFacts.id, snapshotFacts.factId))
    .where(and(eq(snapshotFacts.snapshotId, input.snapshotId), lte(secFacts.filedAt, input.asOf), input.cik ? eq(secFacts.cik, input.cik) : undefined))
    .orderBy(secFacts.cik, secFacts.taxonomy, secFacts.concept, secFacts.unit, secFacts.periodStart, secFacts.periodEnd, sql`${secFacts.filedAt} desc`, sql`${secFacts.accession} desc`, sql`${secFacts.id} desc`);
}
