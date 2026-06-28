import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const configService = app.get(ConfigService);

  // Global pipes
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Global filters & interceptors
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  // CORS
  app.enableCors({
    origin: '*', // En producción, restringir a dominios específicos
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  // Swagger / OpenAPI
  const swaggerConfig = new DocumentBuilder()
    .setTitle('Hermes Backend API')
    .setDescription(
      'API del backend comercial para Hermes Agent - CRM conversacional por WhatsApp',
    )
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('Auth', 'Autenticación y gestión de usuarios')
    .addTag('Webhook', 'Webhook de Meta WhatsApp Cloud API')
    .addTag('Contacts', 'Gestión de contactos')
    .addTag('Leads', 'Gestión de leads y funnel de ventas')
    .addTag('Conversations', 'Conversaciones y estados')
    .addTag('Messages', 'Historial de mensajes')
    .addTag('Products', 'Catálogo de productos')
    .addTag('Price Lists', 'Listas de precios')
    .addTag('Knowledge', 'Base de conocimiento')
    .addTag('Playbooks', 'Guiones de ventas')
    .addTag('Handoff', 'Escalamiento a humanos')
    .addTag('Tasks', 'Tareas y seguimiento')
    .addTag('Campaigns', 'Fuentes de campaña y ads')
    .addTag('Analytics', 'KPIs y métricas')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = configService.get<number>('PORT', 3000);
  await app.listen(port);

  console.log(`
╔══════════════════════════════════════════════════╗
║          HERMES BACKEND - RUNNING                ║
╠══════════════════════════════════════════════════╣
║  Server:    http://localhost:${port}               ║
║  Swagger:   http://localhost:${port}/api/docs       ║
║  Env:       ${configService.get('NODE_ENV', 'development').padEnd(37)}║
╚══════════════════════════════════════════════════╝
  `);
}
bootstrap();
