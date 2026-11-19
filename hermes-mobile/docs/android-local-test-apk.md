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
.\scripts\build-android-test.ps1 -ExpectedMobileCommit a2e9b5b3ba7e4dec4015a10b29830856757c2f14 -Variant read-only-public -CrmAuthUrl 'https://api.undercodeec.com' -HermesApiUrl 'https://api.undercodeec.com' -ConfirmPublicReadOnlyNoInstall
```

Las rutas OTP CRM y Hermes comparten **el mismo origen público** `https://api.undercodeec.com`, pero Nginx las dirige a servicios distintos: `POST /api/crm/auth/request-code` y `/api/crm/auth/mobile/verify-code` van a UnderCode; `POST /api/auth/mobile/crm-proof`, refresh, activity y logout van a Hermes. En el APK read-only, **los recursos de conversación** están restringidos a `GET /api/mobile/inbox*`; no hay POST de reply, envío, SSE, compositor, ni datos ficticios en el entrypoint de lectura. Read-only **no significa cero POST de autenticación**. La ruta OTP en `admincrm.undercodeec.com` del primer APK retenido era incorrecta y ese APK **no se instaló**. La ruta `api.undercodeec.com/api/crm/auth/request-code` respondió sin identidad en una comprobación de alcance y el Inbox/sesión móvil sin bearer dieron 401; esto no valida el flujo OTP ni `idleRemainingMs` autenticado.

No pasar secretos/OTP/tokens; las URL públicas HTTPS se incrustan en el APK. `EXPO_NO_DOTENV=1` evita cargar `.env`; el script limpia variables `EXPO_PUBLIC_*` heredadas. Los modos `staging` y `read-only-public` son opt-in incompatibles; el segundo exige los dos hosts exactos HTTPS y un marcador de **NO instalación**. La validación de host/HTTPS no acredita que los endpoints, certificados y versiones de backend sean compatibles. No construir `staging` apuntando a producción.

