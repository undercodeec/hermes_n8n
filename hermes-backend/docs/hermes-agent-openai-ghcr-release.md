# Hermes Agent OpenAI — publicación y activación separadas

Este documento describe un candidato, no acredita una imagen publicada ni un
despliegue productivo. El backend y el agente son imágenes distintas. El flujo
previsto construye `ghcr.io/undercodeec/hermes-agent` en GitHub Actions desde
el commit exacto de esta rama y comunica su digest; no despliega en la VPS.
Un push a la rama nombrada en el workflow inicia la publicación: revisar los
archivos y el commit completo antes de publicar la rama.

## Contexto comprobado

- En el intento anterior, la salida OpenAI con contenido ficticio funcionó
  desde la imagen aislada; el gateway devolvió HTTP 500 al usar OpenAI porque la
  imagen A7-D8 obliga una política por turno implementada para Gemini.
- La imagen A7-D8 observada tenía ID
  `sha256:403917d73eb19e9388ea5bf49a52da8b1282e092ec412637aa81ad930e4c7efe`
  y revisión `a251551a4b7dc187780193756d0747a1e3ea8e88`. Es una referencia
  histórica del intento, no una afirmación sobre el runtime actual.
- Nueve archivos fuente copiados desde ese commit coincidieron por SHA-256 con
  los archivos de la imagen activa durante la inspección. Los hashes base, la
  revisión y el digest de la imagen original están en
  `deploy/openai-agent-overlay/a7-d8-baseline-sha256.json`. Los cambios del
  candidato deben revisarse como diferencias sobre esa base.
- El intento se revirtió a la configuración anterior. Gemini puede seguir
  fallando por ubicación; contenedor saludable no prueba proveedor funcional.
- El usuario pospuso el límite mensual de USD 20: no existe garantía de ese
  máximo. Esa decisión no elimina los controles técnicos de llamadas por turno.
- En una lectura posterior del VPS se observó Linux/amd64, systemd 255,
  nftables 1.0.9, Docker habilitado y `live-restore=false`. Es una fotografía,
  no demuestra que las unidades o las reglas candidatas sean compatibles; debe
  volverse a comprobar antes de cualquier operación.

## Condiciones de publicación y despliegue

1. Preparar la imagen sobre una base fijada por digest y revisar que las
   llamadas OpenAI estén cubiertas por guardas por turno y que Gemini conserve
   sus controles. No desactivar el marcador A7-D8 como atajo.
2. Registrar commit, árbol, resultados, workflow y digest. Verificar plataforma,
   revisión OCI, contenido y que el VPS pueda descargar el digest publicado.
3. Antes de activar, inspeccionar runtime, configuración, red, persistencia y
   cola, y preparar rollback específico. El DNS y las reglas del proxy tienen que
   fallar cerrado y tratar cambios de direcciones; el SNI solo no es firewall.
4. Desplegar exclusivamente el agente por digest, conservar autenticación y
   alias, y verificar conexión y contrato usando datos ficticios. No enviar
   WhatsApp real ni reabrir masivamente derivaciones humanas como prueba.
5. Registrar el resultado efectivo y el procedimiento de reversión. Publicar
   una imagen no demuestra que esté en ejecución ni que atienda conversaciones.
