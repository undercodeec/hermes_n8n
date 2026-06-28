import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { WebhookModule } from './webhook/webhook.module';
import { MetaModule } from './meta/meta.module';
import { HermesModule } from './hermes/hermes.module';
import { ContactsModule } from './contacts/contacts.module';
import { LeadsModule } from './leads/leads.module';
import { ConversationsModule } from './conversations/conversations.module';
import { MessagesModule } from './messages/messages.module';
import { ProductsModule } from './products/products.module';
import { PriceListsModule } from './price-lists/price-lists.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { PlaybooksModule } from './playbooks/playbooks.module';
import { HandoffModule } from './handoff/handoff.module';
import { TasksModule } from './tasks/tasks.module';
import { CampaignsModule } from './campaigns/campaigns.module';
import { AnalyticsModule } from './analytics/analytics.module';

@Module({
  imports: [
    // Configuración global desde .env
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
    }),

    // Base de datos
    PrismaModule,

    // Autenticación
    AuthModule,

    // Integración con Meta WhatsApp Cloud API
    WebhookModule,
    MetaModule,

    // Integración con Hermes Agent
    HermesModule,

    // Módulos de negocio
    ContactsModule,
    LeadsModule,
    ConversationsModule,
    MessagesModule,
    ProductsModule,
    PriceListsModule,
    KnowledgeModule,
    PlaybooksModule,
    HandoffModule,
    TasksModule,
    CampaignsModule,

    // Analytics y métricas
    AnalyticsModule,
  ],
})
export class AppModule {}
