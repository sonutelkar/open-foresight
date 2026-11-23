ALTER TABLE "document_chunks" DROP CONSTRAINT "document_chunks_doc_kind";--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_doc_kind" CHECK ("doc_kind" IN ('sec_filing', 'esef_filing', 'web_report', 'company_profile'));
