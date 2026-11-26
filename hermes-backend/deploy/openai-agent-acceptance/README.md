# Aceptación aislada: futura imagen Hermes Agent OpenAI

Estado: **harness y autopruebas, NO aceptación de la imagen**. No se conoce ni presupone la API interna del agente. El caso real A7-D8 con proveedor distinto Gemini es un antecedente comunicado, no reproducido aquí. No se hicieron despliegues ni accesos productivos.

## Ejecución local sin dependencias ni credenciales

Desde `hermes-backend` (Python 3):

```powershell
python -B deploy/openai-agent-acceptance/test_harness.py
python -B deploy/openai-agent-acceptance/harness.py --adapter python -B deploy/openai-agent-acceptance/fixture_adapter.py
```

El fixture es un cliente sintético, no Hermes. Las autopruebas comprueban que el harness rechaza un fallo abierto y una llamada adicional al proveedor. Para evaluar la imagen, un responsable debe crear un adaptador independiente y conectarlo al comando `--adapter <ejecutable> <argumentos>`. No pasar secretos por argumentos ni logs. El adaptador es parte del sistema de prueba, no puede ser simplemente el fixture.

## Contrato del adaptador (propuesto, no API de Hermes)

Lee una única línea JSON desde stdin con `scenario`, `openai_base_url`, `input` sintético y `max_provider_calls` (2). Inicia **un turno real de la imagen candidata** utilizando únicamente el endpoint mock indicado y devuelve en stdout un solo objeto JSON. Para éxito: `{"status":"ok","answer":"synthetic-ok","side_effects":0}`. Para error: `{"status":"error","side_effects":0}` sin clave `answer`. La salida refleja el resultado observable del turno, no un resultado fabricado por el adaptador. Ante un error técnico del adaptador debe salir con código no cero. No imprimir información sensible.

El mock implementa únicamente `POST /v1/chat/completions`; valida ruta, objeto JSON, `model` y `messages` no vacíos, y registra las llamadas efectivas. Si la imagen utiliza Responses API, streaming, otro esquema estructurado o configuración de base URL diferente, primero verificar el contrato real y adaptar explícitamente el mock y el adaptador; un fallo de incompatibilidad no prueba un defecto del producto. El mock no valida semánticamente prompts, autenticación, ni modelo. La entrada y respuestas son sintéticas.

- `success`: contenido del mensaje es JSON con respuesta sintética, debe propagarse como éxito.
- `invalid_json`: sobre HTTP 200 válido, el **contenido estructurado del mensaje** no es JSON; no equivale a cuerpo HTTP JSON inválido. Debe rechazarse sin respuesta ni efectos.
- `rate_limit`: HTTP 429; el turno debe fallar cerrado con hasta dos llamadas contabilizadas, sin respuesta ni efectos.
- `turn_limit`: el mock devuelve indefinidamente una solicitud de herramienta `synthetic_noop`; se esperan exactamente dos llamadas y después error sin efectos, no una tercera. El adaptador debe instrumentar herramientas con dobles inertes y configurar el límite real del turno. Si la imagen no soporta esa herramienta o no puede configurar ese límite, el resultado es no concluyente; no sustituir por una simulación del límite fuera de la imagen.

El proceso del adaptador recibe un entorno mínimo sin variables de credenciales/proxy heredadas, pero **esto no es aislamiento de red ni impide acceso a archivos/credenciales montadas**. Ejecútese sólo en entorno de desarrollo desechable con salida de red bloqueada, sin secretos, volúmenes, socket Docker de producción ni servicios reales. El servidor escucha exclusivamente `127.0.0.1` del host que ejecuta el harness: si la imagen corre en contenedor, se necesita un puente/proxy local controlado y aislado o ejecutar el harness en su misma red/namespace; verificar que el endpoint proporcionado sea alcanzable sin abrir salida a Internet. El mock sólo cuenta las llamadas que recibe: el aislamiento de egress es imprescindible para detectar/impedir desvíos. El valor `side_effects` es autodeclarado por el adaptador; instrumentar independientemente todos los destinos de herramientas y comprobar contadores/ausencia de escritura para evidencia real. La ausencia de llamadas fuera del mock no se demuestra sólo con este harness.

## Alias del gateway: verificación pendiente con imagen y red reales de prueba

