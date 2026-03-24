import React, { useState, useRef, useEffect } from 'react';

/** Detecta o MIME type de áudio suportado pelo navegador (iOS Safari usa audio/mp4, Chrome/Firefox usa audio/webm) */
function getSupportedAudioMimeType(): string {
  if (typeof MediaRecorder === 'undefined') return 'audio/webm';

  const types = [
    'audio/mp4',   // iOS Safari (prioridade)
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg',
  ];
  for (const type of types) {
    try {
      if (MediaRecorder.isTypeSupported?.(type)) return type;
    } catch {
      continue;
    }
  }
  // Fallback: iOS/Safari usa audio/mp4; outros usam audio/webm
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  return isIOS ? 'audio/mp4' : 'audio/webm';
}

interface AudioRecorderProps {
  onRecordingComplete: (audioBlob: Blob) => void;
  onCancel: () => void;
}

export const AudioRecorder: React.FC<AudioRecorderProps> = ({ onRecordingComplete, onCancel }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const mimeTypeRef = useRef<string>('audio/webm');
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      // Cleanup on unmount
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = getSupportedAudioMimeType();
      mimeTypeRef.current = mimeType;

      let mediaRecorder: MediaRecorder;
      try {
        mediaRecorder = new MediaRecorder(stream, { mimeType });
      } catch {
        mediaRecorder = new MediaRecorder(stream);
        mimeTypeRef.current = mediaRecorder.mimeType || 'audio/webm';
      }
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = () => {
        const actualType = mediaRecorder.mimeType || mimeTypeRef.current;
        const audioBlob = new Blob(audioChunksRef.current, { type: actualType });
        setAudioBlob(audioBlob);
        stream.getTracks().forEach(track => track.stop());
      };

      // Safari/iOS: start(timeslice) ajuda a garantir que ondataavailable dispare
      mediaRecorder.start(1000);
      setIsRecording(true);
      setRecordingTime(0);

      // Start timer
      timerRef.current = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } catch (error) {
      console.error('Error starting recording:', error);
      alert('Erro ao acessar o microfone. Verifique as permissões.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
  };

  const handleSend = () => {
    if (audioBlob) {
      onRecordingComplete(audioBlob);
      setAudioBlob(null);
      setRecordingTime(0);
    }
  };

  const handleCancel = () => {
    if (isRecording) {
      stopRecording();
    }
    setAudioBlob(null);
    setRecordingTime(0);
    onCancel();
  };

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-800 rounded-lg shadow-xl max-w-md w-full p-6">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-slate-800 dark:text-slate-200">
            Gravar Áudio
          </h3>
          <button
            onClick={handleCancel}
            className="text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
          >
            <span className="material-icons-round">close</span>
          </button>
        </div>

        <div className="mb-6 text-center">
          {isRecording ? (
            <div className="space-y-4">
              <div className="flex items-center justify-center">
                <div className="w-20 h-20 bg-red-500 rounded-full flex items-center justify-center animate-pulse">
                  <span className="material-icons-round text-white text-4xl">mic</span>
                </div>
              </div>
              <div className="text-2xl font-mono font-bold text-red-500">
                {formatTime(recordingTime)}
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Gravando... Clique em Parar para finalizar
              </p>
            </div>
          ) : audioBlob ? (
            <div className="space-y-4">
              <div className="flex items-center justify-center">
                <span className="material-icons-round text-blue-500 text-6xl">audiotrack</span>
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Áudio gravado: {formatTime(recordingTime)}
              </p>
              <audio src={URL.createObjectURL(audioBlob)} controls className="w-full" />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="flex items-center justify-center">
                <span className="material-icons-round text-slate-400 text-6xl">mic</span>
              </div>
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Clique em Gravar para começar
              </p>
            </div>
          )}
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleCancel}
            className="flex-1 px-4 py-2 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors"
          >
            Cancelar
          </button>
          {isRecording ? (
            <button
              onClick={stopRecording}
              className="flex-1 px-4 py-2 bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
            >
              Parar
            </button>
          ) : audioBlob ? (
            <>
              <button
                onClick={() => {
                  setAudioBlob(null);
                  setRecordingTime(0);
                }}
                className="px-4 py-2 bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 rounded-lg hover:bg-slate-300 dark:hover:bg-slate-600 transition-colors"
              >
                Regravar
              </button>
              <button
                onClick={handleSend}
                className="flex-1 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
              >
                Enviar
              </button>
            </>
          ) : (
            <button
              onClick={startRecording}
              className="flex-1 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
            >
              Gravar
            </button>
          )}
        </div>
      </div>
    </div>
  );
};
