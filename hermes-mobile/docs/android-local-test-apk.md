# APK local de prueba (no distribución)

El script `scripts/build-android-test.ps1` genera un APK **release autónomo**, sin Metro ni Expo Go, en Windows. No usa EAS ni publica nada; no instala en dispositivos. El modo predeterminado sigue siendo **demo ficticia sin red**. La compilación `staging` es otro paquete (`com.undercodeec.hermescrmstaging.test`) y se rotula *Hermes CRM Staging - Test*, pero **solo autentica contra el entorno aislado**: después del acceso muestra Inbox ficticio; nunca activa la lectura G4 ni envía WhatsApp. El paquete demo es `com.undercodeec.hermescrmdemo.test` (*Hermes CRM Demo - Test*).

Requisitos: Node/npm, JDK 21 con `JAVA_HOME`, Android SDK local (`ANDROID_HOME` o `%LOCALAPPDATA%\Android\Sdk`) con plataformas, build-tools 36.0.0 y licencias aceptadas, red para descargar dependencias Gradle (Expo SDK 58 puede instalar automáticamente SDK 37 y build-tools 37). Ejecutar en **worktree independiente de ruta física corta**, por ejemplo `D:\m-g3-apk-qa-20261118`: Ninja/CMake falló al compilar desde `D:\Documentos\Hermes\.worktrees\...`; `subst` no lo resuelve porque Gradle sigue las rutas físicas. `hermes-mobile/` debe estar limpio y tener el commit `a2e9b5b3ba7e4dec4015a10b29830856757c2f14` integrado (incluye `960fe806` de 24h y protección ante respuestas tardías); comprobar antes que el backend aislado implemente el contrato de sesión **24h**. Las pruebas de tipos y la suite simulada no certifican despliegue del backend. No ejecutar staging contra producción ni usar cuentas o datos reales.

Desde `hermes-mobile/` en PowerShell:

```powershell
.\scripts\build-android-test.ps1 -ExpectedMobileCommit a2e9b5b3ba7e4dec4015a10b29830856757c2f14
```

Solo tras validar **ambos destinos aislados** y obtener autorización del coordinador para una prueba de autenticación:

```powershell
.\scripts\build-android-test.ps1 -ExpectedMobileCommit a2e9b5b3ba7e4dec4015a10b29830856757c2f14 -Variant staging -CrmAuthUrl 'https://<otp-de-prueba>' -HermesApiUrl 'https://<api-de-prueba>' -ConfirmIsolatedTestEndpoints
```

No pasar secretos/OTP/tokens; las URL públicas HTTPS se incrustan en el APK. `EXPO_NO_DOTENV=1` evita cargar `.env`; el script limpia variables `EXPO_PUBLIC_*` heredadas. La validación sintáctica HTTPS **no acredita aislamiento**: comprobar identidad y despliegue de ambos hosts por separado. Las URLs de producción están prohibidas aun si son HTTPS. Un script no puede verificar la procedencia del backend remoto.

La carpeta `android/` se regenera con Expo y se ignora en Git. El template nativo de Expo firma `release` con una **clave debug**: el script sustituye esa configuración para firmar con una clave local efímera, generada en `%LOCALAPPDATA%\Temp\opencode\hermes-mobile-signing\` y contraseña solo en memoria durante la ejecución. Validez 30 días; **no es identidad de publicación ni clave de actualización estable**. Para instalar otra build puede ser necesario desinstalar la anterior, lo que elimina sus datos. No copiar claves al repositorio, no compartir el APK. El resultado queda ignorado en `hermes-mobile/artifacts/` y la salida imprime HEAD, variante, ruta y SHA-256; `apksigner verify` comprueba firma. No hay autorización de instalación en teléfono ni de distribución implícita.

Un fallo del SDK, Gradle, licencia, dependencia, generación nativa, firma o backend aislado **bloquea** la entrega. No suplir la falta de firma con un APK debug ni usar EAS remoto sin autorización. La compilación no demuestra que el backend G2/G4 esté desplegado o alineado con las 24h, y no constituye QA en dispositivo.
