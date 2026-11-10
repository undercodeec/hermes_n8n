# Project Bridge: UnderCodeEC ↔ Hermes

Plugin local de OpenCode V2 para intercambiar handoffs entre los dos proyectos en esta computadora. Las herramientas disponibles son:

- `project_bridge_send`: envía `taskId`, `subject` y `body` al otro proyecto; agrega rama, HEAD y si hay cambios locales.
- `project_bridge_list`: lista mensajes entrantes pendientes o el estado del buzón saliente (`mailbox: "outbox"`).
- `project_bridge_read`: lee un mensaje entrante por ID.
- `project_bridge_ack`: confirma que se recibió un mensaje entrante.

Los mensajes se guardan bajo `%LOCALAPPDATA%/OpenCode/undercode-hermes-bridge-v1`. Un mensaje no inicia una sesión ni ejecuta trabajo en el proyecto receptor; el coordinador consulta su buzón cuando inicia o retoma una tarea. No se envían archivos ni se conceden permisos cruzados de lectura o edición. No incluyas secretos ni datos productivos en el cuerpo.

Para comprobar el puente sin tocar el buzón real, ejecuta desde UnderCodeEC:

```powershell
node .opencode/plugins/project-bridge/test.mjs
```

Comandos de OpenCode:

- En UnderCodeEC: /enviar-hermes CRM-101 | Asunto | Mensaje
- En Hermes: /enviar-undercode CRM-101 | Asunto | Mensaje
- En ambos: /buzon-proyectos

También siguen disponibles las herramientas para leer un mensaje completo y confirmar recepción por ID. Invocar un comando de envío guarda un mensaje local; no despierta automáticamente la sesión receptora.
