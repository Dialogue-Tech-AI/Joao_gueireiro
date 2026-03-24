/**
 * Follow-up automático aplica-se ao fluxo AI em Abertos e a encaminhados.
 * Intervenção humana (FC para prótese, outros assuntos, manutenção telefone fixo) fica fora do funil.
 */
export const FOLLOW_UP_ALLOWED_INTERVENTION_TYPES = ['encaminhados-ecommerce', 'encaminhados-balcao'] as const;

export function canReceiveFollowUp(interventionType: string | null | undefined): boolean {
  if (interventionType == null || interventionType === '') return true;
  return (FOLLOW_UP_ALLOWED_INTERVENTION_TYPES as readonly string[]).includes(interventionType);
}
