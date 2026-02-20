import React, { useEffect, useRef, useState } from 'react';
import { connectToLiveChef, isLiveAssistantConfigured, parseVoiceInput } from '../services/geminiService';
import { Mic, X, Zap, Activity, Radio, WifiOff } from 'lucide-react';
import { Blob as GenAIBlob } from '@google/genai';

// --- Audio Utils ---
function encode(bytes: Uint8Array) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function decode(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
}

async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
  }
  return buffer;
}

function createBlob(data: Float32Array): GenAIBlob {
    const l = data.length;
    const int16 = new Int16Array(l);
    for (let i = 0; i < l; i++) int16[i] = data[i] * 32768;
    return { data: encode(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
}

interface ParsedCommandItem {
  name: string;
  quantity: number;
  unit: string;
}

interface SpeechRecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: Event) => void) | null;
  onerror: ((event: Event) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

const getSpeechRecognitionCtor = (): (new () => SpeechRecognitionLike) | null => {
  const scopedWindow = window as Window & {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return scopedWindow.SpeechRecognition || scopedWindow.webkitSpeechRecognition || null;
};

const parseCommandItems = (rawInput: string): ParsedCommandItem[] => {
  const cleaned = rawInput
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s,.-]/gu, ' ')
    .replace(/\b(add|please|put|into|inventory|fridge|my|to)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) return [];

  const segments = cleaned
    .split(/,|\band\b/)
    .map(segment => segment.trim())
    .filter(Boolean);

  const unitMap: Record<string, string> = {
    pc: 'pcs',
    pcs: 'pcs',
    piece: 'pcs',
    pieces: 'pcs',
    kg: 'kg',
    g: 'g',
    l: 'l',
    ml: 'ml',
    pack: 'pack',
    packs: 'pack',
    bottle: 'bottle',
    bottles: 'bottle',
    dozen: 'dozen',
  };

  return segments.map(segment => {
    let quantity = 1;
    let unit = 'pcs';
    let namePart = segment;

    const quantityMatch = namePart.match(/^(\d+(?:\.\d+)?)\s+/);
    if (quantityMatch) {
      quantity = Number.parseFloat(quantityMatch[1]) || 1;
      namePart = namePart.slice(quantityMatch[0].length).trim();
    }

    const unitMatch = namePart.match(/\b(pc|pcs|piece|pieces|kg|g|l|ml|pack|packs|bottle|bottles|dozen)\b/i);
    if (unitMatch) {
      unit = unitMap[unitMatch[1].toLowerCase()] || unit;
      namePart = namePart.replace(unitMatch[0], ' ').replace(/\s+/g, ' ').trim();
    }

    return {
      name: namePart,
      quantity: Number.isFinite(quantity) ? quantity : 1,
      unit,
    };
  }).filter(item => item.name.length > 0);
};

const eventToTranscript = (event: Event): string => {
  const payload = event as Event & {
    results?: ArrayLike<{
      isFinal?: boolean;
      0?: { transcript?: string };
    }>;
  };
  const results = payload.results;
  if (!results) return '';

  const texts: string[] = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (!result || !result.isFinal || !result[0]?.transcript) continue;
    texts.push(result[0].transcript);
  }
  return texts.join(' ').trim();
};

interface Props {
  isActive: boolean;
  onClose: () => void;
  onToolUse: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
}

interface LiveSessionLike {
  close: () => void;
  sendRealtimeInput: (payload: { media: GenAIBlob }) => void;
}

interface WindowWithWebkitAudioContext extends Window {
  webkitAudioContext?: typeof AudioContext;
}