El harness no valida DNS ni el gateway. En una red Docker de desarrollo desechable y aislada, levantar la imagen candidata con alias de red `hermes-agent` y un gateway de prueba con la configuración real equivalente. Desde el namespace/contenedor del gateway, resolver `hermes-agent` usando herramientas disponibles en esa imagen, comparar el resultado con la IP de la imagen candidata en esa misma red (`docker inspect` sobre recursos de prueba), y efectuar una petición sintética por el puerto/protocolo **verificados** del gateway. Confirmar en instrumentación que llega a la candidata y que el turno usa sólo el mock OpenAI. Registrar imagen por digest, configuración de red, comandos y resultado; eliminar recursos de prueba. No inventar endpoint ni declarar éxito si la resolución o petición no se pueden ejecutar. Nunca conectar esta prueba a una red productiva.

## Criterios de aceptación y límites

Sólo declarar aceptación al ejecutar contra la imagen identificada por digest: alias y flujo real gateway verificados; cuatro escenarios aprobados, conteos de mock y efectos contrastados externamente; egress bloqueado y ausencia de credenciales/datos de clientes demostrados; configuración de proveedor OpenAI explícitamente verificada, sin fallback a Gemini u otro proveedor. Añadir pruebas de cuerpo HTTP malformado, timeout, desconexión, límites de tokens/herramientas/tiempo y concurrencia si el contrato real las requiere; no están cubiertas aquí. La prueba de llamadas no demuestra por sí sola todos los límites por turno. La referencia a la imagen y el digest son requisitos pendientes, no resultados observados.

## Sondeo Docker de imagen candidata

En el VPS se ejecutó el escenario sintético `success` con la imagen anterior
`sha256:403917d73eb19e9388ea5bf49a52da8b1282e092ec412637aa81ad930e4c7efe`,
en un contenedor desechable sin red ni datos de clientes. Se corrigió el runner
para usar el usuario no privilegiado `hermes`, requerido por la imagen oficial.
El gateway arrancó y contestó HTTP 200, pero el mock observó cero despachos;
el escenario falló, como corresponde a esta imagen incompatible. Esto no prueba
una imagen nueva ni equivale a aceptación del producto. No se modificó ni se
reinició el contenedor productivo.

`docker_acceptance.py` ejecuta por escenario la **imagen local real por ID inmutable**, con `--pull=never --network=none`, sin puertos publicados, sin socket Docker ni mounts de credenciales. El único bind es `image_probe.py`, de sólo lectura. Dentro de la imagen, el probe arranca `hermes gateway run`, un upstream HTTP sintético en loopback y hace una petición HTTP auténtica al gateway. Registra, desde el servidor mock, cada POST recibido, ruta y modelo; no intercepta ni reemplaza funciones del agente. El subprocess del gateway recibe entorno explícito con claves ficticias y perfil temporal bajo `/tmp`. No se pasa WhatsApp ni servicios externos. Un contenedor con nombre aleatorio se elimina también en el `finally`; si se interrumpe abruptamente el proceso anfitrión, limpiar manualmente sólo su contenedor `hermes-qa-*`. Ejecutar únicamente con Docker daemon **local de desarrollo**, imagen local confiable, sin volúmenes ni secretos incrustados; `--network=none` no protege contra un daemon remoto hostil ni privilegios del daemon. No se construye ni publica una imagen.

```powershell
python -B deploy/openai-agent-acceptance/test_image_probe.py
python -B deploy/openai-agent-acceptance/test_docker_acceptance.py
python -B deploy/openai-agent-acceptance/docker_acceptance.py --image <imagen-local-o-id>
```

El comando retorna no cero ante Docker no disponible, imagen ausente, fallo de arranque, ausencia de llamadas o cualquier aserción fallida. Muestra ID de imagen, modelo upstream, estado HTTP y despachos contabilizados; no muestra logs o respuestas arbitrarias. Cada escenario parte de contenedor y perfil limpios. El sondeo usa `/v1/chat/completions` y modelo virtual `hermes-agent` según `gateway/platforms/api_server.py` y `api_server_openai_routes.py` del código inspeccionado. El perfil sintético se genera en el contenedor, con campos del test A7 `tests/agent/test_provider_budget.py` y modelo `gpt-4o-mini`; no se establece que el contrato de la imagen futura sea el mismo. Se presupone la ruta CLI `/opt/hermes/.venv/bin/hermes`: si no existe o si cambia el esquema de configuración, el probe falla y debe ajustarse tras verificar la imagen, no simularlo. `invalid_json` en este sondeo es **cuerpo HTTP inválido**, distinto al escenario de contenido inválido del fixture anterior.

