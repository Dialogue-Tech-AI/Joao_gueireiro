import React from 'react';

interface TypingIndicatorProps {
  sender?: string;
  isClient?: boolean;
}

export const TypingIndicator: React.FC<TypingIndicatorProps> = ({ 
  sender = 'AI',
  isClient = false 
}) => {
  return (
    <div className={`flex items-start gap-2.5 ${isClient ? '' : 'flex-row-reverse'}`}>
      {isClient ? (
        <div 
          className="w-9 h-9 bg-orange-500 flex items-center justify-center rounded-full text-[10px] text-white font-medium flex-shrink-0"
          style={{ backgroundColor: '#F07000' }}
        >
          {sender.charAt(0).toUpperCase()}
        </div>
      ) : (
        <div 
          className="w-9 h-9 bg-navy flex items-center justify-center rounded-full text-[10px] text-white font-medium flex-shrink-0" 
          style={{ backgroundColor: '#003070' }}
        >
          {sender.length >= 2 ? sender.substring(0, 2).toUpperCase() : sender.charAt(0).toUpperCase()}
        </div>
      )}
      <div className={`flex-1 min-w-0 ${isClient ? '' : 'flex flex-col items-end'}`}>
        <div className={`flex items-center gap-1.5 mb-1 ${isClient ? '' : 'flex-row-reverse'}`}>
          <span className="text-xs font-medium text-slate-600 dark:text-slate-400">{sender}</span>
          <span className="text-[10px] text-slate-400 dark:text-slate-500">agora</span>
        </div>
        <div 
          className={`inline-block px-3.5 py-2.5 text-sm leading-relaxed max-w-[85%] ${
            isClient
              ? 'bg-green-50 dark:bg-green-900/20 text-slate-800 dark:text-slate-100 rounded-2xl rounded-tl-md'
              : 'bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-100 rounded-2xl rounded-tr-md shadow-sm'
          }`}
        >
          <div className="flex items-center gap-1">
            <span className="w-2 h-2 bg-slate-400 dark:bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></span>
            <span className="w-2 h-2 bg-slate-400 dark:bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></span>
            <span className="w-2 h-2 bg-slate-400 dark:bg-slate-500 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></span>
          </div>
        </div>
      </div>
    </div>
  );
};
