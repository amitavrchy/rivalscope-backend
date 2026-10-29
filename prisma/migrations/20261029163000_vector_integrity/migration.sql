-- AddForeignKey
ALTER TABLE "EmbeddingRecord" ADD CONSTRAINT "EmbeddingRecord_organizationId_sourceId_fkey" FOREIGN KEY ("organizationId", "sourceId") REFERENCES "Source"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmbeddingRecord" ADD CONSTRAINT "EmbeddingRecord_organizationId_projectId_fkey" FOREIGN KEY ("organizationId", "projectId") REFERENCES "Project"("organizationId", "id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "embedding_vector_hnsw" ON "EmbeddingRecord" USING hnsw (vector vector_cosine_ops);
CREATE TRIGGER platform_audit_immutable BEFORE UPDATE OR DELETE ON "PlatformAuditLog"
  FOR EACH ROW EXECUTE FUNCTION reject_immutable_mutation();
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rivalscope_tenant_reader') THEN
    CREATE ROLE rivalscope_tenant_reader NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
GRANT rivalscope_tenant_reader TO CURRENT_USER;
GRANT USAGE ON SCHEMA public TO rivalscope_tenant_reader;
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['Project','ResearchRun','ResearchStage','Competitor','CompetitorProduct','PricingPlan','Source','Finding','FindingEvidence','Report','ChatThread','ChatMessage','Monitor','MonitorRun','ChangeEvent','Notification','Comment','CreditLedger','AuditLog','ProjectMember','Bookmark','ShareLink','EmbeddingRecord','ApiUsage'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('GRANT SELECT ON TABLE %I TO rivalscope_tenant_reader', table_name);
    EXECUTE format('CREATE POLICY tenant_read_scope ON %I FOR SELECT TO rivalscope_tenant_reader USING ("organizationId" = NULLIF(current_setting(''app.organization_id'',true),'''')::uuid)', table_name);
  END LOOP;
END $$;
