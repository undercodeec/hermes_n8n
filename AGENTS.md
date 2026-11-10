# Hermes Backend — instrucciones para OpenCode

El backend vive en `hermes-backend/` dentro de este repositorio Git. Usa NestJS, TypeScript, Prisma/PostgreSQL, Redis/BullMQ, Docker y n8n. Integra WhatsApp Cloud API y el motor conversacional Nous. Revisa ledger de entregas, idempotencia, STOP, opt-out, handoff humano, catálogo comercial y activaciones controladas según el módulo afectado.

La rama funcional piloto `pilot/a7-d12-monitor-only-20261026` debe comprobarse por HEAD antes de usarla; la raíz local está en `main` y contiene trabajo previo. Un PR integrado o imagen GHCR publicada no demuestra despliegue productivo. No actives F3/F4 ni cambies políticas productivas, tarifas, datos, esquemas o migraciones sin revisión específica.

`Hermes-web/` es otro repositorio Git anidado. En la sesión independiente de Hermes Backend no inspecciones ni edites su contenido; desde UnderCodeEC con /vincular-hermes activo, el usuario autorizó lectura, edición y pruebas de toda D:/Documentos/Hermes, incluido Hermes-web. No uses worktrees ajenos como directorios de escritura.

## Flujo y trazabilidad

Trabaja solo en esta raíz Git o en un worktree de este mismo repositorio autorizado para la tarea. Antes de proponer una base, registra rama, HEAD, estado Git y worktree. Preserva cambios previos. Máximo sugerido: dos tareas de desarrollo independientes, sin archivos de escritura compartidos, más las revisiones necesarias. Cuando la tarea se ejecute desde /vincular-hermes, cierra con commit y push a la rama de desarrollo tras validación y QA, usando solo archivos de hermes-backend/**; no despliegues a producción ni crees worktrees automáticamente.

Para `/planificar`, presenta alcance, módulos, riesgos, dependencias y aprobación solicitada antes de editar. Para `/desarrollar`, la solicitud concreta del usuario autoriza implementación y validaciones locales rutinarias en una rama de desarrollo del checkout original; crea o cambia a esa rama preservando cambios previos, y usa `main` solo por indicación expresa. Los cambios de políticas productivas, tarifas, datos, esquemas y migraciones requieren revisión específica. QA y auditoría no modifican código funcional.

OpenCode puede crear, modificar y eliminar archivos de código local, instalar dependencias y ejecutar pruebas y builds sin aprobaciones repetitivas cuando la tarea lo requiera. Usa datos y servicios de desarrollo o simulados. No ejecutes migraciones productivas, no modifiques el VPS, no envíes WhatsApp reales, no proceses datos productivos y no despliegues. Los permisos del shell nativo de Windows no aíslan el acceso a otros directorios; los límites de OpenCode son reglas operativas, no confinamiento del sistema.

En Windows, el terminal de OpenCode usa PowerShell: ejecuta comandos separados en llamadas distintas y no uses `&&` como separador.

Interpreta informes Markdown según fecha, rama, commit y evidencia. Consulta el estado Git y los PR pertinentes antes de declarar que algo falta o sigue pendiente. Distingue código implementado, probado, integrado, imagen publicada, versión desplegada y validación en producción. Nunca incorpores datos privados productivos al contexto.

## Handoff entre repositorios

El plugin `project_bridge` intercambia mensajes locales entre las sesiones de Hermes y UnderCodeEC. Al iniciar o retomar una tarea cruzada, el coordinador consulta `project_bridge_list`, lee los mensajes pertinentes con `project_bridge_read` y confirma su recepción con `project_bridge_ack`. Para solicitar trabajo o entregar un resultado usa `project_bridge_send` con ID de tarea, asunto y cuerpo que incluya contrato, evidencia, pruebas, riesgos y decisión requerida. El plugin agrega automáticamente rama, HEAD y estado de cambios del repositorio emisor. No incluyas credenciales, datos de clientes ni información productiva. El receptor verifica su propia rama y HEAD antes de actuar.

El buzón no concede lectura ni edición del otro repositorio y no inicia agentes remotos. Cada sesión conserva su propio alcance y validaciones. Si el plugin no está disponible, entrega en la respuesta un bloque Markdown con ID, origen y destino, fecha, rama y HEAD, solicitud, contrato o archivos relevantes, evidencia, resultados, riesgos, validaciones ejecutadas y pendientes, y decisión requerida para que el usuario lo copie a la otra sesión.


## Cierre de tareas vinculadas

El usuario autorizó en /vincular-hermes el trabajo autónomo hasta commit y push a ramas de desarrollo. En esta raíz Git, prepara commits solo con rutas pertenecientes a la tarea; preserva cambios ajenos. Hermes-web tiene su propia raíz Git y requiere commit y push separados si la tarea lo modifica. Repite pruebas, lint, build e integración Docker/PostgreSQL con recursos desechables y QA antes de publicar. No uses force push ni despliegue productivo. Un rechazo remoto o una validación fallida debe investigarse y resolverse dentro del alcance antes de reportar bloqueo.


Para enviar un handoff manual desde Hermes usa /enviar-undercode ID | Asunto | Mensaje; para revisar pendientes usa /buzon-proyectos. El agente puede usar project_bridge_read y project_bridge_ack para leer y confirmar mensajes completos.

## Alcance completo desde UnderCodeEC

/vincular-hermes concede a los agentes de esa sesión lectura y edición de toda D:/Documentos/Hermes, incluido este AGENTS.md, hermes-backend y Hermes-web, además de ejecutar pruebas locales. No detengas una tarea vinculada por la ubicación de un archivo dentro de esta carpeta. Conserva la separación de repositorios Git y realiza commits y pushes a ramas de desarrollo con archivos exactos de la tarea. No despliegues a producción.
