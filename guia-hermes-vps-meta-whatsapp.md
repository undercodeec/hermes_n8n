# Guía técnica: Hermes Agent en VPS + WhatsApp Cloud API de Meta + backend comercial

Esta guía documenta una arquitectura práctica para desplegar Hermes Agent en un VPS, conectarlo a la API oficial de WhatsApp Business Cloud de Meta y construir el backend necesario para usarlo como agente de ventas con memoria, contexto y reglas de negocio.[cite:66][cite:38][cite:72]

El objetivo no es solo “instalar Hermes”, sino dejar una base reutilizable para próximas sesiones: infraestructura persistente, canal de WhatsApp oficial, capa de conocimiento comercial y un backend que controle leads, catálogo, seguimiento y escalamiento a humanos.[cite:66][cite:38][cite:72]

## Objetivo de arquitectura

La arquitectura recomendada se divide en cinco capas: VPS, Hermes Agent, proveedor LLM, integración oficial con Meta WhatsApp Cloud API y backend de negocio.[cite:66][cite:38][cite:72]

Hermes actúa como motor agente y capa de orquestación; Meta entrega el canal oficial de WhatsApp; el backend comercial guarda clientes, reglas, productos, eventos y estados de conversación; y el modelo de IA genera respuestas bajo esas restricciones.[cite:38][cite:72]

## Qué sí hace Hermes

Hermes puede ejecutarse autoalojado, usar proveedores de modelos externos, levantar un gateway persistente y exponer un endpoint HTTP compatible con OpenAI para integrarse con frontends o servicios propios.[cite:66][cite:72][cite:75]

También puede operar con mensajería y automatización, mantener datos persistentes y ejecutar herramientas o skills, lo que lo hace adecuado como núcleo de un agente comercial si se complementa con un backend transaccional propio.[cite:66][cite:73]

## Qué no conviene delegar solo a Hermes

Hermes no debe ser el único lugar donde viva la lógica del negocio, porque un sistema comercial serio necesita trazabilidad, auditoría, permisos, historial de leads, control de estados, reportes y reglas de escalamiento.[cite:72][cite:73]

Por eso, para ventas reales, Hermes debe conectarse a un backend propio que concentre los datos estructurados y exponga APIs claras para consultar productos, registrar leads, crear tareas, marcar oportunidades y derivar conversaciones a un humano.[cite:40][cite:72]

## Requisitos previos

Antes de empezar, se necesita un VPS Linux con acceso root o sudo, preferiblemente Ubuntu reciente; Docker o instalación nativa de Hermes; un proveedor LLM compatible; una cuenta de Meta Business; una app en Meta for Developers con WhatsApp habilitado; y un número dedicado para WhatsApp Business Cloud API.[cite:66][cite:68][cite:38]

También conviene contar con un dominio o, al menos, un túnel público estable para exponer el webhook de Meta. En el flujo público explicado para WhatsApp Cloud, se recomienda Cloudflare Tunnel como opción gratuita para publicar el callback sin abrir puertos manualmente.[cite:38]

## Diseño recomendado del VPS

Para un primer despliegue, un VPS pequeño puede ser suficiente si Hermes consume el modelo por API externa en lugar de correr inferencia local.[cite:66][cite:69]

La distribución mínima recomendable es esta:

- Sistema base: Ubuntu 24.04 LTS o similar.[cite:71]
- Contenedores: Docker Engine y Docker Compose plugin.[cite:66]
- Persistencia: volumen o carpeta para `~/.hermes`.[cite:66][cite:69]
- Proxy/TLS: Traefik, Nginx o túnel de Cloudflare para exponer el webhook y servicios auxiliares.[cite:68][cite:38]
- Backend comercial: Node.js o Java/Spring, con PostgreSQL para datos transaccionales.
- Observabilidad: logs, reinicio automático y health checks.[cite:66]

## Paso 1: preparar el servidor

Instala Docker Engine desde el repositorio oficial, verifica la instalación y agrega tu usuario al grupo `docker` para operar sin `sudo` en cada comando.[cite:66]

La guía pública de instalación de Hermes en VPS también muestra la ruta nativa por script, donde el instalador oficial descarga y configura el binario con un único comando.[cite:66][cite:71]

### Comandos base sugeridos

```bash
sudo apt update && sudo apt upgrade -y
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
newgrp docker

docker --version
```

