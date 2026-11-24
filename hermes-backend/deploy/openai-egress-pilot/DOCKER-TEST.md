# Topología Docker sintética y desechable

En Windows, con Docker Desktop activo en `desktop-linux`, OpenSSL de Git y la imagen local `node:22-bookworm-slim`:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ./run-docker-test.ps1
```

El script comprueba contexto y motor, genera una clave y certificado ficticios temporales, muestra `compose config` y usa un nombre de proyecto aleatorio exclusivo. No hace pull: si falta la imagen o falla el motor/red, termina con error. No publica puertos ni usa volúmenes Docker; los bind mounts son de solo lectura. El cliente monta únicamente el certificado público y comprueba que la clave no está presente; solo el mock monta la clave. Ambas redes son internas: el cliente simulado solo comparte una con el relay y el mock solo comparte la otra con el relay. El proyecto y certificado temporal se eliminan al terminar, incluso ante error (si Docker no responde durante la limpieza, es necesario reintentar la limpieza de ese proyecto específico).

Las pruebas comprueban respuesta TLS sintética a través del relay, rechazo de hostname y CA erróneos, e imposibilidad de conexión directa desde el cliente a la IP privada real del mock, obtenida mediante un canal auxiliar de prueba. Después se detiene el mock: se consulta la telemetría del relay antes y después de un intento, verificando que sigue vivo, acepta la conexión, registra exactamente un intento al upstream fallido, sin conexión exitosa. El código del fixture tiene una única ruta fija y no implementa fallback; los contadores respaldan esa conducta en este caso, no demuestran la ausencia de rutas alternativas en otros procesos o despliegues. El relay y cliente aquí son fixtures diferentes del proxy local de `proxy.test.mjs`; no reproducen `hermes-agent`, ni el contrato ni el endpoint real de OpenAI. No son prueba de aislamiento en producción, política de firewall externa ni resistencia de un contenedor privilegiado o comprometido. No usar credenciales o datos reales.