**Barreras observadas y pendientes:** el `provider_budget.py` inspeccionado exige `model` Gemini (líneas 55-57) y `agent_init.py` exige ruta Gemini (2299-2305), mientras que Dockerfile crea marcador obligatorio; por tanto el overlay observado aún no puede iniciar un turno OpenAI presupuestado. El agente de implementación puede estar modificándolo concurrentemente: volver a verificar la revisión exacta de la imagen construida. En esta máquina `docker version` no pudo conectar con el daemon (`dockerDesktopLinuxEngine` ausente), por lo que no se ha ejecutado imagen real ni validado arranque CLI, configuración, tratamiento de errores o flujo OpenAI.

El sondeo mide despachos **recibidos por el mock** y no cuenta intentos bloqueados antes del servidor; la red sin salida impide conectar a proveedores externos. El límite simulado de dos requiere que el modelo devuelva reiteradamente llamadas `synthetic_noop`, pero el perfil deshabilita herramientas para evitar efectos reales: puede detenerse antes de dos, y entonces el test falla/no es concluyente sobre el límite. Se requiere una herramienta ficticia real integrada en el catálogo, instrumentación independiente de efectos, y validación de los límites reales (tokens, coste, tiempo y llamadas). Un HTTP error sin choices es criterio conservador de fallo, pero no prueba por sí solo ausencia de efectos. El runner usa loopback: comprueba el nombre de **modelo virtual** `hermes-agent`, no el alias DNS Docker del gateway; falta prueba separada en una red interna descartable y comparación contra IP de candidata. Ningún PASS aislado equivale a aceptación integral.

## Contrato OpenAI fijo y TLS de prueba (actual, pendiente de imagen real)

Para `source/agent/openai_budgeted_turn.py`, utilice **este runner nuevo**, no el anterior `docker_acceptance.py` cuyo mock HTTP/base URL es incompatible con el endpoint fijo. Requiere Python 3 con `cryptography`, daemon Docker local Linux de desarrollo y una imagen candidata ya construida y disponible localmente. No se descarga ni construye ninguna imagen. En CI, un runner efímero con esas dependencias debe ejecutar:

```powershell
python -B deploy/openai-agent-acceptance/test_tls_acceptance.py
python -B deploy/openai-agent-acceptance/tls_docker_acceptance.py --image <id-o-tag-local>
```

El código usa el ID inmutable de la imagen e inspecciona como usuario `hermes` la ruta **real** de `certifi.where()` y SHA-256 del módulo real incorporado. Por escenario se crea un contenedor con `--network=none`, `--add-host api.openai.com:127.0.0.1`, `--user hermes`, capacidades retiradas y ningún puerto publicado. Se genera bajo este directorio un CA privada y certificado efímero con SAN `api.openai.com`. La clave de la CA no se guarda; CA pública, certificado y clave privada de servidor se eliminan al terminar, y los tres archivos necesarios se montan individualmente de sólo lectura (la CA sustituye únicamente el archivo certifi resuelto, no modifica la imagen). Son claves de prueba, sin valor externo. Una interrupción abrupta puede dejar `qa-tls-*` o contenedores `hermes-qa-*`: limpiar sólo esos recursos de la ejecución propia. En entornos con ACLs compartidas, emplear un workspace CI aislado; la clave efímera de servidor necesita ser legible para `hermes` dentro del contenedor.

El mock HTTPS escucha sólo en `127.0.0.1:443`. Se solicita el sysctl de namespace `net.ipv4.ip_unprivileged_port_start=0` para permitir el bind por usuario no root; si Docker/OS lo rechaza, o si no existen CLI Python, `hermes`, certifi o dependencias en la imagen, la prueba falla. No se deshabilita la verificación TLS. Se ponen proxies y `SSL_CERT_FILE` falsos para comprobar indirectamente que el código realmente ignora variables de entorno de red. El caso `untrusted_ca` omite el montaje de CA: requiere error de conexión, una reserva en ledger y cero POST recibidos; no prueba por sí mismo la causa, por lo que debe acompañarse del caso positivo. El test local de la CA sí comprueba cadena y hostname correctos y rechazos con hostname distinto y CA no confiable, con verificación SSL habilitada.

