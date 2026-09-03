import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosError, AxiosInstance } from 'axios';

export interface MetaSendResponse { messaging_product: string; contacts: { input: string; wa_id: string }[]; messages: { id: string }[]; }
export interface MetaTemplate { id?: string; name: string; language: string; category?: string; status?: string; components?: unknown[]; }
export interface TemplateSendOptions { headerVideoMediaId?: string; headerVideoUrl?: string; bodyParameters?: string[]; buttonParameters?: unknown[]; }

@Injectable()
export class MetaService {
  private readonly logger = new Logger(MetaService.name);
  private readonly httpClient: AxiosInstance;
  private readonly graphClient: AxiosInstance;
  private readonly phoneNumberId: string;
  private readonly wabaId: string;

  constructor(private readonly config: ConfigService) {
    const accessToken = this.config.get<string>('META_ACCESS_TOKEN', '');
    const apiVersion = this.config.get<string>('META_API_VERSION', 'v21.0');
    this.phoneNumberId = this.config.get<string>('META_PHONE_NUMBER_ID', '');
    this.wabaId = this.config.get<string>('META_WABA_ID', '');
    const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
    this.httpClient = axios.create({ baseURL: `https://graph.facebook.com/${apiVersion}/${this.phoneNumberId}`, headers, timeout: 30000 });
    // Same service and server-only credentials; this base client serves WABA endpoints.
    this.graphClient = axios.create({ baseURL: `https://graph.facebook.com/${apiVersion}`, headers, timeout: 30000 });
  }

  async sendTextMessage(to: string, text: string): Promise<MetaSendResponse | null> {
    try {
      const response = await this.httpClient.post<MetaSendResponse>('/messages', { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body: text } });
      this.logger.log(`Mensaje enviado; wamid: ${response.data.messages?.[0]?.id}`);
      return response.data;
    } catch (error) {
      const safe = this.toSafeError(error);
      this.logger.error(`Error enviando mensaje: ${safe.code || 'META_ERROR'} ${safe.message}`);
      return null;
    }
  }

  async getApprovedMessageTemplates(): Promise<MetaTemplate[]> {
    if (!this.wabaId) throw new ServiceUnavailableException('META_WABA_ID no está configurado');
    try {
      const response = await this.graphClient.get<{ data?: MetaTemplate[] }>(`/${encodeURIComponent(this.wabaId)}/message_templates`, { params: { fields: 'id,name,language,category,status,components', limit: 250 } });
      return (response.data.data || []).filter((template) => template.status === 'APPROVED').map((template) => ({ id: template.id, name: template.name, language: template.language, category: template.category, status: template.status, components: template.components || [] }));
    } catch (error) {
      const safe = this.toSafeError(error);
      this.logger.error(`No se pudieron consultar plantillas: ${safe.code || 'META_ERROR'} ${safe.message}`);
      throw new ServiceUnavailableException('No se pudieron consultar las plantillas aprobadas de Meta');
    }
  }

  async sendTemplateMessage(to: string, templateName: string, languageCode = 'es', options: TemplateSendOptions = {}): Promise<MetaSendResponse> {
    const components: unknown[] = [];
    if (options.headerVideoMediaId && options.headerVideoUrl) throw new BadRequestException('Use media ID o URL, no ambos');
    if (options.headerVideoMediaId) components.push({ type: 'header', parameters: [{ type: 'video', video: { id: options.headerVideoMediaId } }] });
    if (options.headerVideoUrl) {
      if (!this.isSafeMediaUrl(options.headerVideoUrl)) throw new BadRequestException('La URL multimedia no está permitida');
      components.push({ type: 'header', parameters: [{ type: 'video', video: { link: options.headerVideoUrl } }] });
    }
    if (options.bodyParameters?.length) components.push({ type: 'body', parameters: options.bodyParameters.map((text) => ({ type: 'text', text })) });
    if (options.buttonParameters?.length) components.push(...options.buttonParameters);
    const payload: Record<string, unknown> = { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'template', template: { name: templateName, language: { code: languageCode }, ...(components.length ? { components } : {}) } };
    const response = await this.httpClient.post<MetaSendResponse>('/messages', payload);
    return response.data;
  }

  isSafeMediaUrl(value: string): boolean {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname.length > 1800) return false;
      const allowedHosts = (this.config.get<string>('CAMPAIGN_MEDIA_ALLOWED_HOSTS', '') || '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
      return allowedHosts.includes(url.hostname.toLowerCase());
    } catch { return false; }
  }

  toSafeError(error: unknown): { retryable: boolean; code: string | null; message: string } {
    const axiosError = error as AxiosError<{ error?: { code?: number; message?: string } }>;
    const status = axiosError.response?.status;
    const code = axiosError.response?.data?.error?.code;
    const raw = axiosError.response?.data?.error?.message || axiosError.message || 'Error de Meta';
    const message = raw.replace(/[\r\n]/g, ' ').slice(0, 500);
    return { retryable: !status || status === 429 || status >= 500, code: code ? String(code) : status ? String(status) : null, message };
  }

  async markAsRead(messageId: string): Promise<void> {
    try { await this.httpClient.post('/messages', { messaging_product: 'whatsapp', status: 'read', message_id: messageId }); }
    catch (error) { this.logger.error(`Error marcando mensaje como leído: ${this.toSafeError(error).message}`); }
  }
}