Si prefieres la instalación nativa de Hermes en vez de Docker, la referencia pública usa este comando:[cite:66][cite:71]

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
source ~/.bashrc
hermes --version
```

## Paso 2: desplegar Hermes Agent

Hay dos formas razonables de despliegue: nativa o contenedorizada. Para producción ligera y mantenimiento más limpio, conviene Docker con volumen persistente para el directorio de Hermes.[cite:66][cite:69]

Una referencia pública muestra un contenedor con nombre `hermes-agent`, política de reinicio `unless-stopped` y un volumen persistente para guardar el perfil del agente.[cite:66]

### Ejemplo con Docker

```bash
mkdir -p ~/.hermes

docker run -d \
  --name hermes-agent \
  --restart unless-stopped \
  -v ~/.hermes:/home/hermes/.hermes \
  -e HERMES_PROFILE=default \
  nousresearch/hermes-agent:latest
```

Tras el despliegue, ejecuta la configuración inicial del agente con el wizard oficial y luego valida el estado con herramientas de diagnóstico.[cite:66]

```bash
hermes setup
hermes doctor
hermes --version
```

## Paso 3: configurar proveedor de IA

Hermes no trae el modelo como tal; debes conectarlo a un proveedor compatible. La documentación pública sobre custom providers indica que Hermes acepta endpoints compatibles con OpenAI y que se debe registrar la base URL terminada en `/v1`, más la API key del proveedor.[cite:75]

También existe una función de servidor API que expone Hermes como endpoint OpenAI-compatible, lo que sirve para integrar paneles propios, Open WebUI u otros servicios internos.[cite:72][cite:70]

### Criterio práctico para proveedor LLM

Para ventas por WhatsApp se recomienda un modelo que tenga:

- Buen seguimiento de instrucciones.
- Bajo costo por token.
- Respuesta rápida.
- Buen desempeño en español.
- Soporte estable para contexto largo.

Para el despliegue inicial, conviene elegir un proveedor OpenAI-compatible barato y después medir costo por conversación antes de escalar.[cite:75]

## Paso 4: levantar Hermes como servicio persistente

Si usas Docker, la política `unless-stopped` mantiene el servicio activo tras reinicios del sistema.[cite:66]

Si usas instalación nativa, una referencia pública propone crear un servicio `systemd` cuyo `ExecStart` ejecute `hermes gateway` y se reinicie automáticamente al fallar.[cite:66]

### Ejemplo de systemd

```ini
[Unit]
Description=Hermes Agent
After=network-online.target

