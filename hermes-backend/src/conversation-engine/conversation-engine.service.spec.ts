import { ConfigService } from '@nestjs/config';
import { ConversationEngineService } from './conversation-engine.service';
import { ConversationEngineConfigurationError } from './conversation-engine.types';
import type { ConversationTurnInput } from './conversation-engine.types';
import { DirectGeminiEngine } from './direct-gemini.engine';
import { NousHermesEngine } from './nous-hermes.engine';

const input = (conversationId = 'conversation-1'): ConversationTurnInput => ({
  conversationId,
  inboundMessageId: 'inbound-1',
  customerMessage: 'Hola',
  approvedContext: {
    recentMessages: [],
    commercialProfile: {},
    approvedKnowledge: [],
    handoffActive: false,
    contactName: 'Cliente',
  },
});

describe('ConversationEngineService', () => {
  function setup(values: Record<string, string> = {}) {
    const directRespond = jest
      .fn()
      .mockResolvedValue({ engine: 'gemini_direct' });
    const nousRespond = jest.fn().mockResolvedValue({ engine: 'nous_hermes' });
    const directGemini = {
      id: 'gemini_direct',
      respond: directRespond,
    } as unknown as DirectGeminiEngine;
    const nousHermes = {
      id: 'nous_hermes',
      respond: nousRespond,
    } as unknown as NousHermesEngine;
    const config = {
      get: jest.fn((key: string, fallback?: string) => values[key] ?? fallback),
    } as unknown as ConfigService;
    return {
      service: new ConversationEngineService(config, directGemini, nousHermes),
      directRespond,
      nousRespond,
    };
  }

  it('uses gemini_direct by default without touching Nous', async () => {
    const { service, directRespond, nousRespond } = setup();

    await service.respond(input());

    expect(directRespond).toHaveBeenCalledTimes(1);
    expect(nousRespond).not.toHaveBeenCalled();
  });

  it('fails closed for an unknown engine flag', async () => {
    const { service, directRespond, nousRespond } = setup({
      HERMES_CONVERSATION_ENGINE: 'unexpected-provider',
    });

    await expect(service.respond(input())).rejects.toBeInstanceOf(
      ConversationEngineConfigurationError,
    );
    expect(directRespond).not.toHaveBeenCalled();
    expect(nousRespond).not.toHaveBeenCalled();
  });

  it('only selects Nous for an explicitly allowlisted conversation', async () => {
    const { service, directRespond, nousRespond } = setup({
      HERMES_CONVERSATION_ENGINE: 'nous_hermes',
      NOUS_HERMES_CONVERSATION_ALLOWLIST: 'conversation-canary',
    });

    await service.respond(input('conversation-not-allowed'));
    await service.respond(input('conversation-canary'));

    expect(directRespond).toHaveBeenCalledTimes(1);
    expect(nousRespond).toHaveBeenCalledTimes(1);
  });

  it('selects Nous for distinct inbound conversations only when open test mode is explicit', async () => {
    const { service, directRespond, nousRespond } = setup({
      HERMES_CONVERSATION_ENGINE: 'nous_hermes',
      NOUS_HERMES_OPEN_INBOUND_TEST: 'true',
    });
    await service.respond(input('conversation-a'));
    await service.respond(input('conversation-b'));
    expect(nousRespond).toHaveBeenCalledTimes(2);
    expect(directRespond).not.toHaveBeenCalled();
  });

  it('does not treat an empty allowlist or a non-true open flag as global consent', async () => {
    const { service, directRespond, nousRespond } = setup({
      HERMES_CONVERSATION_ENGINE: 'nous_hermes',
      NOUS_HERMES_OPEN_INBOUND_TEST: '1',
      NOUS_HERMES_CONVERSATION_ALLOWLIST: '',
    });
    await service.respond(input());
    expect(directRespond).toHaveBeenCalledTimes(1);
    expect(nousRespond).not.toHaveBeenCalled();
  });
});
