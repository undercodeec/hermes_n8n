import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export type GuardDecision =
  | { action: 'ALLOW' }
  | {
      action: 'BLOCK';
      category: 'SPAM' | 'MODERATION' | 'OUT_OF_SCOPE';
      notice?: string;
    }
  | { action: 'SUPPORT'; notice: string };

@Injectable()
export class ConversationGuardService implements OnModuleDestroy {
  private readonly logger = new Logger(ConversationGuardService.name);
  private client?: Redis;

  constructor(private readonly config: ConfigService) {}

  async inspect(
    contactId: string,
    content: string,
    supportContext = content,
  ): Promise<GuardDecision> {
    const normalized = this.normalize(content);
    if (this.isSupportRequest(this.normalize(supportContext))) {
      return { action: 'SUPPORT', notice: this.supportNotice() };
    }

    const moderation = this.moderationNotice(normalized);
    if (moderation) {
      return {
        action: moderation.category === 'OUT_OF_SCOPE' ? 'BLOCK' : 'BLOCK',
        category: moderation.category,
        notice: (await this.claimNotice(contactId, moderation.category))
          ? moderation.notice
          : undefined,
      };
    }

    if (content.length > this.positiveInteger('AI_MAX_INPUT_CHARS', 2000)) {
      return {
        action: 'BLOCK',
        category: 'SPAM',
        notice: (await this.claimNotice(contactId, 'LONG_INPUT'))
          ? 'Por favor, envíanos una consulta breve sobre nuestros servicios para poder ayudarte.'
          : undefined,
      };
    }

    if (this.hasExcessiveLinks(content)) {
      return { action: 'BLOCK', category: 'SPAM' };
    }

    try {
      const key = `hermes:guard:messages:${contactId}`;
      const count = await this.incrementWithExpiry(
        key,
        this.positiveInteger('AI_CONTACT_MESSAGES_WINDOW_SECONDS', 600),
      );
      if (
        count > this.positiveInteger('AI_CONTACT_MAX_MESSAGES_PER_WINDOW', 15)
      ) {
        await this.setCooldown(contactId);
        return {
          action: 'BLOCK',
          category: 'SPAM',
          notice: (await this.claimNotice(contactId, 'RATE_LIMIT'))
            ? 'Recibimos varios mensajes seguidos. Cuando estés listo, envíanos una sola consulta sobre nuestros servicios.'
            : undefined,
        };
      }

      const cooldown = await (
        await this.redis()
      ).get(`hermes:guard:cooldown:${contactId}`);
      return cooldown
        ? { action: 'BLOCK', category: 'SPAM' }
        : { action: 'ALLOW' };
    } catch (error) {
      this.logger.error(
        'No se pudo evaluar el límite anti-spam',
        error instanceof Error ? error.stack : undefined,
      );
      return this.failClosed()
        ? { action: 'BLOCK', category: 'SPAM' }
        : { action: 'ALLOW' };
    }
  }

  async consumeAiQuota(contactId: string): Promise<boolean> {
    try {
      const now = new Date();
      const contactKey = `hermes:guard:ai-contact:${contactId}:${now.toISOString().slice(0, 10)}`;
      const globalKey = `hermes:guard:ai-global:${now.toISOString().slice(0, 13)}`;
      const [contactCount, globalCount] = await Promise.all([
        this.incrementWithExpiry(contactKey, 26 * 3600),
        this.incrementWithExpiry(globalKey, 2 * 3600),
      ]);
      const contactLimit = this.positiveInteger(
        'AI_CONTACT_DAILY_REPLY_LIMIT',
        60,
      );
      const globalLimit = this.positiveInteger(
        'AI_GLOBAL_HOURLY_REPLY_LIMIT',
        500,
      );
      if (contactCount > contactLimit || globalCount > globalLimit) {
        this.logger.warn(
          `Cuota de IA excedida para ${contactCount > contactLimit ? 'contacto' : 'instancia'}; no se invocará Gemini`,
        );
        return false;
      }
      return true;
    } catch (error) {
      this.logger.error(
        'No se pudo evaluar la cuota de IA',
        error instanceof Error ? error.stack : undefined,
      );
      return !this.failClosed();
    }
  }

  isSafeGeneratedResponse(content: string): boolean {
    if (
      !content ||
      content.length > this.positiveInteger('AI_MAX_OUTPUT_CHARS', 900)
    ) {
      return false;
    }
    if (this.looksLikeStructuredPayload(content)) return false;
    return !this.moderationNotice(this.normalize(content));
  }

