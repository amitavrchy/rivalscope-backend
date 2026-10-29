import { UsageAnalytics,UsageController } from './usage-analytics.js';
import { AlertService, AlertRulesController } from './alert-rules.js';
import { Module } from '@nestjs/common';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { DatabaseModule } from './database.js';
import { SessionGuard, TenantPolicy } from './security.js';
import { AuthController, AuthService } from './auth.js';
import { MailService } from './mail.js';
import { OrganizationsController } from './organizations.js';
import { ProjectsController } from './projects.js';
import { CreditsService } from './credits.js';
import { AiService, SearchService } from './providers.js';
import { ResearchController, ResearchService } from './research.js';
import { ReportsController } from './reports.js';
import { CopilotController } from './copilot.js';
import { MonitoringController, MonitoringService } from './monitoring.js';
import { BillingController, BillingPublicController, BillingService } from './billing.js';
import { IntegrationsController, PublicApiController, WebhookService } from './integrations.js';
import { AdminController } from './admin.js';
import { AccountController, AccountSecurityService } from './account-security.js';
import { GoogleAuthController, GoogleAuthService } from './google-auth.js';
import { PrivacyController } from './privacy.js';
import { CollaborationController, SharedReportsController } from './collaboration.js';
import { RedisModule, RedisThrottleStorage } from './redis-store.js';
import { OperationPolicy, PublicSettingsController } from './operations.js';
import { EmbeddingService } from './embeddings.js';
import { NotificationService, NotificationSettingsController } from './notifications.js';
import { MockBillingAdapter } from './mock-billing.js';
import { DiagnosticsController, MetricsService } from './observability.js';
import { IntelligenceService, IntelligenceController } from './intelligence.js';
import { SourceCollector } from './source-collector.js';

@Module({
  imports: [DatabaseModule, RedisModule, ThrottlerModule.forRootAsync({ imports: [RedisModule], inject: [RedisThrottleStorage], useFactory: (storage: RedisThrottleStorage) => ({ storage, throttlers: [{ ttl: 60000, limit: 120 }] }) })],
  controllers: [AppController, UsageController, AlertRulesController, AuthController, AccountController, GoogleAuthController, PrivacyController, CollaborationController, SharedReportsController, PublicSettingsController, NotificationSettingsController, DiagnosticsController, IntelligenceController, OrganizationsController, ProjectsController, ResearchController, ReportsController, CopilotController, MonitoringController, BillingController, BillingPublicController, IntegrationsController, PublicApiController, AdminController],
  providers: [AppService, UsageAnalytics, AlertService, SessionGuard, TenantPolicy, AuthService, AccountSecurityService, GoogleAuthService, OperationPolicy, EmbeddingService, NotificationService, MockBillingAdapter, MetricsService, IntelligenceService, SourceCollector, MailService, CreditsService, AiService, SearchService, ResearchService, MonitoringService, BillingService, WebhookService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
