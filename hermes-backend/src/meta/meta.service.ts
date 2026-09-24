import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';

export interface MetaSendResponse {
  messaging_product: string;
  contacts: { input: string; wa_id: string }[];
  messages: { id: string }[];
}
export type MetaSendOutcome = 'DEFINITIVE_REJECTION' | 'AMBIGUOUS';

export class MetaSendError extends ServiceUnavailableException {
  constructor(
    public readonly outcome: MetaSendOutcome,
    public readonly retryable: boolean,
    public readonly providerStatus: number | null,
    public readonly safeCode: string,
  ) {
    super('Meta no pudo confirmar el envío del mensaje');
  }
}

export class MetaMediaUploadError extends ServiceUnavailableException {
  public readonly reasonCode = 'META_MEDIA_UPLOAD_FAILED';

  constructor(public readonly providerStatus: number | null) {
    super('Meta no pudo cargar la nota de voz');
    this.name = 'MetaMediaUploadError';
  }
}
export interface MetaTemplate {
  id?: string;
  name: string;
  language: string;
  category?: string;
  status?: string;
  components?: unknown[];
}
export interface TemplateSendOptions {
  headerVideoMediaId?: string;
  headerVideoUrl?: string;
  bodyParameters?: string[];
  buttonParameters?: unknown[];
}
export interface MetaUploadedMedia {
  id: string;
}
export interface MetaMediaMetadata {
  id: string;
  mime_type?: string;
  file_size?: number;
  url?: string;
}

@Injectable()
export class MetaService {
  private readonly logger = new Logger(MetaService.name);
  private readonly httpClient: AxiosInstance;
  private readonly graphClient: AxiosInstance;
  private readonly phoneNumberId: string;
  private readonly wabaId: string;
  private readonly apiVersion: string;

