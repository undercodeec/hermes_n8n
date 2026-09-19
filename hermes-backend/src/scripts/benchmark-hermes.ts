import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

type Scenario = {
  id: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  context?: string;
};

type RunResult = {
  profile: string;
  model: string;
  scenario: string;
  validJson: boolean;
  asksKnownPhone: boolean;
  asksEmail: boolean;
  falseConfirmation: boolean;
  expectedIntent: boolean;
  semanticPass: boolean;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  estimatedCostUsd: number;
  error?: string;
  customerResponse?: string;
};

type ProviderPayload = {
  error?: { message?: string };
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
};

const scenarios: Scenario[] = [
  {
    id: 'initial',
    messages: [
      {
        role: 'user',
        content:
          'Hola, quisiera obtener información sobre los servicios de Undercodeec.',
      },
    ],
  },
  {
    id: 'price_timeline',
    messages: [
      {
        role: 'user',
        content:
          'Necesito una web para mi negocio, ¿cuánto cuesta y cuánto tarda?',
      },
    ],
    context: 'No hay precios ni plazos autorizados.',
  },
  {
    id: 'florist',
    messages: [
      {
        role: 'user',
        content:
          'Tengo una floristería, son diez productos, quiero un catálogo con botón de WhatsApp y nada más. ¿Cuánto cuesta?',
      },
    ],
    context: 'No hay precios autorizados.',
  },
  {
    id: 'repeated_price',
    messages: [
      { role: 'user', content: '¿Cuánto cuesta?' },
      { role: 'assistant', content: 'Necesito saber más.' },
      { role: 'user', content: 'Ya expliqué el alcance. ¿Cuánto cuesta?' },
    ],
    context: 'No hay precios autorizados.',
  },
  {
    id: 'known_number',
    messages: [{ role: 'user', content: 'Quiero que me llamen.' }],
    context:
      'El teléfono de WhatsApp está disponible. No hay calendario; sólo tareas pendientes.',
  },
  {
    id: 'call_20_minutes',
    messages: [{ role: 'user', content: '¿En veinte minutos puede?' }],
    context:
      'El teléfono está disponible. Se creó una tarea PENDING, no una reserva.',
  },
  {
    id: 'no_call_integration',
    messages: [{ role: 'user', content: 'Agéndame una llamada a las cinco.' }],
    context: 'No hay calendario ni sistema de tareas.',
  },
  {
    id: 'no_email',
    messages: [
      { role: 'user', content: 'Prefiero que me llamen por WhatsApp.' },
    ],
    context: 'El teléfono de WhatsApp está disponible.',
  },
  {
    id: 'all_facts',
    messages: [
      {
        role: 'user',
        content:
          'Tengo una distribuidora en Madrid, necesito un sistema para pedidos e inventario, somos quince empleados y queremos implementarlo dentro de dos meses.',
      },
    ],
  },
  {
    id: 'resumed',
    messages: [
      { role: 'user', content: 'Necesito un catálogo para diez flores.' },
      { role: 'assistant', content: 'Entendido; queda pendiente el precio.' },
      { role: 'user', content: 'Hola de nuevo, continuemos.' },
    ],
    context: 'Pregunta pendiente: precio.',
  },
  {
    id: 'duplicate_event',
    messages: [{ role: 'user', content: 'Necesito información.' }],
  },
  {
    id: 'changed_scope',
    messages: [
      { role: 'user', content: 'Quería un catálogo sin pagos.' },
      { role: 'assistant', content: 'Entendido.' },
      {
        role: 'user',
        content:
          'Pensándolo mejor, sí quiero que puedan pagar directamente en la página.',
      },
    ],
  },
  {
    id: 'human',
    messages: [{ role: 'user', content: 'Quiero hablar con una persona.' }],
    context: 'El backend puede crear handoff.',
  },
  {
    id: 'unknown_price',
    messages: [{ role: 'user', content: '¿La web cuesta 500 euros?' }],
    context: 'No hay precios autorizados.',
  },
  {
    id: 'provider_error',
    messages: [{ role: 'user', content: 'Necesito una web.' }],
    context:
      'Este caso se valida mediante pruebas unitarias del fallback, no se fuerza un error real.',
  },
];

