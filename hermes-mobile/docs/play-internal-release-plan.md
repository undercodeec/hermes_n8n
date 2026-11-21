# Hermes CRM — preparación para Play Console

## Decisiones del propietario

- App nueva, identidad Android `com.undercodeec.hermescrm`, nombre visible `Hermes CRM`.
- Primera distribución en **prueba interna**, solo lectura; no se autoriza una publicación pública automática.
- Cuenta Play Console y custodia de la clave de subida a cargo del propietario. Usar **Play App Signing**; la clave de subida es distinta de la clave de firma de apps que administra Google. No incluir claves, contraseñas o tokens en Git ni en chat.

## Estado técnico y puertas

La variante `play-read-only` fija explícitamente ambos orígenes a `https://api.undercodeec.com`, prohíbe backup Android y conserva la política de permisos bloqueados de la variante de prueba. **Solo configurar esta variante no produce un AAB seguro**: el proceso de compilación debe seleccionar explícitamente `index.readonly.ts` como entrypoint, verificar en el bundle la ausencia de demo y rutas de envío, firmar con la clave estable de subida del propietario, comprobar package/versionCode/certificado y conservar trazabilidad del AAB. Nunca reutilizar la firma temporal del APK de prueba. `build-android-test.ps1` es únicamente para APK de prueba y no debe usarse para publicar.

Pendiente antes de subir: acordar generación y copia de seguridad fuera de Git de la clave de subida, configurar Play App Signing en la ficha nueva, procedimiento de recuperación de la clave de subida, AAB firmado y validado, versión y versionCode, política de privacidad pública y declaración de seguridad de datos coherentes con datos procesados, acceso de revisión para aplicación con login, ficha y clasificación de contenido, requisitos vigentes de Google Play, y QA de la build firmada en dispositivos. No poner OTP, cuentas reales, contenidos de clientes ni secretos en la ficha o evidencia. Verificar el tratamiento y finalidad de correo, credenciales, tokens y contenido WhatsApp antes de completar las declaraciones; no asumir respuestas legales.

La prueba de inactividad fue confirmada por el propietario, sin horarios exactos ni resultados separados para cada cliente. Persisten las limitaciones de revocación UnderCode→Hermes best-effort, persistencia admin ante reinicio y multipestaña. Envío móvil continúa apagado. La firma estable y una pista interna no implican autorización para lanzamiento público.
