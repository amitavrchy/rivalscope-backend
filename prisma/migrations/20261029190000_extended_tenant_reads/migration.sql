-- Read-only tenant role can query new domain tables without relying on caller filters.
DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['Feature','CompetitorFeature','PricingPlan','PricingHistory','SwotItem','MarketOpportunity','Comparison','Invoice','CreditPurchase','ReportExport','ApiUsage','ProviderUsage','SourceSnapshot','NotificationPreference','NotificationRead','NotificationDelivery','BillingCheckout']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = table_name AND policyname = 'tenant_reader_scope') THEN
      EXECUTE format('CREATE POLICY tenant_reader_scope ON %I FOR SELECT TO rivalscope_tenant_reader USING ("organizationId" = NULLIF(current_setting(''app.organization_id'', true), '''')::uuid)', table_name);
    END IF;
    EXECUTE format('GRANT SELECT ON %I TO rivalscope_tenant_reader', table_name);
  END LOOP;
END $$;
