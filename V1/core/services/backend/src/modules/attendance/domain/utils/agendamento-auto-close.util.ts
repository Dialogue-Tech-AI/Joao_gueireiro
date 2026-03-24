/**
 * Timer de 30 min após FCs agendamento_*: fechar se não houver engajamento (humano ou cliente com mensagem substantiva).
 * "Apenas agradecimento" não cancela o timer.
 */

export const AGENDAMENTO_AUTO_CLOSE_MINUTES = 30;

export function buildAgendamentoTimerContext(
  aiContext: Record<string, unknown> | undefined | null,
  serviceKey: string
): Record<string, unknown> {
  const now = Date.now();
  const until = new Date(now + AGENDAMENTO_AUTO_CLOSE_MINUTES * 60 * 1000);
  return {
    ...(aiContext ?? {}),
    agendamentoTimerStartedAt: new Date(now).toISOString(),
    agendamentoAutoCloseAt: until.toISOString(),
    agendamentoTimerServiceKey: serviceKey,
  };
}

export function clearAgendamentoTimerFields(
  aiContext: Record<string, unknown> | undefined | null
): Record<string, unknown> {
  const ac = { ...(aiContext ?? {}) };
  delete ac.agendamentoAutoCloseAt;
  delete ac.agendamentoTimerStartedAt;
  delete ac.agendamentoTimerServiceKey;
  return ac;
}

/**
 * Mensagem curta só de agradecimento / confirmação leve (não cancela o timer de fechamento).
 * Mídia / texto longo = não é "só agradecimento".
 */
export function isLikelyOnlyThankYouMessage(text: string): boolean {
  const raw = text.trim();
  if (!raw) return true;
  if (raw.length > 160) return false;
  const lower = raw.toLowerCase();
  if (lower.startsWith('[') && raw.includes(']')) return false;

  const normalized = lower
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const tokens = normalized.split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  if (tokens.length > 14) return false;

  const thanks = new Set([
    'obrigado',
    'obrigada',
    'obg',
    'brigado',
    'brigada',
    'valeu',
    'vlw',
    'thanks',
    'thank',
    'you',
    'grato',
    'grata',
    'agradeço',
    'agradecemos',
    'agradecido',
    'agradecida',
    'muito',
    'por',
    'tudo',
  ]);

  return tokens.every((t) => thanks.has(t) || t.length <= 2);
}

export function isSubstantiveClientMessageForAgendamentoTimer(text: string): boolean {
  return !isLikelyOnlyThankYouMessage(text);
}