  private looksLikeStructuredPayload(content: string): boolean {
    const trimmed = content.trim();
    if (/^```(?:json)?\s*/i.test(trimmed)) return true;
    return /^\{\s*["']?(response|detectedIntent|detected_intent|suggestedTags|suggested_tags|nextAction|next_action)\b/i.test(
      trimmed,
    );
  }

  private moderationNotice(
    normalized: string,
  ): { category: 'MODERATION' | 'OUT_OF_SCOPE'; notice: string } | undefined {
    if (
      this.matches(normalized, [
        /\b(porno|pornografia|sexo explicito|desnuda|desnudo|onlyfans|nudes?)\b/,
        /\b(te voy a matar|amenaza|matarte|violacion|violar)\b/,
        /\b(puta|puto|mierda|imbecil|idiota|estupido|pendejo)\b/,
      ])
    ) {
      return {
        category: 'MODERATION',
        notice:
          'Podemos atenderte únicamente sobre nuestros servicios. Si tienes una consulta comercial, cuéntanos en qué podemos ayudarte.',
      };
    }
    if (
      this.matches(normalized, [
        /\b(ignora|olvida|revela|muestra).{0,50}\b(instrucciones|prompt|sistema|reglas)\b/,
        /\b(actua como|comportate como).{0,40}\b(sistema|administrador|desarrollador)\b/,
      ])
    ) {
      return {
        category: 'OUT_OF_SCOPE',
        notice:
          'Por este canal atendemos consultas sobre nuestros servicios. ¿En qué podemos ayudarte?',
      };
    }
    return undefined;
  }

  private isSupportRequest(normalized: string): boolean {
    const reportsTechnicalProblem =
      this.matches(normalized, [
        /\b(no funciona|no carga|se cayo|caido|error|problema|fall[ao]|lento|no abre|sin acceso|no llega)\b/,
      ]) &&
      this.matches(normalized, [
        /\b(web|pagina|sitio|dominio|hosting|formulario|correo|sistema|proyecto)\b/,
      ]);
    const confirmsOurWork = this.matches(normalized, [
      /\b(ustedes|su equipo|undercodeec|hermes)\b.{0,60}\b(hicieron|desarrollaron|crearon|realizaron|implementaron)\b/,
      /\b(web|pagina|sitio|proyecto|sistema)\b.{0,60}\b(que ustedes|que su equipo|que undercodeec|que hermes)\b.{0,30}\b(hicieron|desarrollaron|crearon|realizaron|implementaron)\b/,
    ]);
    return reportsTechnicalProblem && confirmsOurWork;
  }

  private supportNotice(): string {
    const phone = this.config.get<string>(
      'SUPPORT_PHONE_E164',
      '+593979046329',
    );
    const digits = phone.replace(/\D/g, '');
    return `Entiendo. Para que soporte lo revise, escríbenos al ${phone} con la URL y el detalle del problema. También puedes abrir https://wa.me/${digits}.`;
  }

  private hasExcessiveLinks(content: string): boolean {
    return (content.match(/https?:\/\/\S+/gi) || []).length > 3;
  }

  private normalize(value: string): string {
    return value
      .toLocaleLowerCase('es')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private matches(value: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(value));
  }

  private async claimNotice(
    contactId: string,
    category: string,
  ): Promise<boolean> {
    try {
      const seconds = this.positiveInteger(
        'AI_GUARD_NOTICE_COOLDOWN_SECONDS',
        1800,
      );
      const result = await (
        await this.redis()
      ).set(
        `hermes:guard:notice:${category}:${contactId}`,
        '1',
        'EX',
        seconds,
        'NX',
      );
      return result === 'OK';
    } catch (error) {
      this.logger.error(
        'No se pudo registrar aviso de moderación',
        error instanceof Error ? error.stack : undefined,
      );
      return false;
    }
  }

  private async setCooldown(contactId: string): Promise<void> {
    await (
      await this.redis()
    ).set(
      `hermes:guard:cooldown:${contactId}`,
      '1',
      'EX',
      this.positiveInteger('SPAM_COOLDOWN_SECONDS', 1800),
    );
  }

  private async incrementWithExpiry(
    key: string,
    seconds: number,
  ): Promise<number> {
    const transaction = (await this.redis()).multi();
    transaction.incr(key);
    transaction.expire(key, seconds, 'NX');
    const results = await transaction.exec();
    const count = results?.[0]?.[1];
    if (typeof count !== 'number')
      throw new Error('Redis no devolvió un contador válido');
    return count;
  }

  private async redis(): Promise<Redis> {
    if (!this.client) {
      const url = this.config.get<string>('REDIS_URL');
      if (!url)
        throw new Error('REDIS_URL es obligatorio para ConversationGuard');
      this.client = new Redis(url, {
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      });
      this.client.on('error', (error) => {
        this.logger.warn(`Redis anti-spam no disponible: ${error.message}`);
      });
    }
    if (this.client.status === 'wait') await this.client.connect();
    return this.client;
  }

  private failClosed(): boolean {
    return this.config.get<string>('AI_GUARD_FAIL_CLOSED', 'true') !== 'false';
  }

  private positiveInteger(key: string, fallback: number): number {
    const value = Number(this.config.get(key));
    return Number.isSafeInteger(value) && value > 0 ? value : fallback;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client && this.client.status !== 'end') await this.client.quit();
  }
}
