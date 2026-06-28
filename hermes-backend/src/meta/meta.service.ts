import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance } from 'axios';

export interface MetaSendResponse {
  messaging_product: string;
  contacts: { input: string; wa_id: string }[];
  messages: { id: string }[];
}

@Injectable()
export class MetaService {
  private readonly logger = new Logger(MetaService.name);
  private readonly httpClient: AxiosInstance;
  private readonly phoneNumberId: string;

  constructor(private readonly configService: ConfigService) {
    const accessToken = this.configService.get<string>('META_ACCESS_TOKEN', '');
    const apiVersion = this.configService.get<string>('META_API_VERSION', 'v21.0');
    this.phoneNumberId = this.configService.get<string>('META_PHONE_NUMBER_ID', '');

    this.httpClient = axios.create({
      baseURL: `https://graph.facebook.com/${apiVersion}/${this.phoneNumberId}`,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    });
  }

  /**
   * Envía un mensaje de texto por WhatsApp Cloud API
   */
  async sendTextMessage(to: string, text: string): Promise<MetaSendResponse | null> {
    try {
      const response = await this.httpClient.post<MetaSendResponse>('/messages', {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: text },
      });

      this.logger.log(`Mensaje enviado a ${to}, wamid: ${response.data.messages?.[0]?.id}`);
      return response.data;
    } catch (error: any) {
      this.logger.error(
        `Error enviando mensaje a ${to}: ${error.response?.data?.error?.message || error.message}`,
      );

      // Manejar rate limits
      if (error.response?.status === 429) {
        this.logger.warn('Rate limit alcanzado en Meta API, reintentando en 5s...');
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return this.sendTextMessage(to, text);
      }

      return null;
    }
  }

  /**
   * Envía un mensaje con plantilla (template) por WhatsApp Cloud API
   */
  async sendTemplateMessage(
    to: string,
    templateName: string,
    languageCode: string = 'es',
    components?: any[],
  ): Promise<MetaSendResponse | null> {
    try {
      const payload: any = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: {
          name: templateName,
          language: { code: languageCode },
        },
      };

      if (components?.length) {
        payload.template.components = components;
      }

      const response = await this.httpClient.post<MetaSendResponse>('/messages', payload);

      this.logger.log(`Template '${templateName}' enviado a ${to}`);
      return response.data;
    } catch (error: any) {
      this.logger.error(
        `Error enviando template a ${to}: ${error.response?.data?.error?.message || error.message}`,
      );
      return null;
    }
  }

  /**
   * Marca un mensaje como leído
   */
  async markAsRead(messageId: string): Promise<void> {
    try {
      await this.httpClient.post('/messages', {
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      });
    } catch (error: any) {
      this.logger.error(`Error marcando mensaje como leído: ${error.message}`);
    }
  }
}
