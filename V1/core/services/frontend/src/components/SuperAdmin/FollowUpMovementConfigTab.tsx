import React from 'react';
import type { FollowUpMovementConfig } from '../../services/ai-config.service';

interface FollowUpMovementConfigTabProps {
  config: FollowUpMovementConfig;
  setConfig: (value: FollowUpMovementConfig) => void;
  isLoading: boolean;
  isSaving: boolean;
  onSave: () => Promise<void>;
}

export const FollowUpMovementConfigTab: React.FC<FollowUpMovementConfigTabProps> = ({
  config,
  setConfig,
  isLoading,
  isSaving,
  onSave,
}) => {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden" style={{ backgroundColor: '#FFFFFF' }}>
      <div className="p-6 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center" style={{ backgroundColor: '#FEE4E2' }}>
            <span className="material-icons-outlined text-primary" style={{ color: '#F07000' }}>swap_horiz</span>
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white" style={{ color: '#0F172A', fontWeight: 700 }}>
              Movimentação automática entre divisões
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
              Configure o tempo de inatividade para mover atendimentos entre as colunas (Abertos → Aguardando 1º → Aguardando 2º → Fechados). Não confundir com o envio das mensagens de follow-up.
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
            <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4" style={{ backgroundColor: '#F8FAFC' }}>
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-4" style={{ color: '#475569' }}>
                Tempos de movimentação (em minutos)
              </h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                    Tempo para mover de Abertos → Aguardando 1º Follow-up
                  </label>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
                    Após este tempo sem resposta do cliente, o atendimento é movido automaticamente para a coluna &quot;Aguardando 1º Follow-up&quot;. Aplica-se a qualquer atendimento na aba Abertos.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      max="1440"
                      value={config.moveOpenToFirstFollowUpMinutes ?? ''}
                      onChange={(e) => {
                        const v = e.target.value === '' ? undefined : Math.min(1440, Math.max(1, parseInt(e.target.value, 10) || 0));
                        setConfig({ ...config, moveOpenToFirstFollowUpMinutes: v ?? 60 });
                      }}
                      className="w-28 px-3 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                      style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                    />
                    <span className="text-xs text-slate-500 whitespace-nowrap">min</span>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-2">
                    Tempo após 2º follow-up para mover para Fechados
                  </label>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mb-2">
                    Após o envio do segundo follow-up, quanto tempo esperar até mover o atendimento automaticamente para Fechados.
                  </p>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min="60"
                      max="43200"
                      value={config.moveToFechadosAfterSecondFollowUpMinutes ?? ''}
                      onChange={(e) => {
                        const v = e.target.value === '' ? undefined : Math.min(43200, Math.max(60, parseInt(e.target.value, 10) || 60));
                        setConfig({ ...config, moveToFechadosAfterSecondFollowUpMinutes: v ?? 1440 });
                      }}
                      className="w-28 px-3 py-2 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                      style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                    />
                    <span className="text-xs text-slate-500 whitespace-nowrap">min</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
              <div className="flex items-start gap-2">
                <span className="material-icons-outlined text-amber-600 dark:text-amber-400 text-lg">info</span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-amber-800 dark:text-amber-300 mb-2">Como funciona</p>
                  <ul className="text-xs text-amber-700 dark:text-amber-400 space-y-1.5">
                    <li>• <strong>Abertos → Aguardando 1º:</strong> Após X minutos sem resposta do cliente, o atendimento aparece na coluna Aguardando 1º Follow-up.</li>
                    <li>• <strong>Aguardando 1º → Aguardando 2º:</strong> Automaticamente quando o 1º follow-up é enviado.</li>
                    <li>• <strong>Aguardando 2º → Fechados:</strong> Após Y minutos após o envio do 2º follow-up, o atendimento é movido para Fechados.</li>
                    <li>• Os tempos de envio das mensagens são configurados separadamente em &quot;Mensagens de Follow-up&quot;.</li>
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
                    Salvar movimentação
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
