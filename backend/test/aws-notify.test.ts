import { SNSClient } from '@aws-sdk/client-sns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SnsEmailTopic } from '../src/aws/cloudRuntime.js';

describe('correo vía SNS (alternativa a SES en AWS Academy)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('publica en el tema con el atributo recipient para la política de filtro', async () => {
    const spy = vi.spyOn(SNSClient.prototype, 'send').mockResolvedValue({ MessageId: 'm-1' } as never);
    const p = new SnsEmailTopic('arn:aws:sns:us-east-1:123456789012:telecorp-sentinel-dev-notificaciones');
    const r = await p.send('Persona@Example.com', 'Asunto de prueba', 'Cuerpo');
    expect(r.providerMessageId).toBe('m-1');
    const input = (spy.mock.calls[0][0] as { input: Record<string, any> }).input;
    expect(input.TopicArn).toContain('notificaciones');
    expect(input.MessageAttributes.recipient).toEqual({ DataType: 'String', StringValue: 'persona@example.com' });
    expect(input.Subject).toBe('Asunto de prueba');
  });
});