La carpeta `android/` se regenera con Expo y se ignora en Git. El template nativo de Expo firma `release` con una **clave debug**: el script sustituye esa configuración para firmar con una clave local efímera, generada en `%LOCALAPPDATA%\Temp\opencode\hermes-mobile-signing\` y contraseña solo en memoria durante la ejecución. Validez 30 días; **no es identidad de publicación ni clave de actualización estable**. Para instalar otra build puede ser necesario desinstalar la anterior, lo que elimina sus datos. No copiar claves al repositorio, no compartir el APK. El resultado queda ignorado en `hermes-mobile/artifacts/` y la salida imprime HEAD, variante, ruta y SHA-256; `apksigner verify` comprueba firma. No hay autorización de instalación en teléfono ni de distribución implícita.

**Contrato y puertas de QA (por separado):**

1. **Build estático:** `npm run check`, `npx expo-doctor`, Metro desde `index.readonly.ts` separado, ausencia de marcadores de compositor demo en el JS generado, `apksigner verify`, hash SHA-256, `aapt dump badging/xmltree` para packageId, nombre, targetSdk y backup deshabilitado. Inspeccionar permisos. La firma local y las pruebas simuladas no demuestran operatividad del servidor.
2. **Backend antes de instalar:** confirmar por evidencia independiente que CRM ofrece los endpoints OTP/proof móvil, Hermes G2/G4 ofrece `GET /api/auth/mobile/session` con `active:true` **e `idleRemainingMs` numérico válido** (24h de inactividad humana), y `/api/mobile/inbox` con cursor. Según el coordinador, el Hermes productivo **no** ofrece aún `idleRemainingMs`; el cliente falla cerrado. Ni el build ni la ruta HTTPS por sí solos certifican versión/despliegue. No iniciar sesión ni solicitar OTP real hasta tener aprobación y entorno/datos sintéticos.
3. **Emulador aislado si disponible:** instalar **solo demo** con AVD local, comprobar arranque offline y marcador de datos ficticios; no usar cuentas ni teléfonos de usuarios. El APK read-only no se instala ni se lanza antes de la puerta 2.
4. **QA funcional posterior y autorizado:** dispositivo/emulador dedicado con identidad sintética, OTP real del entorno aprobado, consulta GET y paginación, bloqueo al segundo plano/reconexión, vencimiento 24h, respuesta tardía, revocación/logout y ausencia de envío. Registrar resultados sin PII, OTP, tokens ni pantallas de clientes. Requiere autorización distinta para publicación/distribución y una firma estable; la actual no permite actualizaciones confiables.

Un fallo del SDK, Gradle, licencia, dependencia, generación nativa, firma o contrato bloquea la entrega. `npm audit --omit=dev` observó tres avisos **moderados** (`expo`, `@expo/fingerprint`, `minimatch`), ningún alto/crítico: revisar antes de cualquier distribución. No suplir la falta de firma con APK debug ni usar EAS remoto sin autorización.

## Evidencia local 18/11/2026 (sin publicación)

| Prueba | Demo | Read-only público |
| --- | --- | --- |
| Source HEAD / commit de seguridad incluido | `ebc8a77b60925b537c1172311693d57473100efd` / `a2e9b5b3` | `8e097f3d423882a15dd11ac45dbf3a412adbacf0` / `a2e9b5b3` |
| Artefacto ignorado por Git | `D:\m-g3-apk-qa-20261118\hermes-mobile\artifacts\hermes-crm-demo-local-test-ebc8a77b6092.apk` | `D:\m-g3-apk-qa-20261118\hermes-mobile\artifacts\hermes-crm-read-only-public-local-test-8e097f3d4238.apk` |
| SHA-256 APK | `D5A168F4DB3FF7648DC07C30DEA02FB4A074B243B4161C9DC2620F23546B88CA` | `5651B3E40A8544EE9C4B794E70E5AD8D64C9E4922AF0653D01BC69198F271B05` |
| Firma | `apksigner verify`: v2, 1 firmante, clave local temporal | `apksigner verify`: v2, 1 firmante; huella SHA-256 del certificado local `a2a27db131bf17aa3cb365382ba59492fa45a22e2231f06ce3d190251d59d47c` |
| Instalación / arranque | **Sí**, solo AVD nuevo `HermesDemoSyntheticA35_20261118` (Android 35, WHPX); `adb install` Success, `am start -W` Status ok, proceso activo, UI de demostración y correo ficticio detectados por `uiautomator`. Emulador apagado después. **No** teléfono. | **No instalado, no lanzado**, ni en teléfono ni en AVD; backend productivo sin `idleRemainingMs`. |
| QA funcional API | No procede: demo sin red. | **No realizado**; no hubo OTP, solicitudes HTTP, sesión ni datos de clientes. |

La verificación estática read-only observó `index.readonly.ts` en el empaquetado Metro, ambos orígenes HTTPS e Inbox en el JS generado, **sin** `agente@example.invalid`, `DATOS FICTICIOS`, `Respuesta de prueba` ni `/api/mobile/inbox/reply`. `aapt` confirmó `com.undercodeec.hermescrmreadonly.publicapitest`, etiqueta *Hermes CRM Read-Only - Test*, `MainActivity` exportada para arranque, `minSdk 24`, `targetSdk 36`, `allowBackup=false`. Permisos presentes: INTERNET, DETECT_SCREEN_CAPTURE, USE_BIOMETRIC, USE_FINGERPRINT y permiso de receptor dinámico no exportado; ausentes almacenamiento heredado, lectura de imágenes, superposición y vibración. `npm run check`: 50/50; `expo-doctor`: 20/20. Esta inspección y las pruebas simuladas **no acreditan** que el backend responda según el contrato ni autorizan instalación. La documentación se registró después del HEAD del binario; ningún APK está versionado.

## APK corregida de lectura instalada bajo autorización — 19/11/2026 21:12 UTC

La build **anterior** `8e097f3` (SHA-256 `5651B3E40A8544EE9C4B794E70E5AD8D64C9E4922AF0653D01BC69198F271B05`) continúa **sin instalar**: enviaba OTP a `admincrm.undercodeec.com`, cuyo vhost no expone la ruta UnderCode requerida. Después del corte Hermes `sha256:6d7d673a83faff9ce10e6496451a266977a8bfdceba57da9800e7053d8484663`, el host público `api.undercodeec.com` se comprobó para `/api/crm/auth/request-code` y para `/api/auth/mobile/session` y `/api/mobile/inbox` (estos dos responden 401 sin bearer). Un 401 no certifica aún el valor autenticado `idleRemainingMs` ni el Inbox real.

Fuente corregida `6cfafd5bb65178319ab88ae4eb928ca821228907`: `app.config.js`, el script de build y su prueba exigen **ambos orígenes HTTPS exactos** `https://api.undercodeec.com`; el modo de staging sintético sigue rechazando los hosts productivos. Build local desde el worktree corto `D:\m-g3-apk-qa-20261118` con `npm run check` 50/50, Gradle `:app:assembleRelease` aprobado y `apksigner verify` v2 válido. Archivo **local, no versionado ni distribuido** `hermes-mobile/artifacts/hermes-crm-read-only-public-local-test-6cfafd5bb651.apk` (69.296.630 bytes), SHA-256 `57e70a2e50b1444e9e0eb58879f74bab8b62c1725a3b34b59d14e9c1762a656c`. Inspección del bundle: nuevo origen presente, origen anterior ausente, `/api/mobile/inbox` presente y ruta de reply ausente; `aapt` confirmó el packageId read-only y la firma de prueba.

Había exactamente **un dispositivo Android autorizado** por ADB y el packageId read-only no estaba instalado. Con la autorización del propietario para continuar, `adb install --no-streaming` devolvió éxito, el paquete apareció y `am start -W` abrió la actividad; el proceso se comprobó activo. La demo tiene otro packageId y no se sustituyó. **No se introdujo OTP, no se consultaron conversaciones ni se enviaron mensajes mediante automatización**. El usuario debe iniciar sesión personalmente, sin compartir código, token, capturas ni contenido de clientes; siguen pendientes la simultaneidad con la misma web, el TTL autenticado, revocación web→móvil y la observación física de 24 horas. Firma temporal de prueba: no usar para publicación ni actualizar de forma indiscriminada otra instalación; desinstalar borraría datos locales.