  constructor(private readonly config: ConfigService) {
    const accessToken = this.config.get<string>('META_ACCESS_TOKEN', '');
    this.apiVersion = this.config.get<string>('META_API_VERSION', 'v21.0');
    this.phoneNumberId = this.config.get<string>('META_PHONE_NUMBER_ID', '');
    this.wabaId = this.config.get<string>('META_WABA_ID', '');
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };
    this.httpClient = axios.create({
      baseURL: `https://graph.facebook.com/${this.apiVersion}/${this.phoneNumberId}`,
      headers,
      timeout: 30000,
    });
    // Same service and server-only credentials; this base client serves WABA endpoints.
    this.graphClient = axios.create({
      baseURL: `https://graph.facebook.com/${this.apiVersion}`,
      headers,
      timeout: 30000,
    });
  }

  getConfiguredWabaId(): string {
    if (!this.wabaId)
      throw new ServiceUnavailableException('META_WABA_ID no está configurado');
    return this.wabaId;
  }

  async sendTextMessage(to: string, text: string): Promise<MetaSendResponse> {
    let data: MetaSendResponse;
    try {
      const response = await this.httpClient.post<MetaSendResponse>(
        '/messages',
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body: text },
        },
      );
      data = response.data;
    } catch (error) {
      const safe = this.toSafeError(error);
      const definitive =
        safe.status !== null && safe.status >= 400 && safe.status < 500;
      const failure = new MetaSendError(
        definitive ? 'DEFINITIVE_REJECTION' : 'AMBIGUOUS',
        safe.status === 429,
        safe.status,
        safe.status ? `META_HTTP_${safe.status}` : 'META_TRANSPORT_ERROR',
      );
      this.logger.error(
        `Error enviando mensaje: ${failure.safeCode} ${failure.outcome}`,
      );
      throw failure;
    }
    const wamid = data.messages?.[0]?.id;
    if (!wamid) {
      const failure = new MetaSendError(
        'AMBIGUOUS',
        false,
        200,
        'META_WAMID_MISSING',
      );
      this.logger.error(`${failure.safeCode} ${failure.outcome}`);
      throw failure;
    }
    this.logger.log(`Mensaje enviado; wamid: ${wamid}`);
    return data;
  }

  async getApprovedMessageTemplates(): Promise<MetaTemplate[]> {
    if (!this.wabaId)
      throw new ServiceUnavailableException('META_WABA_ID no está configurado');
    try {
      const response = await this.graphClient.get<{ data?: MetaTemplate[] }>(
        `/${encodeURIComponent(this.wabaId)}/message_templates`,
        {
          params: {
            fields: 'id,name,language,category,status,components',
            limit: 250,
          },
        },
      );
      return (response.data.data || [])
        .filter((template) => template.status === 'APPROVED')
        .map((template) => ({
          id: template.id,
          name: template.name,
          language: template.language,
          category: template.category,
          status: template.status,
          components: template.components || [],
        }));
    } catch (error) {
      const safe = this.toSafeError(error);
      this.logger.error(
        `No se pudieron consultar plantillas: ${safe.code || 'META_ERROR'} ${safe.message}`,
      );
      throw new ServiceUnavailableException(
        'No se pudieron consultar las plantillas aprobadas de Meta',
      );
    }
  }

  async sendTemplateMessage(
    to: string,
    templateName: string,
    languageCode = 'es',
    options: TemplateSendOptions = {},
  ): Promise<MetaSendResponse> {
    const components: unknown[] = [];
    if (options.headerVideoMediaId && options.headerVideoUrl)
      throw new BadRequestException('Use media ID o URL, no ambos');
    if (options.headerVideoMediaId)
      components.push({
        type: 'header',
        parameters: [
          { type: 'video', video: { id: options.headerVideoMediaId } },
        ],
      });
    if (options.headerVideoUrl) {
      if (!this.isSafeMediaUrl(options.headerVideoUrl))
        throw new BadRequestException('La URL multimedia no está permitida');
      components.push({
        type: 'header',
        parameters: [
          { type: 'video', video: { link: options.headerVideoUrl } },
        ],
      });
    }
    if (options.bodyParameters?.length)
      components.push({
        type: 'body',
        parameters: options.bodyParameters.map((text) => ({
          type: 'text',
          text,
        })),
      });
    if (options.buttonParameters?.length)
      components.push(...options.buttonParameters);
    const payload: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        ...(components.length ? { components } : {}),
      },
    };
    const response = await this.httpClient.post<MetaSendResponse>(
      '/messages',
      payload,
    );
    return response.data;
  }

  async uploadCampaignVideo(file: {
    buffer: Buffer;
    mimetype: string;
    originalname: string;
  }): Promise<MetaUploadedMedia> {
    if (!this.phoneNumberId)
      throw new ServiceUnavailableException(
        'META_PHONE_NUMBER_ID no está configurado',
      );
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    const bytes = file.buffer.buffer.slice(
      file.buffer.byteOffset,
      file.buffer.byteOffset + file.buffer.byteLength,
    ) as ArrayBuffer;
    form.append(
      'file',
      new Blob([bytes], { type: file.mimetype }),
      file.originalname,
    );
    try {
      const response = await this.httpClient.post<MetaUploadedMedia>(
        '/media',
        form,
        {
          headers: { 'Content-Type': 'multipart/form-data' },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
        },
      );
      if (!response.data?.id) throw new Error('Meta no devolvió un Media ID');
      return response.data;
    } catch (error) {
      const safe = this.toSafeError(error);
      this.logger.error(
        `No se pudo cargar el video de campaña: ${safe.code || 'META_ERROR'} ${safe.message}`,
      );
      throw new ServiceUnavailableException('Meta no pudo cargar el video');
    }
  }

  async getCampaignMediaMetadata(mediaId: string): Promise<MetaMediaMetadata> {
    try {
      const response = await this.graphClient.get<MetaMediaMetadata>(
        `/${encodeURIComponent(mediaId)}`,
        { params: { fields: 'id,mime_type,file_size' } },
      );
      return response.data;
    } catch (error) {
      const safe = this.toSafeError(error);
      this.logger.error(
        `No se pudo verificar el Media ID: ${safe.code || 'META_ERROR'} ${safe.message}`,
      );
      throw new BadRequestException(
        'El Media ID no es accesible desde el WABA configurado',
      );
    }
  }

  async downloadInboundAudio(
    mediaId: string,
    maxBytes: number,
  ): Promise<{
    bytes: Buffer;
    mimeType: string;
  }> {
    const metadata = await this.graphClient.get<MetaMediaMetadata>(
      `/${encodeURIComponent(mediaId)}`,
      {
        params: {
          fields: 'id,mime_type,file_size,url',
          phone_number_id: this.phoneNumberId,
        },
      },
    );
    const { url, mime_type: mimeType, file_size: size } = metadata.data;
    if (!url || !mimeType?.startsWith('audio/') || (size && size > maxBytes))
      throw new BadRequestException(
        'Audio de Meta no válido o demasiado grande',
      );
    const parsed = new URL(url);
    if (
      parsed.protocol !== 'https:' ||
      parsed.hostname !== 'lookaside.fbsbx.com' ||
      parsed.username ||
      parsed.password
    )
      throw new BadRequestException('Host de descarga de Meta no permitido');
    const response = await axios.get<ArrayBuffer>(url, {
      headers: {
        Authorization: `Bearer ${this.config.get<string>('META_ACCESS_TOKEN', '')}`,
      },
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: maxBytes,
      maxRedirects: 0,
    });
    const bytes = Buffer.from(response.data);
    if (!bytes.length || bytes.length > maxBytes)
      throw new BadRequestException('Audio de Meta vacío o demasiado grande');
    return { bytes, mimeType };
  }

  async uploadVoiceNote(oggOpus: Buffer): Promise<string> {
    if (!oggOpus.length || oggOpus.length > 16 * 1024 * 1024)
      throw new BadRequestException('Nota de voz inválida o demasiado grande');
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    const bytes = oggOpus.buffer.slice(
      oggOpus.byteOffset,
      oggOpus.byteOffset + oggOpus.byteLength,
    ) as ArrayBuffer;
    form.append(
      'file',
      new Blob([bytes], { type: 'audio/ogg; codecs=opus' }),
      'voice.ogg',
    );
    let response: { data: MetaUploadedMedia };
    try {
      response = await this.httpClient.post<MetaUploadedMedia>('/media', form, {
        timeout: 30000,
        maxBodyLength: 16 * 1024 * 1024,
      });
    } catch (error) {
      if (!axios.isAxiosError(error)) throw error;
      this.logger.error(
        JSON.stringify(this.voiceMediaUploadDiagnostics(error, oggOpus.length)),
      );
      throw new MetaMediaUploadError(error.response?.status ?? null);
    }
    if (!response.data?.id) throw new Error('Meta no devolvió Media ID');
    return response.data.id;
  }

  async sendVoiceNote(to: string, mediaId: string): Promise<MetaSendResponse> {
    try {
      const response = await this.httpClient.post<MetaSendResponse>(
        '/messages',
        {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'audio',
          audio: { id: mediaId, voice: true },
        },
      );
      if (!response.data.messages?.[0]?.id)
        throw new MetaSendError('AMBIGUOUS', false, 200, 'META_WAMID_MISSING');
      return response.data;
    } catch (error) {
      if (error instanceof MetaSendError) throw error;
      const safe = this.toSafeError(error);
      throw new MetaSendError(
        safe.status !== null && safe.status >= 400 && safe.status < 500
          ? 'DEFINITIVE_REJECTION'
          : 'AMBIGUOUS',
        safe.status === 429,
        safe.status,
        safe.status ? `META_HTTP_${safe.status}` : 'META_TRANSPORT_ERROR',
      );
    }
  }

  isSafeMediaUrl(value: string): boolean {
    try {
      const url = new URL(value);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.port ||
        url.pathname.length > 1800
      )
        return false;
      const allowedHosts = (
        this.config.get<string>('CAMPAIGN_MEDIA_ALLOWED_HOSTS', '') || ''
      )
        .split(',')
        .map((host) => host.trim().toLowerCase())
        .filter(Boolean);
      return allowedHosts.includes(url.hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  toSafeError(error: unknown): {
    retryable: boolean;
    status: number | null;
    code: string | null;
    message: string;
  } {
    const axiosError = error as AxiosError<{
      error?: { code?: number; message?: string };
    }>;
    const status = axiosError.response?.status;
    const code = axiosError.response?.data?.error?.code;
    const raw =
      axiosError.response?.data?.error?.message ||
      axiosError.message ||
      'Error de Meta';
    const message = raw.replace(/[\r\n]/g, ' ').slice(0, 500);
    return {
      retryable: !status || status === 429 || status >= 500,
      status: status || null,
      code: code ? String(code) : status ? String(status) : null,
      message,
    };
  }

  private voiceMediaUploadDiagnostics(
    error: AxiosError<unknown>,
    audioBytes: number,
  ): Record<string, string | number | null> {
    const responseData = this.isRecord(error.response?.data)
      ? error.response.data
      : undefined;
    const metaError = this.isRecord(responseData?.error)
      ? responseData.error
      : undefined;
    const headers = error.response?.headers;
    return {
      event: 'meta_voice_media_upload_failed',
      httpStatus: this.safeHttpStatus(error.response?.status),
      metaErrorType: this.safeDiagnosticText(metaError?.type),
      metaErrorCode: this.safeDiagnosticText(metaError?.code),
      metaErrorSubcode: this.safeDiagnosticText(metaError?.error_subcode),
      metaErrorMessage: this.safeDiagnosticText(metaError?.message),
      fbtraceId: this.safeIdentifier(metaError?.fbtrace_id, 160),
      transportCode: this.safeIdentifier(error.code, 80),
      transportMessage: this.safeDiagnosticText(error.message),
      requestId: this.requestId(headers),
      responseContentType: this.safeContentType(
        this.headerValue(headers, 'content-type'),
      ),
      audioMimeType: 'audio/ogg',
      audioBytes,
      filename: 'voice.ogg',
      graphApiVersion: this.safeIdentifier(this.apiVersion, 30),
    };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
  }

  private safeHttpStatus(value: unknown): number | null {
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < 100 ||
      value > 599
    )
      return null;
    return value;
  }

  private safeIdentifier(value: unknown, maxLength: number): string | null {
    if (typeof value !== 'string') return null;
    const text = value.trim();
    return /^[A-Za-z0-9._-]+$/u.test(text) && text.length <= maxLength
      ? text
      : null;
  }

  private safeContentType(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const text = value.split(';', 1)[0]?.trim().toLowerCase();
    return text && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(text) ? text : null;
  }

  private safeDiagnosticText(value: unknown): string | null {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value)
      .replace(/https?:\/\/[^\s"'<>]+/giu, '[url redacted]')
      .replace(/\+?\d(?:[\s().-]*\d){7,14}/gu, '[phone redacted]')
      .replace(
        /((?:["']?)(?:xi[-_]?api[-_]?key|authorization|api[-_]?key|access[-_]?token|token|x-amz-signature|signature|sig)(?:["']?)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}\]]+)/giu,
        '$1[redacted]',
      )
      .replace(/bearer\s+\S+/giu, 'Bearer [redacted]')
      .trim();
    return text ? text.slice(0, 240) : null;
  }

  private headerValue(headers: unknown, name: string): unknown {
    if (!headers || typeof headers !== 'object') return undefined;
    const get = (headers as { get?: unknown }).get;
    if (typeof get === 'function') return get.call(headers, name);
    const record = headers as Record<string, unknown>;
    return record[name] ?? record[name.toLowerCase()];
  }

  private requestId(headers: unknown): string | null {
    for (const name of [
      'request-id',
      'x-request-id',
      'x-fb-request-id',
      'x-correlation-id',
      'x-trace-id',
    ]) {
      const requestId = this.safeIdentifier(
        this.headerValue(headers, name),
        160,
      );
      if (requestId) return requestId;
    }
    return null;
  }

  async markAsRead(messageId: string): Promise<void> {
    try {
      await this.httpClient.post('/messages', {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      });
    } catch (error) {
      this.logger.error(
        `Error marcando mensaje como leído: ${this.toSafeError(error).message}`,
      );
    }
  }

  async showTypingIndicator(messageId: string): Promise<void> {
    if (!messageId) return;
    try {
      await this.httpClient.post('/messages', {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
        typing_indicator: { type: 'text' },
      });
    } catch (error) {
      this.logger.warn(
        `No se pudo mostrar el indicador de escritura: ${this.toSafeError(error).message}`,
      );
    }
  }
}
