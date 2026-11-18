# APK local de prueba (no distribución)

El script `scripts/build-android-test.ps1` genera un APK **release autónomo**, sin Metro ni Expo Go, en Windows. No usa EAS ni publica nada; no instala en dispositivos. Son **tres variantes diferentes**, no un APK que cambie automáticamente según el entorno:

| Variante | Paquete / nombre | Red e Inbox | Estado |
| --- | --- | --- | --- |
| `demo` (predeterminada) | `com.undercodeec.hermescrmdemo.test` / *Hermes CRM Demo - Test* | Sin endpoints; chats ficticios y respuesta solo en memoria. | APK local comprobable sin cuentas reales. |
| `staging` | `com.undercodeec.hermescrmstaging.test` / *Hermes CRM Staging - Test* | OTP y sesión en dos servidores **aislados** explícitos; Inbox ficticio. | No compilado ni autorizado para producción. |
| `read-only-public` | `com.undercodeec.hermescrmreadonly.publicapitest` / *Hermes CRM Read-Only - Test* | Entrypoint distinto: OTP CRM y API Hermes públicos, Inbox remoto GET; sin importar demo, compositor ni respuesta. | **APK local retenido; NO instalar ni abrir**: falta contrato `idleRemainingMs` en backend productivo. |

Requisitos: Node/npm, JDK 21 con `JAVA_HOME`, Android SDK local (`ANDROID_HOME` o `%LOCALAPPDATA%\Android\Sdk`) con plataformas, build-tools 36.0.0 y licencias aceptadas, red para descargar dependencias Gradle (Expo SDK 58 puede instalar automáticamente SDK 37 y build-tools 37). Ejecutar en **worktree independiente de ruta física corta**, por ejemplo `D:\m-g3-apk-qa-20261118`: Ninja/CMake falló al compilar desde `D:\Documentos\Hermes\.worktrees\...`; `subst` no lo resuelve porque Gradle sigue las rutas físicas. `hermes-mobile/` debe estar limpio y tener el commit `a2e9b5b3ba7e4dec4015a10b29830856757c2f14` integrado (incluye `960fe806` de 24h y protección ante respuestas tardías); comprobar antes que el backend aislado implemente el contrato de sesión **24h**. Las pruebas de tipos y la suite simulada no certifican despliegue del backend. No ejecutar staging contra producción ni usar cuentas o datos reales.

Desde `hermes-mobile/` en PowerShell:

```powershell
.\scripts\build-android-test.ps1 -ExpectedMobileCommit a2e9b5b3ba7e4dec4015a10b29830856757c2f14
```

Solo tras validar **ambos destinos aislados** y obtener autorización del coordinador para una prueba de autenticación:

```powershell
.\scripts\build-android-test.ps1 -ExpectedMobileCommit a2e9b5b3ba7e4dec4015a10b29830856757c2f14 -Variant staging -CrmAuthUrl 'https://<otp-de-prueba>' -HermesApiUrl 'https://<api-de-prueba>' -ConfirmIsolatedTestEndpoints
```

Build **read-only público retenido**, sin ejecutar OTP, peticiones HTTP ni instalar APK:

```powershell
.\scripts\build-android-test.ps1 -ExpectedMobileCommit a2e9b5b3ba7e4dec4015a10b29830856757c2f14 -Variant read-only-public -CrmAuthUrl 'https://admincrm.undercodeec.com' -HermesApiUrl 'https://api.undercodeec.com' -ConfirmPublicReadOnlyNoInstall
```

Son **orígenes públicos distintos**: el cliente hace `POST /api/crm/auth/request-code` y `/api/crm/auth/mobile/verify-code` al host CRM (asumido desde la documentación de vhost, ruta a confirmar con el equipo CRM), y `POST /api/auth/mobile/crm-proof`, refresh, activity y logout al host Hermes. En el APK read-only, **los recursos de conversación** están restringidos a `GET /api/mobile/inbox*`; no hay POST de reply, envío, SSE, compositor, ni datos ficticios en el entrypoint de lectura. Read-only **no significa cero POST de autenticación**. No se ha probado disponibilidad de estas rutas en los hosts públicos ni se han utilizado cuentas/datos reales.

No pasar secretos/OTP/tokens; las URL públicas HTTPS se incrustan en el APK. `EXPO_NO_DOTENV=1` evita cargar `.env`; el script limpia variables `EXPO_PUBLIC_*` heredadas. Los modos `staging` y `read-only-public` son opt-in incompatibles; el segundo exige los dos hosts exactos HTTPS y un marcador de **NO instalación**. La validación de host/HTTPS no acredita que los endpoints, certificados y versiones de backend sean compatibles. No construir `staging` apuntando a producción.

La carpeta `android/` se regenera con Expo y se ignora en Git. El template nativo de Expo firma `release` con una **clave debug**: el script sustituye esa configuración para firmar con una clave local efímera, generada en `%LOCALAPPDATA%\Temp\opencode\hermes-mobile-signing\` y contraseña solo en memoria durante la ejecución. Validez 30 días; **no es identidad de publicación ni clave de actualización estable**. Para instalar otra build puede ser necesario desinstalar la anterior, lo que elimina sus datos. No copiar claves al repositorio, no compartir el APK. El resultado queda ignorado en `hermes-mobile/artifacts/` y la salida imprime HEAD, variante, ruta y SHA-256; `apksigner verify` comprueba firma. No hay autorización de instalación en teléfono ni de distribución implícita.

**Contrato y puertas de QA (por separado):**

1. **Build estático:** `npm run check`, `npx expo-doctor`, Metro desde `index.readonly.ts` separado, ausencia de marcadores de compositor demo en el JS generado, `apksigner verify`, hash SHA-256, `aapt dump badging/xmltree` para packageId, nombre, targetSdk y backup deshabilitado. Inspeccionar permisos. La firma local y las pruebas simuladas no demuestran operatividad del servidor.
2. **Backend antes de instalar:** confirmar por evidencia independiente que CRM ofrece los endpoints OTP/proof móvil, Hermes G2/G4 ofrece `GET /api/auth/mobile/session` con `active:true` **e `idleRemainingMs` numérico válido** (24h de inactividad humana), y `/api/mobile/inbox` con cursor. Actualmente el Hermes productivo **no** ofrece `idleRemainingMs`; el cliente falla cerrado. Ni el build ni la ruta HTTPS por sí solos certifican versión/despliegue. No iniciar sesión ni solicitar OTP real hasta tener aprobación y entorno/datos sintéticos.
3. **Emulador aislado si disponible:** instalar **solo demo** con AVD local, comprobar arranque offline y marcador de datos ficticios; no usar cuentas ni teléfonos de usuarios. El APK read-only no se instala ni se lanza antes de la puerta 2.
4. **QA funcional posterior y autorizado:** dispositivo/emulador dedicado con identidad sintética, OTP real del entorno aprobado, consulta GET y paginación, bloqueo al segundo plano/reconexión, vencimiento 24h, respuesta tardía, revocación/logout y ausencia de envío. Registrar resultados sin PII, OTP, tokens ni pantallas de clientes. Requiere autorización distinta para publicación/distribución y una firma estable; la actual no permite actualizaciones confiables.

Un fallo del SDK, Gradle, licencia, dependencia, generación nativa, firma o contrato bloquea la entrega. `npm audit --omit=dev` observó tres avisos **moderados** (`expo`, `@expo/fingerprint`, `minimatch`), ningún alto/crítico: revisar antes de cualquier distribución. No suplir la falta de firma con APK debug ni usar EAS remoto sin autorización.
