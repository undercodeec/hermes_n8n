# Ensayo local: TCP y TLS simulado (no producción)

Este directorio es independiente: no modifica el agente, su contrato privado heredado, configuración de despliegue ni dependencias. No se dispone aquí de evidencia suficiente para reproducir el esquema real de `hermes-agent`. El mensaje HTTP y `api.openai.test` son **mocks**, no una llamada a OpenAI ni validación de su API. No usar con credenciales, redes productivas ni como configuración de producción.

## Ejecutar

Con Node.js 20+ y OpenSSL en PATH, ejecutar desde esta carpeta:

```sh
node --test proxy.test.mjs
```

En Windows se busca por defecto el OpenSSL de Git en `C:/Program Files/Git/usr/bin/openssl.exe`. Alternativamente definir `PILOT_OPENSSL` con la ruta del ejecutable. La prueba genera certificado y clave **ficticios y desechables** en un directorio temporal, los carga en memoria y elimina el directorio inmediatamente. No necesita Docker, instalar paquetes, conexión externa ni editar `node_modules`.

## Diseño y límites

El fixture levanta un servidor TLS falso y un proxy TCP dedicado en `127.0.0.1`, ambos en puertos efímeros; no hay puertos Docker publicados. El cliente se conecta al proxy usando IP literal, fija SNI/hostname `api.openai.test`, CA ficticia explícita y `rejectUnauthorized: true`. El proxy únicamente reenvía bytes al puerto local fijado por la prueba; no termina TLS ni resuelve DNS, por lo que no depende de DNS ni recursión de resolución. Puerto inválido o idéntico al del listener se rechaza; si falla el upstream no hay fallback. Se comprueban éxito, CA no confiable, nombre incorrecto, errores de configuración y upstream ausente. Pruebas TCP adicionales verifican half-close en ambas direcciones: un EOF no descarta datos pendientes en sentido contrario.

La restricción local se aplica a **este fixture**, no a la red del sistema, Docker, otro proceso o `hermes-agent`: no es firewall, aislamiento de contenedores, autenticación de cliente, ni prueba de que un agente real no pueda saltarse el proxy. El control de hostname/CA reside en el cliente de prueba, no en un proxy TCP ciego; un cliente inseguro no queda protegido por este fixture. No se ha validado un despliegue, red o servicio real, ni la compatibilidad del contrato privado. No existe una ruta de salida real a OpenAI en este ensayo. Para cualquier diseño real hacen falta revisión de arquitectura, política de red y pruebas independientes.