Dentro de la imagen se invoca `agent.openai_budgeted_turn.run_text_turn` real con `BudgetPolicy`/`scoped_budget` reales y un objeto agente mínimo sintético; no hay reemplazo de HTTP, OpenAI SDK, presupuesto ni módulo real. El token es una cadena ficticia y no se cargan datos de clientes ni canales como WhatsApp. Escenarios: éxito, JSON HTTP malformado, JSON malformado **dentro del mensaje**, 429, finish `length`, segundo intento sobre el mismo ledger con límite 1, y CA no confiable. El mock cuenta los POST reales y valida modelo, ruta, host, stream, límite de salida y presencia de política sintética. El caso de límite confirma un despacho y `BudgetAbort/call_limit` en el segundo intento. Los errores no deben devolver contenido. No se registran prompts, tokens ni respuestas arbitrarias.

**Resultado concreto de la revisión:** la versión fuente examinada SHA-256 `2f0df52808882a5049b408de3581dab8692bed38bf22275fba55baad8ceb14fc` comprueba que el contenido sea texto no vacío (líneas 107-120), pero no hace `json.loads` del contenido. Por ello se espera que `content_json` falle el criterio de rechazo cuando la imagen corresponda a esa versión; no se ha confirmado ejecutando imagen. No relajar el criterio para hacer pasar CI sin decisión de contrato. El JSON HTTP malformado y el JSON estructurado del mensaje son pruebas distintas.

Este runner prueba el módulo y transporte reales de la imagen, **no** que el gateway lo invoque correctamente, ni el alias DNS `hermes-agent`, ni todos los efectos o límites del agente completo. Aún se necesita una prueba de extremo a extremo de gateway con configuración real verificada y un doble de efectos instrumentado. Tampoco se ha verificado aquí que el montaje de certifi, el binding del puerto 443 con sysctl, o la resolución `--add-host` funcionen en Docker concreto: el daemon de esta máquina no estaba disponible. El éxito de los tests locales del harness no constituye éxito de imagen. El mock sólo observa HTTP que llega a él; `--network=none` evita otras conexiones de red externas pero no demuestra reservas internas no despachadas. Usar un daemon de desarrollo de confianza; no conectar a VPS, Docker remoto o producción.

## Gateway real + mock TLS (sustituye el uso anterior de `docker_acceptance.py`)

`docker_acceptance.py` ahora combina el aislamiento, CA efímera y mock TLS de `tls_docker_acceptance.py`/`tls_image_probe.py` con `image_probe.py`: arranca el proceso real `hermes gateway run` de la imagen candidata bajo usuario `hermes`, crea configuración A7-D8 sintética para `openai-api`, `gpt-6-luna`, Chat Completions, URL oficial y presupuesto de una llamada, y hace `POST /v1/chat/completions` HTTP al gateway en loopback usando el modelo virtual `hermes-agent` y una instrucción de sistema sintética. El upstream escucha HTTPS en `127.0.0.1:443`; `--network=none`, el registro hosts y el montaje RO de CA sobre el `certifi.where()` real son los mismos que en el test del módulo. La verificación TLS no se desactiva. No se montan ni usan credenciales reales; la clave de gateway y la del proveedor son sintéticas.

```powershell
python -B deploy/openai-agent-acceptance/test_gateway_tls.py
python -B deploy/openai-agent-acceptance/docker_acceptance.py --image <imagen-local> --scenario success
```

Para `success`, exige HTTP 200 del gateway, respuesta JSON sintética esperada y exactamente un POST real al mock con ruta, host, modelo, política, stream y cap esperados. Sólo el proceso real del gateway puede producir este flujo; no se importa ni invoca directamente el módulo del agente desde `image_probe.py`. Se imprimen ID de imagen y hash del módulo incluido, no prompts ni secretos. Esto busca probar el encadenamiento real, pero sólo será evidencia tras ejecutarse contra una imagen identificada. No prueba el alias DNS Docker `hermes-agent` (en esta prueba es el nombre del modelo virtual), efectos externos, ni los demás límites.