const LiveAssistant: React.FC<Props> = ({ isActive, onClose, onToolUse }) => {
  const [isConnected, setIsConnected] = useState(false);
  const [transcripts, setTranscripts] = useState<{user: boolean, text: string}[]>([]);
  const [statusText, setStatusText] = useState("Initializing...");
  const [interactionState, setInteractionState] = useState<'idle' | 'listening' | 'speaking'>('idle');
  const [isFallbackMode, setIsFallbackMode] = useState(false);
  const [isFallbackListening, setIsFallbackListening] = useState(false);
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const inputAnalyserRef = useRef<AnalyserNode | null>(null);
  const outputAnalyserRef = useRef<AnalyserNode | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const sessionRef = useRef<LiveSessionLike | null>(null);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const streamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaChunksRef = useRef<globalThis.Blob[]>([]);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const toolCallbackRef = useRef(onToolUse);

  useEffect(() => { toolCallbackRef.current = onToolUse; }, [onToolUse]);

  const applyParsedItems = async (items: ParsedCommandItem[]) => {
    if (items.length === 0) {
      setTranscripts(prev => [...prev, { user: false, text: "I couldn't detect any grocery items." }]);
      return;
    }

    const confirmations: string[] = [];
    for (const item of items) {
      const result = await toolCallbackRef.current('updateInventory', {
        itemName: item.name,
        quantityChange: item.quantity,
        unit: item.unit,
      });
      confirmations.push(typeof result === 'string' ? result : `Added ${item.quantity} ${item.name}`);
    }

    setTranscripts(prev => [...prev, { user: false, text: confirmations.join(' ') }]);
  };

  const processAudioFallback = async (blob: globalThis.Blob) => {
    const reader = new FileReader();
    const base64Audio = await new Promise<string>((resolve, reject) => {
      reader.onloadend = () => {
        const output = typeof reader.result === 'string' ? reader.result : '';
        if (!output.includes(',')) {
          reject(new Error('Failed to encode audio.'));
          return;
        }
        resolve(output.split(',')[1]);
      };
      reader.onerror = () => reject(new Error('Failed to encode audio.'));
      reader.readAsDataURL(blob);
    });

    const items = await parseVoiceInput(base64Audio, blob.type || 'audio/webm');
    const parsed = items.map(item => ({
      name: item.name,
      quantity: item.quantity,
      unit: item.unit || 'pcs',
    }));
    await applyParsedItems(parsed);
  };

  const stopFallbackListening = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    } else if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    setIsFallbackListening(false);
    setInteractionState('idle');
  };

  const startFallbackMediaRecorder = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef.current = stream;
    mediaChunksRef.current = [];
    const recorder = new MediaRecorder(stream);
    mediaRecorderRef.current = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        mediaChunksRef.current.push(event.data);
      }
    };

    recorder.onstop = async () => {
      const chunks = [...mediaChunksRef.current];
      mediaChunksRef.current = [];
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }

      setIsFallbackListening(false);
      setInteractionState('idle');
      setStatusText("Processing...");

      try {
        const audioBlob = new globalThis.Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        await processAudioFallback(audioBlob);
        setStatusText("Ready (secure mode)");
      } catch (error) {
        setStatusText("Secure mode failed");
      }
    };

    recorder.start();
    setIsFallbackListening(true);
    setInteractionState('listening');
    setStatusText("Listening (secure mode)...");
  };

  const startFallbackListening = async () => {
    try {
      // Worker-backed mode: always use audio recording + backend parse
      // so Gemini keys remain server-side in Cloudflare Worker secrets.
      await startFallbackMediaRecorder();
    } catch {
      setStatusText("Mic Error");
      setIsFallbackListening(false);
      setInteractionState('idle');
    }
  };

  const startVisualizer = () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      const render = () => {
          const canvas = canvasRef.current;
          if (!canvas) return;
          const ctx = canvas.getContext('2d');
          if (!ctx) return;

          const width = canvas.width;
          const height = canvas.height;
          ctx.clearRect(0, 0, width, height);

          const getFreqData = (analyser: AnalyserNode | null) => {
              if (!analyser) return new Uint8Array(0);
              const dataArray = new Uint8Array(analyser.frequencyBinCount);
              analyser.getByteFrequencyData(dataArray);
              return dataArray;
          };

          const inputFreqs = getFreqData(inputAnalyserRef.current);
          const outputFreqs = getFreqData(outputAnalyserRef.current);
          const barCount = 32;
          const barWidth = (width / barCount) * 0.8;
          const spacing = (width / barCount) * 0.2;
          
          for (let i = 0; i < barCount; i++) {
              const dataIndex = Math.floor((i / barCount) * (inputFreqs.length / 2)); 
              const inVal = inputFreqs[dataIndex] || 0;
              const outVal = outputFreqs[dataIndex] || 0;
              let barHeight = 0;
              let fillStyle = '#334155';

              if (interactionState === 'speaking') {
                  barHeight = (outVal / 255) * height * 0.8;
                  fillStyle = `hsl(270, 90%, ${50 + (outVal/255)*40}%)`;
              } else if (interactionState === 'listening') {
                  barHeight = (inVal / 255) * height * 0.8;
                  fillStyle = `hsl(150, 90%, ${40 + (inVal/255)*40}%)`;
              } else {
                  const wave = Math.sin((Date.now() / 300) + (i * 0.5));
                  barHeight = 4 + (wave * 3);
                  fillStyle = '#475569';
              }
              const x = i * (barWidth + spacing) + spacing/2;
              const y = (height - barHeight) / 2;
              ctx.fillStyle = fillStyle;
              ctx.beginPath();
              ctx.roundRect(x, y, barWidth, barHeight, 4);
              ctx.fill();
          }
          animationFrameRef.current = requestAnimationFrame(render);
      };
      render();
  };

  useEffect(() => {
      if (!isConnected) return;
      const interval = setInterval(() => {
          if (!inputAnalyserRef.current || !outputAnalyserRef.current) return;
          const getVol = (analyser: AnalyserNode) => {
             const arr = new Uint8Array(analyser.frequencyBinCount);
             analyser.getByteFrequencyData(arr);
             return arr.reduce((a,b)=>a+b,0)/arr.length;
          };
          const inVol = getVol(inputAnalyserRef.current);
          const outVol = getVol(outputAnalyserRef.current);
          
          if (outVol > 10) {
              setInteractionState('speaking');
              setStatusText("Speaking...");
          } else if (inVol > 15) {
              setInteractionState('listening');
              setStatusText("Listening...");
          } else {
              setInteractionState('idle');
              setStatusText("Waiting...");
          }
      }, 200);
      return () => clearInterval(interval);
  }, [isConnected]);

  const disconnect = () => {
    stopFallbackListening();

    if (sessionRef.current) {
      sessionRef.current.close();
      sessionRef.current = null;
    }
    sourcesRef.current.forEach(s => s.stop());
    sourcesRef.current.clear();
    if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
    }
    if (audioContextRef.current) audioContextRef.current.close();
    if (inputContextRef.current) inputContextRef.current.close();
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
    audioContextRef.current = null;
    inputContextRef.current = null;
    mediaRecorderRef.current = null;
    setIsConnected(false);
    setIsFallbackMode(false);
    setIsFallbackListening(false);
    setStatusText("Session ended");
    setInteractionState('idle');
  };

  useEffect(() => {
    if (isActive) startSession();
    else disconnect();
    return () => disconnect();
  }, [isActive]);

  const startSession = async () => {
    try {
      if (!isLiveAssistantConfigured()) {
        setIsFallbackMode(true);
        setIsConnected(true);
        setStatusText("Secure mode ready. Tap mic to record.");
        setInteractionState('idle');
        return;
      }

      setIsFallbackMode(false);
      setStatusText("Connecting...");
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const AudioContextCtor = window.AudioContext || (window as WindowWithWebkitAudioContext).webkitAudioContext;
      if (!AudioContextCtor) {
        throw new Error('AudioContext is not supported in this browser.');
      }

      const audioCtx = new AudioContextCtor({ sampleRate: 24000 });
      const inputCtx = new AudioContextCtor({ sampleRate: 16000 });
      await Promise.all([audioCtx.resume(), inputCtx.resume()]);

      audioContextRef.current = audioCtx;
      inputContextRef.current = inputCtx;
      
      const outputAnalyser = audioCtx.createAnalyser();
      outputAnalyser.fftSize = 256; 
      outputAnalyserRef.current = outputAnalyser;
      outputAnalyser.connect(audioCtx.destination);
      nextStartTimeRef.current = 0;

	      const session = await connectToLiveChef(
        async (base64Audio) => {
           if (!audioContextRef.current) return;
           nextStartTimeRef.current = Math.max(nextStartTimeRef.current, audioContextRef.current.currentTime);
           const audioBuffer = await decodeAudioData(decode(base64Audio), audioContextRef.current, 24000, 1);
           const source = audioContextRef.current.createBufferSource();
           source.buffer = audioBuffer;
           source.connect(outputAnalyserRef.current!);
           source.addEventListener('ended', () => sourcesRef.current.delete(source));
           source.start(nextStartTimeRef.current);
           nextStartTimeRef.current += audioBuffer.duration;
           sourcesRef.current.add(source);
        },
        (text, isUser) => setTranscripts(prev => [...prev, { user: isUser, text }]),
        async (name, args) => await toolCallbackRef.current(name, args),
        () => { setIsConnected(false); setStatusText("Disconnected"); }
      );

	      sessionRef.current = session;
      setIsConnected(true);
      setStatusText("Ready");

      const source = inputCtx.createMediaStreamSource(stream);
      const inputAnalyser = inputCtx.createAnalyser();
      inputAnalyser.fftSize = 256;
      inputAnalyserRef.current = inputAnalyser;
      const processor = inputCtx.createScriptProcessor(4096, 1, 1);
      
	      processor.onaudioprocess = (e) => {
	        if (!sessionRef.current) return;
	        const inputData = e.inputBuffer.getChannelData(0);
	        const pcmBlob = createBlob(inputData);
	        sessionRef.current.sendRealtimeInput({ media: pcmBlob });
	      };

      source.connect(inputAnalyser);
      inputAnalyser.connect(processor);
      processor.connect(inputCtx.destination);
      startVisualizer();
      
	    } catch (err) {
	      if (err instanceof Error && err.message.includes('Live assistant key is missing')) {
	        setIsFallbackMode(true);
	        setIsConnected(true);
	        setStatusText("Secure mode ready. Tap mic to record.");
	        setInteractionState('idle');
	        return;
	      }

	      console.error(err);
	      disconnect();
	      setStatusText("Mic Error");
	    }
	  };

  const handlePrimaryButton = () => {
    if (!isConnected) {
      void startSession();
      return;
    }

    if (isFallbackMode) {
      if (isFallbackListening) {
        stopFallbackListening();
      } else {
        void startFallbackListening();
      }
      return;
    }

    disconnect();
  };

  const connectionLabel = !isConnected
    ? 'Offline'
    : (isFallbackMode
      ? (interactionState === 'listening' ? 'Listening (Secure)' : 'Secure Mode')
      : (interactionState === 'idle' ? 'Connected' : interactionState === 'listening' ? 'Listening' : 'Answering'));

	  if (!isActive) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center p-6 text-white overflow-hidden bg-slate-900/95 backdrop-blur-3xl animate-in fade-in duration-300">
      <div className={`absolute top-0 right-0 w-[600px] h-[600px] bg-violet-600/20 rounded-full blur-[120px] -z-10 transition-all duration-1000 ${interactionState === 'speaking' ? 'opacity-60 scale-110' : 'opacity-20 scale-100'}`}></div>
      <div className={`absolute bottom-0 left-0 w-[600px] h-[600px] bg-emerald-600/20 rounded-full blur-[120px] -z-10 transition-all duration-1000 ${interactionState === 'listening' ? 'opacity-60 scale-110' : 'opacity-20 scale-100'}`}></div>

      <button onClick={onClose} className="absolute top-6 right-6 p-3 bg-white/5 rounded-full hover:bg-white/10 transition-colors border border-white/10">
        <X size={24} className="text-slate-300" />
      </button>

      <div className="flex-1 w-full max-w-md flex flex-col items-center justify-between py-12">
        <div className="flex flex-col items-center space-y-4">
             <div className={`flex items-center gap-2 px-4 py-1.5 rounded-full border text-xs font-bold uppercase tracking-wider transition-colors duration-500 ${
                 isConnected 
                 ? (interactionState === 'listening' ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400' : 
                    interactionState === 'speaking' ? 'bg-violet-500/10 border-violet-500/40 text-violet-400' : 
                    'bg-slate-500/10 border-slate-500/40 text-slate-400')
                 : 'bg-rose-500/10 border-rose-500/40 text-rose-400'
             }`}>
                {isConnected ? <Activity size={12} className="animate-pulse" /> : <WifiOff size={12} />}
	                <span>{connectionLabel}</span>
	             </div>
             
             <h2 className="text-4xl font-black tracking-tight text-transparent bg-clip-text bg-gradient-to-br from-white to-slate-400">Assistant</h2>
             <p className="text-slate-400 font-medium text-lg min-h-[28px] transition-all duration-300">{statusText}</p>
        </div>

        <div className="relative w-full h-48 flex items-center justify-center my-8">
             <canvas ref={canvasRef} width={360} height={160} className="w-full h-full object-contain" />
        </div>

        <div className="w-full h-48 overflow-y-auto space-y-3 rounded-[2rem] p-6 no-scrollbar mask-gradient bg-gradient-to-b from-white/5 to-transparent border border-white/5 relative shadow-inner">
            {transcripts.length === 0 && (
                <div className="absolute inset-0 flex flex-col items-center justify-center text-center text-slate-500 text-sm p-6 opacity-60">
                    <Radio size={32} className="mb-3 opacity-50" />
                    <p className="mb-1">Say what to add</p>
                    <p className="font-bold text-slate-400">e.g., 'Add bread and milk'</p>
                </div>
            )}
            {transcripts.map((t, i) => (
                <div key={i} className={`flex ${t.user ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-2`}>
                    <div className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm font-medium leading-relaxed shadow-sm ${t.user ? 'bg-emerald-500/20 text-emerald-100 border border-emerald-500/20' : 'bg-violet-500/20 text-violet-100 border border-violet-500/20'}`}>
                        {t.text}
                    </div>
                </div>
            ))}
            <div ref={(el) => el?.scrollIntoView({ behavior: 'smooth' })}></div>
        </div>
      </div>
      
      <div className="w-full max-w-md mt-4 flex justify-center pb-8">
	         <button
            onClick={handlePrimaryButton}
            className={`p-6 rounded-full transition-all duration-300 shadow-2xl border-4 hover:scale-105 active:scale-95 ${
              !isConnected
                ? 'bg-emerald-500 hover:bg-emerald-600 border-emerald-400/30 ring-4 ring-emerald-500/20'
                : isFallbackMode
                  ? (isFallbackListening
                    ? 'bg-rose-500 hover:bg-rose-600 border-rose-400/30 ring-4 ring-rose-500/20'
                    : 'bg-emerald-500 hover:bg-emerald-600 border-emerald-400/30 ring-4 ring-emerald-500/20')
                  : 'bg-rose-500 hover:bg-rose-600 border-rose-400/30 ring-4 ring-rose-500/20'
            }`}
	         >
            {!isConnected
              ? <Zap size={32} className="text-white fill-white" />
              : <Mic size={32} className={`text-white ${isFallbackListening || !isFallbackMode ? 'animate-pulse' : ''}`} />}
	         </button>
	      </div>
    </div>
  );
};
export default LiveAssistant;
