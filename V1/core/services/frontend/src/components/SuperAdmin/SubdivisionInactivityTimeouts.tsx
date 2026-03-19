import React from 'react';

interface SubdivisionInactivityTimeoutsProps {
  subdivisionInactivityTimeouts: Record<string, number>;
  setSubdivisionInactivityTimeouts: (value: Record<string, number>) => void;
  isLoadingSubdivisionTimeouts: boolean;
  isSavingSubdivisionTimeouts: boolean;
  onSaveSubdivisionTimeouts: () => Promise<void>;
}

export const SubdivisionInactivityTimeouts: React.FC<SubdivisionInactivityTimeoutsProps> = ({
  subdivisionInactivityTimeouts,
  setSubdivisionInactivityTimeouts,
  isLoadingSubdivisionTimeouts,
  isSavingSubdivisionTimeouts,
  onSaveSubdivisionTimeouts,
}) => {
  return (
    <div className="bg-white dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden" style={{ backgroundColor: '#FFFFFF' }}>
      <div className="p-6 border-b border-slate-200 dark:border-slate-800">
        <div className="flex items-center gap-3 mb-2">
          <div className="w-12 h-12 bg-primary/10 rounded-xl flex items-center justify-center" style={{ backgroundColor: '#FEE4E2' }}>
            <span className="material-icons-outlined text-primary" style={{ color: '#F07000' }}>timer_off</span>
          </div>
          <div>
            <h2 className="text-xl font-bold text-slate-900 dark:text-white" style={{ color: '#0F172A', fontWeight: 700 }}>
              Fechamento Automático por Inatividade (Subdivisões)
            </h2>
            <p className="text-sm text-slate-500 dark:text-slate-400" style={{ color: '#64748B' }}>
              Configure o tempo de inatividade (sem mensagens do cliente) para fechar automaticamente atendimentos em cada subdivisão.
            </p>
          </div>
        </div>
      </div>

      <div className="p-6 space-y-6">
        {isLoadingSubdivisionTimeouts ? (
          <div className="flex items-center justify-center py-4">
            <span className="material-icons-outlined text-slate-400 animate-spin">refresh</span>
            <span className="ml-2 text-sm text-slate-500">Carregando configurações...</span>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Subdivisões não atribuídas */}
            <div className="bg-slate-50 dark:bg-slate-800 rounded-lg p-4" style={{ backgroundColor: '#F8FAFC' }}>
              <h4 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-3" style={{ color: '#475569' }}>
                Não Atribuídos
              </h4>
              <div className="space-y-3">
                {['triagem', 'encaminhados-ecommerce', 'encaminhados-balcao'].map((subdivision) => {
                  const label = subdivision === 'triagem' 
                    ? 'Triagem' 
                    : subdivision === 'encaminhados-ecommerce'
                    ? 'Encaminhados E-commerce'
                    : 'Encaminhados Balcão';
                  
                  return (
                    <div key={subdivision} className="flex items-center justify-between gap-4">
                      <label className="text-sm text-slate-700 dark:text-slate-300 flex-1" style={{ color: '#475569' }}>
                        {label}
                      </label>
                      <div className="flex items-center gap-2">
                        <input
                          type="number"
                          min="1"
                          max="1440"
                          value={subdivisionInactivityTimeouts[subdivision] || ''}
                          onChange={(e) => {
                            const value = e.target.value === '' ? undefined : Math.min(1440, Math.max(1, parseInt(e.target.value, 10) || 0));
                            setSubdivisionInactivityTimeouts({
                              ...subdivisionInactivityTimeouts,
                              [subdivision]: value,
                            });
                          }}
                          placeholder="Desativado"
                          className="w-24 px-3 py-1.5 bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 rounded-lg text-sm text-slate-900 dark:text-white focus:ring-2 focus:ring-primary focus:border-primary outline-none"
                          style={{ backgroundColor: '#FFFFFF', color: '#0F172A' }}
                        />
                        <span className="text-xs text-slate-500 dark:text-slate-400 whitespace-nowrap" style={{ color: '#64748B' }}>
                          min
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
              <div className="flex items-start gap-2">
                <span className="material-icons-outlined text-blue-600 dark:text-blue-400 text-lg">info</span>
                <div className="flex-1">
                  <p className="text-sm font-semibold text-blue-800 dark:text-blue-300 mb-2">
                    ℹ️ Como Funciona
                  </p>
                  <ul className="text-xs text-blue-700 dark:text-blue-400 space-y-1.5">
                    <li>• Configure o tempo em minutos (1-1440 minutos = até 24 horas)</li>
                    <li>• Deixe em branco para desativar o fechamento automático para aquela subdivisão</li>
                    <li>• O sistema verifica a cada 1 minuto se há atendimentos inativos</li>
                    <li>• Atendimentos com timers ativos (balcão/e-commerce) não são fechados por esta regra</li>
                    <li>• A inatividade é medida desde a última mensagem do cliente</li>
                  </ul>
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={onSaveSubdivisionTimeouts}
                disabled={isSavingSubdivisionTimeouts || isLoadingSubdivisionTimeouts}
                className="px-4 py-2 bg-primary hover:bg-primary/90 disabled:bg-primary/50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold shadow-sm transition-all flex items-center justify-center gap-2"
                style={{ backgroundColor: isSavingSubdivisionTimeouts ? '#F07000' : '#F07000', opacity: (isSavingSubdivisionTimeouts || isLoadingSubdivisionTimeouts) ? 0.5 : 1 }}
              >
                {isSavingSubdivisionTimeouts ? (
                  <>
                    <span className="material-icons-outlined text-lg animate-spin">refresh</span>
                    Salvando...
                  </>
                ) : (
                  <>
                    <span className="material-icons-outlined text-lg">save</span>
                    Salvar Tempos de Inatividade
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