Se conservan los tests y utilidades históricas. `docker_command()` y `evaluate()` originales quedan para sus autopruebas; el ejecutable usa `gateway_command()` y `evaluate_gateway()`. Los escenarios `invalid_json` y `rate_limit` apuntan al mismo mock TLS y exigen error HTTP cerrado; `turn_limit` **no puede pasar**: el nuevo módulo es de una única llamada sin bucle de herramientas, y este escenario no estresa un ledger compartido. El límite real sí se prueba independientemente en `tls_docker_acceptance.py`. Por ello, para probar únicamente el camino pedido de éxito, seleccionar `--scenario success`; ejecutar sin selección todavía incluye el caso no concluyente y devuelve error.

Pendientes sin Docker: no se ha podido confirmar que el entrypoint `/opt/hermes/.venv/bin/hermes`, resolución de proveedor/configuración A7-D8, el binding TLS sin privilegios, ruta certifi o la integración del gateway funcionen efectivamente en la imagen. Si cualquiera falla, el runner informa fallo/no concluyente; no transforma fallos en éxito. `--sysctl net.ipv4.ip_unprivileged_port_start=0` debe estar permitido por el daemon. El entorno debe ser efímero y contener una imagen local confiable sin secretos, sin VPS ni daemon productivo. Los archivos y el contenedor se limpian en operación normal; un cierre abrupto puede requerir limpiar manualmente sólo el directorio `qa-tls-*` y contenedor `hermes-qa-*` de la ejecución.

### Diagnóstico de arranque del gateway (CI 45736661206)

La ejecución reportada por el coordinador no alcanzó readiness en 35 s. En la fuente temporal inspeccionada, `gateway/config_env.py::_api_server` habilita API server a partir de una clave utilizable y no consulta `API_SERVER_ENABLED`; por tanto no se puede atribuir el fallo de CI únicamente a esa variable. Ahora el probe fija `API_SERVER_ENABLED=true` por compatibilidad y declara también `platforms.api_server.enabled=true`, host `127.0.0.1`, puerto `18772` y modelo virtual explícitos en el perfil temporal. La clave del gateway y la de OpenAI son aleatorias y efímeras, no valores reales; así se evita depender de que un texto de prueba fijo supere el detector de placeholders.

Antes de lanzar el gateway, un proceso de la imagen consulta su cargador real de configuración en el mismo entorno y devuelve únicamente booleanos de plataforma presente/habilitada/conectada, clave utilizable, host/puerto/modelo esperados. Ante timeout, salida prematura o fallo HTTP, el resultado incluye categorías predefinidas de logs (sin líneas literales), clasificación del último health check y códigos numéricos acotados cuando están disponibles. La respuesta HTTP se reduce a booleanos de forma y coincidencia de respuesta sintética: ni cuerpos, claves, prompts, errores arbitrarios ni trazas se imprimen. Los logs brutos quedan sólo dentro del `/tmp` efímero del contenedor. Estos diagnósticos son indicios, no demuestran una causa ni sustituyen una ejecución real.

```powershell
python -B deploy/openai-agent-acceptance/test_gateway_startup.py
python -B deploy/openai-agent-acceptance/docker_acceptance.py --image <imagen-local> --scenario success
```

Docker no estaba disponible en el entorno local donde se modificó el arnés; queda por verificar la carga de configuración real y el arranque en la imagen de CI. No se cambió código funcional del gateway ni se alteró la verificación TLS.

### Arranque aislado: ajuste para CI 45738747420

El código de pruebas exacto `tests/docker/test_gateway_run_supervised.py` de la fuente temporal indica que `hermes gateway run` puede redirigir al supervisor s6, dejando el comando original en `sleep infinity`; especifica `HERMES_GATEWAY_NO_SUPERVISE=1` como alternativa para conservar el gateway en primer plano. El arnés utiliza `--entrypoint` propio y no inicia s6. Ahora fija esa variable en el entorno **del proceso gateway**. Esta es una causa plausible del síntoma reportado (proceso vivo sin listener), no una causa observada en ese run: sus diagnósticos anteriores no incluían estado del proceso ni la traza de redirección.

El entorno explícito anterior también descartaba `HERMES_DISABLE_LAZY_INSTALLS=1`, que las pruebas de imagen inmutable esperan. Ahora se establece esa opción y se omite deliberadamente `HERMES_LAZY_INSTALL_TARGET`; también se desactiva la consulta AWS IMDS para este entorno sin red. No se deshabilitan Tirith, watchdogs ni verificaciones de seguridad o TLS; el código real aún puede ejecutar su inicialización y fallar. No se heredan credenciales ni configuración de plataforma del host. El timeout de readiness aumenta de 35 a 60 s, consistente con las pruebas de arranque Docker de la fuente, y el timeout externo a 145 s; sólo se acepta `/health` 200 seguido de la llamada y respuesta correctas, no un proceso vivo.