[Service]
Type=simple
User=hermes
WorkingDirectory=/home/hermes
ExecStart=/home/hermes/.local/bin/hermes gateway
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Luego:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hermes
sudo systemctl status hermes
```

## Paso 5: preparar Meta Business y WhatsApp Cloud API

Para usar la integración oficial de WhatsApp Cloud, hace falta una cuenta de Meta Business, una aplicación creada en developers.facebook.com y el caso de uso orientado a conectar clientes por WhatsApp.[cite:38]

En el proceso público explicado para Hermes + WhatsApp Cloud, se recopilan como mínimo el `phone number id`, el access token y el app secret, y para producción se recomienda crear un system user con permisos adecuados y generar un token permanente.[cite:38]

### Credenciales mínimas a reunir

- Meta Business Account verificada.[cite:38]
- App de Meta con producto WhatsApp habilitado.[cite:38]
- WhatsApp Business Account vinculada.[cite:38]
- `Phone Number ID`.[cite:38]
- Access token; idealmente permanente para producción mediante system user.[cite:38]
- `App Secret`.[cite:38]
- Verify token para el webhook.[cite:38]

## Paso 6: publicar el webhook

Meta necesita llegar a una URL pública para enviar eventos de mensajes entrantes. En el flujo documentado públicamente, se recomienda Cloudflare Tunnel como alternativa gratuita para exponer el puerto local sin abrir puertos manualmente ni depender de una IP fija.[cite:38]

El callback configurado en Meta debe apuntar a la ruta de webhook de WhatsApp que Hermes o tu capa puente espere, y luego debes verificar el token y suscribirte al campo `messages` para recibir mensajes entrantes.[cite:38]

### Ejemplo conceptual con Cloudflare Tunnel

```bash
cloudflared tunnel --url http://localhost:8090
```

Después, en la configuración de Meta, usa una URL similar a:

```text
https://tu-subdominio.trycloudflare.com/whatsapp/webhook
```

Y registra el verify token generado por el asistente o definido por tu sistema.[cite:38]

## Paso 7: decidir la topología de integración

Hay dos topologías posibles para usar Hermes con WhatsApp Cloud API oficial.

### Opción A: Hermes recibe directamente el canal

Esta opción es la más simple si la integración Cloud de Hermes ya cubre tu caso de uso. El webhook de Meta entra a Hermes, Hermes procesa contexto y responde, y luego publica la respuesta por la API de Meta.[cite:38]

Es útil para una primera fase o un MVP, pero deja menos espacio para controles comerciales avanzados si la lógica del negocio crece mucho.[cite:38][cite:72]

### Opción B: backend propio como capa orquestadora

Esta es la opción más recomendable para una operación comercial real. Meta envía el webhook a tu backend; el backend valida, guarda el evento, normaliza el mensaje, consulta CRM o catálogo, y luego llama a Hermes para generar o enriquecer la respuesta antes de enviarla por la API de Meta.[cite:72][cite:40]

Esta topología permite auditoría, colas, reintentos, A/B testing, SLA, reasignación a agentes humanos, cumplimiento y un panel interno para ventas.[cite:40][cite:72]

## Paso 8: construir el backend comercial

El backend debe ser el núcleo de datos y reglas del sistema. Hermes debe funcionar como motor cognitivo, no como base de datos principal del negocio.[cite:72][cite:73]

Los módulos mínimos recomendados son:

- Autenticación interna para administradores y vendedores.
- Módulo de leads.
- Módulo de conversaciones.
- Módulo de catálogo y promociones.
- Módulo de embeddings o base documental para conocimiento comercial.
- Módulo de reglas y automatizaciones.
- Módulo de tareas, citas y seguimiento.
- Módulo de handoff a humano.
- Módulo de analytics y auditoría.

### Esquema mínimo de tablas

```text
contacts
leads
conversations
messages
products
price_lists
knowledge_documents
sales_playbooks
conversation_states
tasks
human_handoffs
campaign_sources
ads_metadata
```

### Endpoints API sugeridos

```text
POST   /webhooks/meta/whatsapp
POST   /api/leads
GET    /api/contacts/:id
POST   /api/conversations/:id/reply
POST   /api/hermes/respond
POST   /api/handoff
POST   /api/knowledge/documents
POST   /api/playbooks
GET    /api/analytics/funnel
```

## Paso 9: definir el “entrenamiento” comercial

Para este tipo de sistema, “entrenar” a Hermes no suele significar fine-tuning del modelo, sino darle contexto estructurado, memoria útil y reglas de respuesta.[cite:72][cite:75]

La mejor práctica es combinar cuatro capas:

1. Prompt del sistema o policy prompt.
2. Playbooks de venta y manejo de objeciones.
3. Base de conocimiento recuperable por búsqueda o embeddings.
4. Estado conversacional persistente por cliente o lead.

### Qué documentos preparar

- Catálogo de productos o servicios.
- Tabla de precios, promociones y restricciones.
- Preguntas frecuentes.
- Guiones de captación.
- Guiones de cierre.
- Objeciones comunes y respuestas válidas.
- Políticas comerciales, devoluciones, horarios y cobertura.
- Señales de riesgo o razones para escalar a humano.

### Qué datos debe recordar por contacto

- Nombre.
- Empresa y cargo, si aplica.
- Producto de interés.
- Presupuesto estimado.
- Etapa del funnel.
- Fuente del lead, por ejemplo campaña, anuncio o formulario.
- Última objeción detectada.
- Próxima acción comprometida.

## Paso 10: diseñar el prompt operativo del vendedor

El prompt de sistema debe limitar el comportamiento del agente y alinearlo al negocio. Debe incluir tono, objetivo, reglas de elegibilidad, pasos del funnel, criterios de derivación y restricciones para no inventar precios ni condiciones.

### Estructura sugerida del prompt

```text
Rol: asesor comercial por WhatsApp.
Objetivo: captar, calificar y avanzar leads a cita, pago o traspaso a humano.
Tono: claro, cordial, persuasivo y breve.
Reglas: no inventar datos; usar solo catálogo y políticas vigentes; si falta información, preguntar; si la conversación involucra reclamos sensibles, pagos fallidos o negociación especial, escalar a humano.
Datos disponibles: perfil del lead, historial, catálogo, promociones, FAQs y playbooks.
Salida esperada: respuesta breve, siguiente paso recomendado, etiquetas del lead y acción sugerida para CRM.
```

## Paso 11: flujo de respuesta recomendado

El flujo robusto para cada mensaje entrante debería ser este:

1. Meta envía evento al webhook.[cite:38]
2. El backend valida firma y origen del webhook.
3. El backend guarda el mensaje crudo y su metadata.
4. El backend identifica o crea el contacto.
5. El backend obtiene contexto: historial, etapa, productos, campaña y reglas.
6. El backend llama a Hermes con prompt, contexto y herramientas.
7. Hermes devuelve respuesta, etiquetas y acciones sugeridas.
8. El backend aplica reglas: aprobar, truncar, enriquecer o derivar.
9. El backend envía la respuesta por la API de Meta.
10. El backend registra resultado, latencia y costo.

Este diseño permite supervisión, métricas y rollback en caso de errores o alucinaciones del modelo.[cite:72][cite:40]

## Paso 12: integrar respuestas con la API oficial de Meta

La respuesta al usuario final debe salir por la API oficial de WhatsApp Cloud y no por mecanismos no oficiales si el objetivo es operación comercial estable.[cite:38]

Por ello, el backend debe encargarse de:

- Gestionar el token y su rotación.
- Enviar mensajes salientes al endpoint oficial de Meta.
- Controlar plantillas cuando el caso de uso lo exija.
- Manejar errores por rate limit o políticas del canal.
- Registrar los IDs de mensajes para trazabilidad.

## Paso 13: captación de leads desde campañas

Si el tráfico viene de campañas, conviene almacenar desde el primer evento información de origen para poder atribuir resultados comerciales a anuncio, conjunto, campaña o canal.[cite:62]

El backend puede guardar campos como estos:

- `utm_source`
- `utm_campaign`
- `ad_id`
- `adset_id`
- `campaign_id`
- `landing_page`
- `first_message_text`
- `entry_channel`

Eso vuelve posible medir costo por lead, tasa de respuesta, tasa de cita y tasa de cierre por campaña.[cite:62]

## Paso 14: handoff a humanos

Un agente de ventas útil no debe responder siempre; debe saber cuándo transferir. El backend debe permitir pausar la automatización y asignar la conversación a un vendedor humano cuando aparezcan señales específicas.

### Casos típicos de handoff

- Pedido de descuento especial.
- Reclamos o quejas sensibles.
- Necesidad de cotización compleja.
- Negociación B2B.
- Usuario molesto o frustrado.
- Mensajes repetidos sin avance.
- Errores de información detectados.

## Paso 15: panel de entrenamiento y mejora continua

En lugar de “reentrenar” el modelo a mano cada vez, conviene construir un pequeño backoffice donde el equipo comercial mantenga el conocimiento vigente.

### Funciones recomendadas del panel

- Cargar FAQs y documentos.
- Editar playbooks de ventas.
- Definir respuestas aprobadas por producto.
- Revisar conversaciones fallidas.
- Etiquetar objeciones nuevas.
- Aprobar o rechazar respuestas generadas.
- Crear snippets o skills reutilizables.
- Medir conversiones por prompt o estrategia.

Este panel convierte la operación en un sistema iterativo y evita tocar código para cada mejora comercial.[cite:72][cite:73]

## Paso 16: memoria y contexto para futuras sesiones

Si el objetivo es generar contexto para próximas sesiones, la información crítica debe persistirse fuera de la memoria volátil del modelo. Hermes puede guardar memoria operativa, pero el negocio necesita persistencia fuerte en base de datos y almacenamiento documental.[cite:66][cite:72]

Lo más recomendable es persistir tres niveles de contexto:

- Contexto del contacto: identidad, etapa del embudo, necesidades y última acción.
- Contexto documental: catálogo, políticas, promociones y FAQs versionadas.
- Contexto conversacional: historial resumido, mensajes relevantes, objeciones y resolución.

### Resumen operativo por conversación

Después de cada sesión, genera y guarda automáticamente:

- Resumen corto de la conversación.
- Intención detectada.
- Estado del lead.
- Próxima acción sugerida.
- Riesgos detectados.
- Etiquetas comerciales.
- Puntaje de probabilidad de cierre, si decides implementarlo.

Ese resumen sirve para reinyectar contexto a Hermes en la siguiente interacción sin tener que mandar el historial completo siempre.

## Paso 17: seguridad y cumplimiento

Un sistema comercial por WhatsApp requiere controles de seguridad básicos desde el inicio.

### Recomendaciones mínimas

- Guardar secretos en variables de entorno o secret manager, no en código.
- Restringir acceso al panel interno por roles.
- Cifrar backups y base de datos en reposo si manejas información sensible.
- Validar firmas del webhook de Meta.
- Registrar auditoría de cambios en prompts, precios y playbooks.
- Mantener listas de exclusión y consentimiento según tu política de comunicación.

## Paso 18: monitoreo y métricas

La operación debe medirse por costo, calidad y conversión.

### KPIs iniciales

- Tiempo medio de primera respuesta.
- Porcentaje de conversaciones resueltas por IA.
- Tasa de handoff a humano.
- Costo promedio por conversación.
- Tasa de calificación de leads.
- Tasa de cita agendada.
- Tasa de cierre.
- Mensajes sin respuesta o fallidos.

## Paso 19: stack sugerido para tu perfil técnico

Por tu perfil técnico, una combinación razonable sería esta:

- VPS Ubuntu.
- Hermes Agent en Docker.[cite:66]
- Cloudflare Tunnel para el webhook público.[cite:38]
- Backend Node.js con Fastify o NestJS.
- PostgreSQL para contactos, leads y conversaciones.
- Redis opcional para colas o throttling.
- OpenAI-compatible provider económico conectado a Hermes.[cite:75]
- Panel React/Vite para backoffice.
- Integración con Meta WhatsApp Cloud API para mensajes oficiales.[cite:38]

## Paso 20: roadmap sugerido de implementación

### Fase 1: MVP técnico

- Crear VPS.
- Instalar Docker y Hermes.[cite:66]
- Configurar proveedor LLM.[cite:75]
- Configurar Meta Business y WhatsApp Cloud.[cite:38]
- Exponer webhook con Cloudflare Tunnel.[cite:38]
- Enviar y recibir mensajes en entorno de prueba.

### Fase 2: backend comercial

- Crear tablas de contactos, conversaciones y mensajes.
- Implementar endpoint del webhook de Meta.
- Integrar envío saliente por API oficial.
- Conectar backend con Hermes para generación de respuesta.
- Registrar costos, estados y trazas.

### Fase 3: entrenamiento comercial

- Cargar catálogo y FAQs.
- Crear playbooks de ventas.
- Añadir resumen por conversación.
- Activar reglas de handoff.
- Revisar respuestas con humanos en el loop.

### Fase 4: operación de campañas

- Añadir source tracking.
- Integrar campañas y anuncios.
- Medir tasa de respuesta por origen.
- Optimizar prompts y reglas según desempeño.

## Riesgos reales del proyecto

Los riesgos más comunes no son técnicos de instalación, sino operativos: respuestas incorrectas, falta de control del funnel, mala atribución de campañas, tokens expirados, cambios en catálogo no sincronizados y ausencia de reglas de escalamiento.[cite:38][cite:72]

Por eso, aunque Hermes puede ser el “cerebro” del sistema, la parte crítica del éxito está en el backend, los datos y la operación comercial diaria.[cite:72][cite:73]

## Checklist final de implementación

- VPS operativo con Docker o systemd.[cite:66]
- Hermes instalado y validado con `hermes doctor`.[cite:66]
- Proveedor LLM configurado.[cite:75]
- Cuenta Meta Business y app de WhatsApp listas.[cite:38]
- Webhook público y verificado.[cite:38]
- Backend con persistencia de leads y mensajes.
- Envío saliente por WhatsApp Cloud API.
- Base de conocimiento comercial cargada.
- Prompt del vendedor definido.
- Handoff a humanos implementado.
- KPIs y logs activos.

## Estado Actual de Implementación (Actualizado)

> **Nota de progreso:** A la fecha, se ha construido e implementado completamente el **Backend Comercial** (cubriendo la Fase 2 y gran parte de la Fase 3 y 4).
> 
> El backend se encuentra en la carpeta `hermes-backend` y cuenta con la siguiente arquitectura implementada:
> - **Stack:** NestJS con TypeScript, Prisma ORM y PostgreSQL.
> - **Módulos Core (16 en total):** Auth, Webhook (Meta), Meta API (envío saliente), Hermes API (motor cognitivo), Contacts, Leads, Conversations, Messages, Products, Price Lists, Knowledge, Playbooks, Handoff, Tasks, Campaigns, y Analytics.
> - **Base de Datos:** Esquema de Prisma listo con 14 tablas relacionales (CRM, catálogos, leads, analíticas).
> - **Flujo de mensajes:** El webhook (`POST /webhooks/meta/whatsapp`) implementa el ciclo completo de 10 pasos descrito en esta guía (validación, guardado, contexto, IA, reglas post-procesamiento y envío).
> 
> **Próximos pasos pendientes para producción:**
> 1. Configurar las variables de entorno reales en `.env` (credenciales Meta, URL de Hermes y PostgreSQL).
> 2. Desplegar la base de datos (se provee `docker-compose.yml`) y ejecutar la migración inicial (`npx prisma migrate dev`).
> 3. Exponer el servidor (por ejemplo, vía Cloudflare Tunnel) para recibir webhooks de Meta.

## Recomendación de cierre

Si el objetivo es crear contexto duradero para futuras sesiones y construir un activo tecnológico de negocio, la mejor estrategia es: Hermes como motor agente, Meta como canal oficial, PostgreSQL como memoria estructurada y un backend propio como capa de control del CRM conversacional.[cite:38][cite:72]