const rates: Record<string, { input: number; output: number }> = {
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
};

const expectedIntents: Record<string, string[]> = {
  initial: ['info_general'],
  price_timeline: ['consulta_precio', 'cotizacion'],
  florist: ['consulta_precio', 'cotizacion'],
  repeated_price: ['consulta_precio', 'cotizacion'],
  known_number: ['agendar_cita'],
  call_20_minutes: ['agendar_cita'],
  no_call_integration: ['agendar_cita'],
  no_email: ['agendar_cita'],
  all_facts: ['consulta_servicio', 'cotizacion'],
  resumed: ['consulta_precio', 'cotizacion', 'consulta_servicio'],
  changed_scope: ['consulta_servicio', 'cotizacion'],
  human: ['solicitud_humano'],
  unknown_price: ['consulta_precio', 'cotizacion'],
};

function semanticPass(
  scenario: string,
  response: string,
  flags: {
    asksKnownPhone: boolean;
    asksEmail: boolean;
    falseConfirmation: boolean;
  },
): boolean {
  const normalized = response
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  const priceHandled =
    /\b(precio|coste|costo|tarifa|cotiz|valoracion|cifra)\b/.test(normalized);
  switch (scenario) {
    case 'initial':
      return (
        response.length <= 300 && !flags.asksKnownPhone && !flags.asksEmail
      );
    case 'price_timeline':
      return (
        priceHandled &&
        /\b(plazo|tiempo|tarda|entrega|valoracion)\b/.test(normalized)
      );
    case 'florist':
      return priceHandled && (response.match(/\?/g) || []).length <= 1;
    case 'repeated_price':
      return (
        priceHandled &&
        !/cuentame mas|mas detalles|que funcionalidades/.test(normalized)
      );
    case 'known_number':
      return !flags.asksKnownPhone;
    case 'call_20_minutes':
    case 'no_call_integration':
      return (
        !flags.falseConfirmation &&
        /pendiente|confirm|no puedo agendar|no esta agendada/.test(normalized)
      );
    case 'no_email':
      return !flags.asksEmail;
    case 'all_facts':
      return !/(?:en que ciudad|cuantos empleados|cuantos usuarios|para cuando|que plazo)/.test(
        normalized,
      );
    case 'resumed':
      return !/cuentame que necesitas|en que puedo ayudarte/.test(normalized);
    case 'duplicate_event':
      return true; // Idempotencia es una propiedad del backend, cubierta por Jest.
    case 'changed_scope':
      return /pago|tienda|compra|e-?commerce|venta online/.test(normalized);
    case 'human':
      return /persona|equipo|deriv|asesor|comercial/.test(normalized);
    case 'unknown_price':
      return (
        priceHandled && !/(?:si|correcto|confirmado).{0,20}500/.test(normalized)
      );
    default:
      return true;
  }
}

