import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { HttpExceptionFilter } from './common/filters/http-exception.filter';
import { LoggingInterceptor } from './common/interceptors/logging.interceptor';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new LoggingInterceptor());

  const configuredOrigins = config
    .get<string>('CORS_ORIGINS', '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (
    config.get<string>('NODE_ENV') === 'production' &&
    configuredOrigins.length === 0
  ) {
    throw new Error('CORS_ORIGINS es obligatorio en producción');
  }
  app.enableCors({
    origin:
      configuredOrigins.length > 0
        ? configuredOrigins
        : ['http://localhost:3000'],
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE',
    credentials: true,
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Hermes Backend API')
    .setDescription('API del CRM conversacional Hermes para WhatsApp Cloud API')
    .setVersion('1.1')
    .addBearerAuth()
    .addTag('Auth', 'Autenticación y gestión de usuarios')
    .addTag('Webhook', 'Webhook de Meta WhatsApp Cloud API')
    .addTag('Contacts', 'Gestión de contactos')
    .addTag('Leads', 'Gestión de leads y funnel de ventas')
    .addTag('Conversations', 'Conversaciones, mensajes y ventana de respuesta')
    .addTag('Messages', 'Historial de mensajes')
    .addTag('Products', 'Catálogo de productos')
    .addTag('Price Lists', 'Listas de precios')
    .addTag('Knowledge', 'Base de conocimiento')
    .addTag('Playbooks', 'Guiones de ventas')
    .addTag('Handoff', 'Escalamiento y control humano')
    .addTag('Tasks', 'Tareas y seguimiento')
    .addTag('Campaigns', 'Fuentes de campaña y ads')
    .addTag('Analytics', 'KPIs y métricas')
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api/docs', app, document);

  const port = config.get<number>('PORT', 3000);
  await app.listen(port);
  console.log(
    `Hermes Backend activo en http://localhost:${port} (Swagger: /api/docs)`,
  );
}

void bootstrap();