Cuando se agota readiness, se recopila pasivamente información limitada: existencia de `gateway.pid`, estado allowlisted de `gateway_state.json`, clase (`sleep_infinity`, `python_or_hermes`, `other`, `unavailable`) y estado Linux (`R/S/D/T/Z`) del proceso observado por `/proc`. Además se buscan mensajes fijos de inicio, conexión API, listener, gateway en ejecución o redirección s6 tanto en stderr como en los logs de gateway/agent dentro del home efímero. Sólo se emiten etiquetas; nunca se imprimen argv, PID, líneas de log, contenido del estado, cuerpos ni claves. Si no hay evidencia, se informa `missing`/`unavailable`, sin inferir una etapa. Estas señales sirven para localizar el punto alcanzado, no garantizan cuál llamada bloqueó.

```powershell
python -B deploy/openai-agent-acceptance/test_gateway_startup.py
python -B deploy/openai-agent-acceptance/docker_acceptance.py --image <imagen-local> --scenario success
```

Las autopruebas locales pasan; el daemon Docker del entorno de edición seguía inaccesible, por lo que debe confirmarse el arreglo mediante el siguiente run real sin asumir que la redirección era la única causa.

### Loopback y puertos: CI 45740976115

Se identificó una causa concreta en el arnés anterior: `tls_docker_acceptance.probe_command` configura intencionalmente `HTTP_PROXY`/`HTTPS_PROXY` inválidos en el **proceso del probe** para pruebas de aislamiento, pero el `NO_PROXY=*` estaba únicamente en el entorno separado del subprocess del gateway. `urllib.request.urlopen` del probe podía usar el proxy inválido para consultar `127.0.0.1:18772`, de modo que un `connection_refused` no necesariamente provenía del listener real. La causa exacta del run no se verificó en esa ejecución, pero el defecto del arnés sí se reproduce/controla en una autoprueba con variables proxy envenenadas.

La consulta HTTP del gateway utiliza ahora un opener explícito `ProxyHandler({})`, restringido a HTTP loopback y puertos de prueba 18772 y 8642; tanto readiness como el POST se conectan directamente sin depender de `NO_PROXY` heredado. Este cambio no afecta la verificación TLS ni las pruebas de `trust_env=False` del módulo OpenAI; no sustituye al gateway ni altera sus respuestas. La aceptación sigue exigiendo health en **18772**, POST real, respuesta del gateway y despacho TLS mock correctos; no se hace fallback automático al puerto predeterminado para aprobar.

Si vence el timeout, el arnés lee `/proc/<pid>/net/tcp` y `tcp6` para verificar LISTEN en el puerto objetivo y el predeterminado, y cruza inodes con descriptores del proceso para categorías `gateway_owned_target`, `gateway_owned_default` y `gateway_owned_other`. También intenta health directo en ambos puertos como información diagnóstica. Se emiten sólo booleanos, sin direcciones, puertos arbitrarios, inodes ni contenido HTTP. Si `/proc` o los descriptores no son accesibles, los booleanos `*_readable=false` distinguen ausencia de visibilidad de ausencia de listeners; los sockets en la tabla de red pueden pertenecer a otro proceso y los que pertenecen a un descendiente no cuentan como pertenecientes al PID inspeccionado. Los chequeos alternativos son diagnósticos y nunca convierten un fallo en PASS.

Fuente temporal: el preflight obtiene `PlatformConfig.extra` en un proceso separado; la instancia real de `APIServerAdapter` vuelve a leer host y puerto desde `config.extra` (o env por defecto) y efectúa el bind en `connect()`. Ver ambos valores de preflight correctos no prueba el puerto del socket real del proceso en ejecución. Las categorías `/proc` agregadas permiten contrastarlo sin exponer la dirección de escucha.

```powershell
python -B deploy/openai-agent-acceptance/test_gateway_network.py
python -B deploy/openai-agent-acceptance/docker_acceptance.py --image <imagen-local> --scenario success
```

El daemon Docker no estaba accesible en el entorno donde se editó esta versión; hace falta CI para confirmar el camino completo con la imagen candidata. No se ha producido ni inferido un PASS de imagen.