function envFile(): Record<string, string> {
  const path = resolve(process.cwd(), '.env');
  const result: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (match) result[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function promptFromSource(source: string): string {
  const match = source.match(/private readonly systemPrompt = `([\s\S]*?)`;/);
  if (!match) throw new Error('No se pudo extraer systemPrompt');
  return match[1];
}

function schema() {
  const optionalString = { type: 'string' };
  return {
    type: 'json_schema',
    json_schema: {
      name: 'hermes_benchmark',
      strict: true,
      schema: {
        type: 'object',
        additionalProperties: false,
        required: [
          'response',
          'detectedIntent',
          'suggestedTags',
          'nextAction',
          'commercialProfile',
        ],
        properties: {
          response: { type: 'string' },
          detectedIntent: {
            type: 'string',
            enum: [
              'info_general',
              'consulta_servicio',
              'consulta_precio',
              'cotizacion',
              'agendar_cita',
              'solicitud_humano',
              'queja',
              'reclamo',
              'pago_fallido',
              'negociacion_especial',
              'info_producto',
              'interes_nava',
              'soporte',
              'otro',
            ],
          },
          suggestedTags: {
            type: 'array',
            maxItems: 10,
            items: { type: 'string' },
          },
          nextAction: {
            type: 'string',
            enum: [
              'continuar_descubrimiento',
              'solicitar_cotizacion_humana',
              'proponer_reunion',
              'solicitar_confirmacion_reunion',
              'derivar_humano',
              'sin_accion',
            ],
          },
          commercialProfile: {
            type: 'object',
            additionalProperties: false,
            properties: {
              service: optionalString,
              company: optionalString,
              sector: optionalString,
              location: optionalString,
              languageVariant: {
                type: 'string',
                enum: ['ES', 'LATAM', 'NEUTRAL'],
              },
              need: optionalString,
              currentSituation: optionalString,
              users: optionalString,
              budget: optionalString,
              timeline: optionalString,
              nextStep: optionalString,
              pendingQuestions: {
                type: 'array',
                items: {
                  type: 'string',
                  enum: ['price', 'timeline', 'proposal', 'availability'],
                },
              },
              contactPreference: {
                type: 'string',
                enum: ['WHATSAPP', 'CALL', 'VIDEO_CALL', 'EMAIL'],
              },
              requestedContactTime: optionalString,
              lastObjection: optionalString,
              suggestedStage: {
                type: 'string',
                enum: ['CONTACTED', 'QUALIFIED'],
              },
            },
          },
        },
      },
    },
  };
}

function asProviderPayload(value: unknown): ProviderPayload {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function parseObject(content: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] || '');
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function run() {
  if (process.env.HERMES_BENCHMARK_LIVE !== 'true') {
    throw new Error(
      'Define HERMES_BENCHMARK_LIVE=true para autorizar llamadas facturables sin enviar WhatsApp.',
    );
  }
  const env = envFile();
  const apiKey = process.env.HERMES_API_KEY || env.HERMES_API_KEY;
  const apiUrl = (process.env.HERMES_API_URL || env.HERMES_API_URL).replace(
    /\/+$/,
    '',
  );
  if (!apiKey || !apiUrl)
    throw new Error('Falta HERMES_API_KEY o HERMES_API_URL');

  const currentSource = readFileSync(
    resolve(process.cwd(), 'src/hermes/hermes.service.ts'),
    'utf8',
  );
  const legacySource = execFileSync(
    'git',
    ['show', 'HEAD:hermes-backend/src/hermes/hermes.service.ts'],
    { cwd: resolve(process.cwd(), '..'), encoding: 'utf8' },
  );
  const profiles = [
    {
      name: 'A_current_model_legacy',
      model: 'gemini-2.5-flash',
      prompt: promptFromSource(legacySource),
      structured: false,
    },
    {
      name: 'B_superior_model_legacy',
      model: 'gemini-2.5-pro',
      prompt: promptFromSource(legacySource),
      structured: false,
    },
    {
      name: 'C_superior_model_improved',
      model: 'gemini-2.5-pro',
      prompt: promptFromSource(currentSource),
      structured: true,
    },
    {
      name: 'D_current_model_improved',
      model: 'gemini-2.5-flash',
      prompt: promptFromSource(currentSource),
      structured: true,
    },
  ];
  const profileFilter = process.env.HERMES_BENCHMARK_PROFILES?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const selectedProfiles = profileFilter?.length
    ? profiles.filter((profile) => profileFilter.includes(profile.name))
    : profiles;
  const scenarioFilter = process.env.HERMES_BENCHMARK_SCENARIOS?.split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const results: RunResult[] = [];
  for (const profile of selectedProfiles) {
    for (const scenario of scenarios.filter(
      (item) =>
        item.id !== 'provider_error' &&
        (!scenarioFilter?.length || scenarioFilter.includes(item.id)),
    )) {
      const started = Date.now();
      try {
        const body: Record<string, unknown> = {
          model: profile.model,
          temperature: 0.25,
          max_tokens: profile.structured ? 2048 : 800,
          messages: [
            {
              role: 'system',
              content: `${profile.prompt}\n\nContexto verificado del benchmark: ${scenario.context || 'sin datos adicionales'}`,
            },
            ...scenario.messages,
          ],
        };
        if (profile.structured) body.response_format = schema();
        if (profile.structured) body.reasoning_effort = 'low';
        const response = await fetch(`${apiUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(body),
        });
        const payload = asProviderPayload(await response.json());
        if (!response.ok)
          throw new Error(payload?.error?.message || `HTTP ${response.status}`);
        const content = String(payload.choices?.[0]?.message?.content || '');
        const parsed = parseObject(content);
        const customerResponse =
          typeof parsed?.response === 'string' ? parsed.response : content;
        const asksKnownPhone =
          /(?:confirma|indica|comparte|facilita).{0,35}(?:numero|número|telefono|teléfono)/i.test(
            customerResponse,
          );
        const asksEmail = /(?:correo|email|e-mail)/i.test(customerResponse);
        const falseConfirmation =
          /(?:queda|está|he dejado).{0,30}(?:agendada|confirmada)|te llamar(?:e|é|emos).{0,20}(?:en|a las)/i.test(
            customerResponse,
          );
        const expectedIntent =
          !expectedIntents[scenario.id] ||
          expectedIntents[scenario.id].includes(
            typeof parsed?.detectedIntent === 'string'
              ? parsed.detectedIntent
              : '',
          );
        const promptTokens = Number(payload.usage?.prompt_tokens || 0);
        const completionTokens = Number(payload.usage?.completion_tokens || 0);
        const rate = rates[profile.model] || { input: 0, output: 0 };
        results.push({
          profile: profile.name,
          model: profile.model,
          scenario: scenario.id,
          validJson: Boolean(parsed && typeof parsed.response === 'string'),
          asksKnownPhone,
          asksEmail,
          falseConfirmation,
          expectedIntent,
          semanticPass: semanticPass(scenario.id, customerResponse, {
            asksKnownPhone,
            asksEmail,
            falseConfirmation,
          }),
          latencyMs: Date.now() - started,
          promptTokens,
          completionTokens,
          estimatedCostUsd:
            (promptTokens * rate.input + completionTokens * rate.output) /
            1_000_000,
          customerResponse,
        });
      } catch (error) {
        results.push({
          profile: profile.name,
          model: profile.model,
          scenario: scenario.id,
          validJson: false,
          asksKnownPhone: false,
          asksEmail: false,
          falseConfirmation: false,
          expectedIntent: false,
          semanticPass: false,
          latencyMs: Date.now() - started,
          promptTokens: 0,
          completionTokens: 0,
          estimatedCostUsd: 0,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const summary = selectedProfiles.map((profile) => {
    const rows = results.filter((item) => item.profile === profile.name);
    return {
      profile: profile.name,
      model: profile.model,
      scenarios: rows.length,
      errors: rows.filter((item) => item.error).length,
      validJson: rows.filter((item) => item.validJson).length,
      asksKnownPhone: rows.filter((item) => item.asksKnownPhone).length,
      asksEmail: rows.filter((item) => item.asksEmail).length,
      falseConfirmations: rows.filter((item) => item.falseConfirmation).length,
      expectedIntent: rows.filter((item) => item.expectedIntent).length,
      semanticPass: rows.filter((item) => item.semanticPass).length,
      averageLatencyMs: Math.round(
        rows.reduce((sum, item) => sum + item.latencyMs, 0) / rows.length,
      ),
      tokens: rows.reduce(
        (sum, item) => sum + item.promptTokens + item.completionTokens,
        0,
      ),
      estimatedCostUsd: Number(
        rows.reduce((sum, item) => sum + item.estimatedCostUsd, 0).toFixed(6),
      ),
    };
  });
  const output =
    process.env.HERMES_BENCHMARK_DETAILS === 'true'
      ? { generatedAt: new Date().toISOString(), summary, results }
      : { generatedAt: new Date().toISOString(), summary };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

void run().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
