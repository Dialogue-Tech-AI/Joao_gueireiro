import React from 'react';
import type { FollowUpConfig } from '../../services/ai-config.service';

interface FollowUpConfigTabProps {
  followUpConfig: FollowUpConfig;
  setFollowUpConfig: (value: FollowUpConfig) => void;
  isLoading: boolean;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

export const FollowUpConfigTab: React.FC<FollowUpConfigTabProps> = ({
  followUpConfig,
  setFollowUpConfig,
  isLoading,
  isSaving,
  onSave,
}) => {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden" style={{ backgroundColor: '#FFFFFF' }}>
      <div className="p-6 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center" style={{ backgroundColor: '#FEE4E2' }}>
            <span className="material-icons-outlined text-primary" style={{ color: '#F07000' }}>schedule_send</span>
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white" style={{ color: '#0F172A', fontWeight: 700 }}>
              Mensagens de Follow-up (Inatividade)
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
              Configure os tempos e mensagens enviadas automaticamente quando o cliente fica inativo (sem responder).
            </p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <span className="material-icons-outlined text-slate-400 animate-spin">refresh</span>
            <span className="ml-2 text-sm text-slate-500">Carregando configurações...</span>
          </div>
        ) : (
          <div className="space-y-6">
            <div
              className="flex items-center justify-between p-4 rounded-lg border border-slate-200 dark:border-slate-700"
              style={{ backgroundColor: followUpConfig.enabled ? '#F0FDF4' : '#FEF2F2' }}
            >
              <div className="flex items-center gap-3 min-w-0">
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0"
                  style={{ backgroundColor: followUpConfig.enabled ? '#DCFCE7' : '#FEE2E2' }}
                >
                  <span
                    className="material-icons-outlined"
                    style={{ color: followUpConfig.enabled ? '#16A34A' : '#DC2626' }}
                  >
                    {followUpConfig.enabled ? 'toggle_on' : 'toggle_off'}
                  </span>
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900 dark:text-white" style={{ color: '#0F172A' }}>
                    {followUpConfig.enabled ? 'Sistema de follow-up ligado' : 'Sistema de follow-up desligado'}
                  </p>
                  <p className="text-xs text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
                    {followUpConfig.enabled
                      ? 'Mensagens automáticas e fechamento por inatividade estão ativos conforme os tempos abaixo.'
                      : 'Nenhuma mensagem de follow-up é enviada e o fluxo automático de fechamento por follow-up não corre. Clique em Salvar para aplicar.'}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setFollowUpConfig({ ...followUpConfig, enabled: !followUpConfig.enabled })}
                disabled={isSaving || isLoading}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors ${
                  followUpConfig.enabled ? 'bg-primary' : 'bg-slate-300'
                } ${isSaving || isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
                style={{ backgroundColor: followUpConfig.enabled ? '#F07000' : '#CBD5E1' }}
                aria-pressed={followUpConfig.enabled}
                aria-label={followUpConfig.enabled ? 'Desligar follow-up' : 'Ligar follow-up'}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                    followUpConfig.enabled ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            {!followUpConfig.enabled && (
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
                <div className="flex items-start gap-2">
                  <span className="material-icons-outlined text-amber-700 dark:text-amber-400 text-lg shrink-0">warning</span>
                  <p className="text-sm text-amber-900 dark:text-amber-200">
                    Com o follow-up desligado, o job de inatividade não envia o 1.º nem o 2.º follow-up nem move atendimentos para fechados por esse fluxo. As configurações abaixo permanecem guardadas para quando voltar a ligar.
                  </p>
                </div>
              </div>
            )}

            {/* Tempos */}
            <div
              className={`bg-slate-50 dark:bg-slate-800 rounded-lg p-4 ${!followUpConfig.enabled ? 'opacity-60' : ''}`}
              style={{ backgroundColor: '#F8FAFC' }}
            >
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4" style={{ color: '#475569' }}>
                Tempos (em minutos)
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Tempo até 1ª mensagem
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      max="1440"
                      value={followUpConfig.firstDelayMinutes ?? ''}
                      onChange={(e) => {
                        const v = e.target.value === '' ? undefined : Math.min(1440, Math.max(1, parseInt(e.target.value, 10) || 0));
                        setFollowUpConfig({ ...followUpConfig, firstDelayMinutes: v ?? 60 });
                      }}
                      className="w-full px-3 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                      style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                    />
                    <span className="text-xs text-slate-500 whitespace-nowrap">min</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Tempo até 2ª mensagem
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      max="10080"
                      value={followUpConfig.secondDelayMinutes ?? ''}
                      onChange={(e) => {
                        const v = e.target.value === '' ? undefined : Math.min(10080, Math.max(1, parseInt(e.target.value, 10) || 0));
                        setFollowUpConfig({ ...followUpConfig, secondDelayMinutes: v ?? 1440 });
                      }}
                      className="w-full px-3 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                      style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                    />
                    <span className="text-xs text-slate-500 whitespace-nowrap">min</span>
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-600 dark:text-slate-400 mb-1">
                    Tempo até fechamento automático
                  </label>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="60"
                      max="43200"
                      value={followUpConfig.closeDelayMinutes ?? ''}
                      onChange={(e) => {
                        const v = e.target.value === '' ? undefined : Math.min(43200, Math.max(60, parseInt(e.target.value, 10) || 60));
                        setFollowUpConfig({ ...followUpConfig, closeDelayMinutes: v ?? 2160 });
                      }}
                      className="w-full px-3 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                      style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                    />
                    <span className="text-xs text-slate-500 whitespace-nowrap">min</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Mensagens */}
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                  Mensagem do 1º follow-up
                </label>
                <textarea
                  value={followUpConfig.firstMessage ?? ''}
                  onChange={(e) => setFollowUpConfig({ ...followUpConfig, firstMessage: e.target.value })}
                  rows={4}
                  placeholder="Ex: Olá! Percebi que você não respondeu. Posso ajudar em algo?"
                  className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none resize-y"
                  style={{ backgroundColor: '#F8FAFC', color: '#0F172A' }}
                />
              </div>
              <div>
                <label className="block text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2" style={{ color: '#475569' }}>
                  Mensagem do 2º follow-up
                </label>
                <textarea
                  value={followUpConfig.secondMessage ?? ''}
                  onChange={(e) => setFollowUpConfig({ ...followUpConfig, secondMessage: e.target.value })}
                  rows={4}
                  placeholder="Ex: Ainda estou por aqui caso precise de ajuda. Caso contrário, encerrarei o atendimento."
                  className="w-full px-4 py-3 bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none resize-y"
                  style={{ backgroundColor: '#F8FAFC', color: '#0F172A' }}
                />
              </div>
            </div>

            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <div className="flex items-start gap-2">
                <span className="material-icons-outlined text-blue-600 dark:text-blue-400 text-lg">info</span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-blue-800 dark:text-blue-300 mb-2">Como funciona</p>
                  <ul className="text-xs text-blue-700 dark:text-blue-400 space-y-1.5">
                    <li>• A 1ª mensagem é enviada após o tempo configurado sem resposta do cliente</li>
                    <li>• A 2ª mensagem é enviada após o segundo tempo (desde a última mensagem do cliente)</li>
                    <li>• Após o tempo de fechamento, o atendimento é encerrado automaticamente</li>
                    <li>• Qualquer resposta do cliente reinicia os contadores</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={onSave}
                disabled={isSaving || isLoading}
                className="px-4 py-2 bg-primary hover:bg-primary/90 disabled:bg-primary/50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold shadow-sm transition-all flex items-center justify-center gap-2"
                style={{ backgroundColor: '#F07000', opacity: (isSaving || isLoading) ? 0.5 : 1 }}
              >
                {isSaving ? (
                  <>
                    <span className="material-icons-outlined text-lg animate-spin">refresh</span>
                    Salvando...
                  </>
                ) : (
                  <>
                    <span className="material-icons-outlined text-lg">save</span>
                    Salvar Follow-up
                  </>
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
