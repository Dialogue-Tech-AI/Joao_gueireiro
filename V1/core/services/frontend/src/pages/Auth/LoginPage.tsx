import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../../store/auth.store';
import { authService } from '../../services/auth.service';
import toast from 'react-hot-toast';

export const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const navigate = useNavigate();
  const { login } = useAuthStore();

  // Forçar light mode na página de login (sempre inicia em light mode)
  useEffect(() => {
    const htmlElement = document.documentElement;
    // Remover dark mode se estiver ativo
    if (htmlElement.classList.contains('dark')) {
      htmlElement.classList.remove('dark');
    }
    // Não salvar no localStorage para não interferir na preferência do dashboard
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);

    try {
      const response = await authService.login({ email, password });
      login(response.user, response.accessToken, response.refreshToken);
      
      // Redirect based on role
      const roleRoutes = {
        SELLER: '/seller',
        SUPERVISOR: '/supervisor',
        ADMIN_GENERAL: '/admin',
        SUPER_ADMIN: '/super-admin',
      };
      
      navigate(roleRoutes[response.user.role] || '/');
      toast.success('Login realizado com sucesso!');
    } catch (error: any) {
      const message = error.response?.data?.message || 'Erro ao fazer login';
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-background-light dark:bg-[#0A0A0A] text-slate-900 dark:text-slate-100 min-h-screen flex items-center justify-center overflow-hidden">
      <div className="flex w-full h-screen">
        {/* Left Panel - Login Form */}
        <div className="w-full lg:w-1/2 flex flex-col justify-between p-8 lg:p-16 bg-white dark:bg-zinc-900 shadow-2xl z-20 overflow-y-auto">
          <div className="flex items-center gap-3 mb-8">
            <div className="w-10 h-10 bg-navy-custom flex items-center justify-center rounded-lg shadow-lg">
              <span className="material-symbols-outlined text-white text-2xl">corporate_fare</span>
            </div>
            <span className="text-xl font-bold tracking-tighter text-navy-custom dark:text-white uppercase">
              <span className="text-primary">Plataforma</span>
            </span>
          </div>

          <div className="max-w-md w-full mx-auto">
            <div className="text-center mb-10">
              <h1 className="text-3xl font-bold mb-2 tracking-tight">Bem-vindo de volta</h1>
              <p className="text-slate-500 dark:text-slate-400 font-medium">Acesse sua conta corporativa</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <span className="material-symbols-outlined text-slate-400 group-focus-within:text-navy-custom transition-colors">
                    person
                  </span>
                </div>
                <div className="pl-12 pr-4 py-3 border border-slate-200 dark:border-zinc-700 rounded-xl focus-within:ring-2 focus-within:ring-navy-custom/10 focus-within:border-navy-custom transition-all bg-slate-50 dark:bg-zinc-800/50">
                  <label
                    htmlFor="email"
                    className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-0.5"
                  >
                    ID ou E-mail Corporativo
                  </label>
                  <input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="block w-full border-0 p-0 text-slate-900 dark:text-white placeholder-slate-300 dark:placeholder-slate-600 focus:ring-0 bg-transparent text-sm font-medium"
                    placeholder="colaborador@plataforma.com.br"
                    autoComplete="email"
                  />
                </div>
              </div>

              <div className="relative group">
                <div className="absolute inset-y-0 left-0 pl-4 flex items-center pointer-events-none">
                  <span className="material-symbols-outlined text-slate-400 group-focus-within:text-navy-custom transition-colors">
                    lock
                  </span>
                </div>
                <div className="pl-12 pr-4 py-3 border border-slate-200 dark:border-zinc-700 rounded-xl focus-within:ring-2 focus-within:ring-navy-custom/10 focus-within:border-navy-custom transition-all bg-slate-50 dark:bg-zinc-800/50">
                  <label
                    htmlFor="password"
                    className="block text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-0.5"
                  >
                    Senha de Acesso
                  </label>
                  <input
                    id="password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    className="block w-full border-0 p-0 text-slate-900 dark:text-white placeholder-slate-300 dark:placeholder-slate-600 focus:ring-0 bg-transparent text-sm font-medium"
                    placeholder="••••••••"
                    autoComplete="current-password"
                  />
                </div>
              </div>

              <div className="flex items-center px-1">
                <label className="flex items-center gap-2 cursor-pointer group">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    onChange={(e) => setRememberMe(e.target.checked)}
                    className="rounded border-slate-300 text-navy-custom focus:ring-navy-custom"
                  />
                  <span className="text-xs text-slate-500 group-hover:text-slate-700 transition-colors">
                    Lembrar credenciais
                  </span>
                </label>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-navy-custom hover:bg-blue-900 text-white font-bold py-4 rounded-xl shadow-lg shadow-navy-custom/20 transition-all flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <>
                    <span className="animate-spin">⏳</span>
                    Entrando...
                  </>
                ) : (
                  <>
                    Entrar no Sistema
                    <span className="material-symbols-outlined text-sm">login</span>
                  </>
                )}
              </button>
            </form>
          </div>

          <div className="max-w-md w-full mx-auto text-center mt-10">
            <p className="text-[10px] text-slate-400 leading-relaxed uppercase tracking-wider font-medium">
              Uso exclusivo para colaboradores da plataforma. <br />
              Em caso de dúvidas, entre em contato com o suporte de TI.
            </p>
          </div>
        </div>

        {/* Right Panel - Branding */}
        <div className="hidden lg:flex w-1/2 gradient-bg items-center justify-center p-20 relative overflow-hidden">
          <div className="absolute -top-24 -right-24 w-96 h-96 bg-white/5 rounded-full blur-3xl"></div>
          <div className="absolute -bottom-24 -left-24 w-96 h-96 bg-primary/10 rounded-full blur-3xl"></div>
          <div
            className="absolute inset-0 opacity-10"
            style={{
              backgroundImage: "url('https://www.transparenttextures.com/patterns/carbon-fibre.png')",
            }}
          ></div>
          <div className="relative z-10 w-full max-w-lg">
            <div className="glass-card p-12 rounded-[2.5rem] shadow-2xl transition-all duration-700">
              <div className="flex flex-col items-center text-center">
                <div className="w-56 h-56 bg-gradient-to-br from-navy-custom to-blue-custom rounded-3xl shadow-inner flex items-center justify-center mb-10 relative group">
                  <div className="absolute inset-4 border-2 border-white/20 rounded-2xl"></div>
                  <div className="relative grid grid-cols-2 gap-4 p-4">
                    <span className="material-symbols-outlined text-white text-5xl opacity-40">
                      inventory_2
                    </span>
                    <span className="material-symbols-outlined text-white text-5xl opacity-80">
                      hub
                    </span>
                    <span className="material-symbols-outlined text-white text-5xl opacity-100">
                      analytics
                    </span>
                    <span className="material-symbols-outlined text-primary text-5xl">groups</span>
                  </div>
                </div>
                <h2 className="text-white text-4xl font-extrabold mb-4 tracking-tight">
                  Portal do Colaborador
                </h2>
                <p className="text-blue-100 text-lg font-medium opacity-90 max-w-xs leading-relaxed">
                  Acesse o sistema interno de atendimento e gestão
                </p>
              </div>
            </div>
            <div className="mt-8 flex justify-center gap-6">
              <div className="flex items-center gap-2 text-white/60 text-xs">
                <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
                Sistemas Online
              </div>
            </div>
          </div>
          <div
            className="absolute bottom-0 right-0 w-full h-full opacity-[0.03] pointer-events-none"
            style={{
              backgroundImage:
                'linear-gradient(#fff 1px, transparent 1px), linear-gradient(90deg, #fff 1px, transparent 1px)',
              backgroundSize: '50px 50px',
            }}
          ></div>
        </div>
      </div>
    </div>
  );
};
