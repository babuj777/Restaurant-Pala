import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, FunctionDeclaration, Type } from '@google/genai';
import { MENU_ITEMS, SYSTEM_INSTRUCTION } from './constants';
import { ConnectionStatus, LogEntry, BookingDetails, OrderDetails } from './types';
import { createBlob, decode, decodeAudioData } from './utils/audio';
import Visualizer from './components/Visualizer';

// --- Tool Definitions ---

const confirmBookingTool: FunctionDeclaration = {
  name: 'confirmBooking',
  description: 'Confirms a table booking with the provided details.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      date: { type: Type.STRING, description: 'Date of booking' },
      time: { type: Type.STRING, description: 'Time of booking' },
      people: { type: Type.NUMBER, description: 'Number of people' },
      specialRequests: { type: Type.STRING, description: 'Reserved dishes or allergy notes' },
    },
    required: ['date', 'time', 'people'],
  },
};

const confirmOrderTool: FunctionDeclaration = {
  name: 'confirmOrder',
  description: 'Confirms a food delivery order.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      items: { 
        type: Type.ARRAY, 
        items: { type: Type.STRING },
        description: 'List of food items ordered' 
      },
      address: { type: Type.STRING, description: 'Delivery address' },
      landmark: { type: Type.STRING, description: 'Nearby landmark' },
      phone: { type: Type.STRING, description: 'Contact number' },
    },
    required: ['items', 'address'],
  },
};

const tools = [{ functionDeclarations: [confirmBookingTool, confirmOrderTool] }];

// --- Main Component ---

const App: React.FC = () => {
  // State
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [activeBooking, setActiveBooking] = useState<BookingDetails | null>(null);
  const [activeOrder, setActiveOrder] = useState<OrderDetails | null>(null);
  const [isTalking, setIsTalking] = useState(false);

  // Refs for Audio
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const connectedRef = useRef<boolean>(false); 
  const sessionPromiseRef = useRef<Promise<any> | null>(null);

  const addLog = (message: string, sender: 'user' | 'babu' | 'system', type: 'info' | 'success' | 'warning' = 'info') => {
    setLogs(prev => [...prev, { timestamp: new Date(), sender, message, type }]);
  };

  const connectToGemini = async () => {
    if (!process.env.API_KEY) {
      addLog("API Key missing!", 'system', 'warning');
      return;
    }

    if (status === ConnectionStatus.CONNECTING || status === ConnectionStatus.CONNECTED) return;

    try {
      setStatus(ConnectionStatus.CONNECTING);
      addLog("Connecting to Babu Joseph...", 'system');

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      // Setup Audio Contexts
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      inputAudioContextRef.current = new AudioContextClass({ sampleRate: 16000 });
      outputAudioContextRef.current = new AudioContextClass({ sampleRate: 24000 });
      
      // Request mic permission and get stream
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      // Create session config
      const sessionConfig = {
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          tools: tools,
          speechConfig: {
             voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
          },
        },
      };

      // Define callbacks separately
      const sessionPromise = ai.live.connect({
        ...sessionConfig,
        callbacks: {
          onopen: async () => {
            setStatus(ConnectionStatus.CONNECTED);
            connectedRef.current = true;
            addLog("Connected! Say Namaskaaram.", 'system', 'success');
            
            // Resume AudioContexts if suspended (browser policy)
            if (inputAudioContextRef.current?.state === 'suspended') {
              await inputAudioContextRef.current.resume();
            }
            if (outputAudioContextRef.current?.state === 'suspended') {
              await outputAudioContextRef.current.resume();
            }
            
            // Start streaming mic audio
            if (inputAudioContextRef.current && streamRef.current) {
              const source = inputAudioContextRef.current.createMediaStreamSource(streamRef.current);
              const scriptProcessor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
              scriptProcessorRef.current = scriptProcessor;
              
              scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
                if (!connectedRef.current) return;

                const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);
                const pcmBlob = createBlob(inputData);
                
                // Only send if connected
                sessionPromise.then((session) => {
                  if (connectedRef.current) {
                    try {
                      session.sendRealtimeInput({ media: pcmBlob });
                    } catch (e) {
                      console.error("Error sending input", e);
                    }
                  }
                }).catch(e => {
                   // Suppress errors if session isn't ready or failed
                });
              };
              
              source.connect(scriptProcessor);
              scriptProcessor.connect(inputAudioContextRef.current.destination);
            }
          },
          onmessage: async (message: LiveServerMessage) => {
            // Handle Audio Output
            const base64Audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (base64Audio) {
               setIsTalking(true);
               if (outputAudioContextRef.current) {
                const ctx = outputAudioContextRef.current;
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
                
                const audioBuffer = await decodeAudioData(
                  decode(base64Audio),
                  ctx,
                  24000,
                  1
                );

                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                const gainNode = ctx.createGain();
                source.connect(gainNode);
                gainNode.connect(ctx.destination);
                
                source.addEventListener('ended', () => {
                  sourcesRef.current.delete(source);
                  if (sourcesRef.current.size === 0) setIsTalking(false);
                });

                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                sourcesRef.current.add(source);
               }
            }

            // Handle Interruptions
            if (message.serverContent?.interrupted) {
              setIsTalking(false);
              addLog("User interrupted.", 'system');
              sourcesRef.current.forEach(source => source.stop());
              sourcesRef.current.clear();
              nextStartTimeRef.current = 0;
            }

            // Handle Tool Calls
            if (message.toolCall) {
              for (const fc of message.toolCall.functionCalls) {
                addLog(`Babu is processing: ${fc.name}`, 'babu', 'info');
                
                let result = {};
                if (fc.name === 'confirmBooking') {
                  const booking = fc.args as any;
                  setActiveBooking(booking);
                  addLog(`Table reserved for ${booking.people} on ${booking.date} at ${booking.time}.`, 'success' as any, 'success');
                  result = { status: 'confirmed' };
                } else if (fc.name === 'confirmOrder') {
                  const order = fc.args as any;
                  setActiveOrder(order);
                  addLog(`Order placed for ${order.address}.`, 'success' as any, 'success');
                  result = { status: 'confirmed', deliveryTime: '45 mins' };
                }

                // Send tool response back
                sessionPromise.then((session) => {
                  session.sendToolResponse({
                    functionResponses: {
                      id: fc.id,
                      name: fc.name,
                      response: { result },
                    }
                  });
                });
              }
            }
          },
          onclose: () => {
            if (connectedRef.current) {
               setStatus(ConnectionStatus.DISCONNECTED);
               addLog("Connection closed.", 'system');
            }
            connectedRef.current = false;
            disconnectCleanup();
          },
          onerror: (err: any) => {
            console.error("Session error:", err);
            setStatus(ConnectionStatus.ERROR);
            connectedRef.current = false;
            addLog(`Session Error: ${err.message || 'Network or API error'}`, 'system', 'warning');
            disconnectCleanup();
          }
        }
      });
      
      sessionPromiseRef.current = sessionPromise;
      await sessionPromise;

    } catch (e: any) {
      console.error("Connection failed:", e);
      setStatus(ConnectionStatus.ERROR);
      connectedRef.current = false;
      addLog(`Connection failed: ${e.message || "Network Error"}.`, 'system', 'warning');
      disconnectCleanup();
    }
  };

  const disconnectCleanup = () => {
    connectedRef.current = false;
    
    // Stop tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    // Disconnect script processor
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }

    // Close contexts
    if (inputAudioContextRef.current) {
      inputAudioContextRef.current.close();
      inputAudioContextRef.current = null;
    }
    if (outputAudioContextRef.current) {
      outputAudioContextRef.current.close();
      outputAudioContextRef.current = null;
    }
    
    setIsTalking(false);
  };

  const disconnect = () => {
    setStatus(ConnectionStatus.DISCONNECTED);
    disconnectCleanup();
    // Force reload to clear any deep state
    window.location.reload();
  };

  // Auto-scroll logs
  const logsEndRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="min-h-screen bg-stone-100 text-stone-800 flex flex-col md:flex-row font-sans">
      
      {/* Left Panel: Interface */}
      <div className="flex-1 p-6 flex flex-col items-center justify-center relative overflow-hidden">
        {/* Background Decor */}
        <div className="absolute top-0 left-0 w-full h-full opacity-10 pointer-events-none">
           <svg width="100%" height="100%">
             <pattern id="pattern-circles" x="0" y="0" width="40" height="40" patternUnits="userSpaceOnUse">
               <circle cx="20" cy="20" r="2" className="text-orange-900" fill="currentColor" />
             </pattern>
             <rect x="0" y="0" width="100%" height="100%" fill="url(#pattern-circles)" />
           </svg>
        </div>

        <div className="z-10 w-full max-w-md bg-white rounded-3xl shadow-xl overflow-hidden border border-stone-200">
          {/* Header */}
          <div className="bg-orange-600 p-6 text-white text-center">
            <h1 className="text-2xl font-bold tracking-tight">Anakkallumkal Cafe</h1>
            <p className="text-orange-100 text-sm mt-1">Pala, Kottayam</p>
          </div>

          {/* Avatar / Visualizer */}
          <div className="p-8 flex flex-col items-center gap-6 bg-stone-50">
            <div className={`w-32 h-32 rounded-full border-4 flex items-center justify-center bg-white shadow-inner transition-colors duration-500 ${isTalking ? 'border-orange-500' : 'border-stone-300'}`}>
               <span className="text-4xl">☕</span>
            </div>
            
            <div className="h-12 w-full flex items-center justify-center">
               {status === ConnectionStatus.CONNECTED ? (
                  <Visualizer isActive={isTalking || status === ConnectionStatus.CONNECTED} />
               ) : (
                 <span className="text-stone-400 text-sm">Offline</span>
               )}
            </div>

            <div className="text-center space-y-2">
              <p className="font-semibold text-lg text-stone-700">Manager: Babu Joseph</p>
              <p className="text-sm text-stone-500 max-w-[250px]">
                Speak in Malayalam to book a table or order food.
              </p>
            </div>
          </div>

          {/* Controls */}
          <div className="p-6 bg-white border-t border-stone-100 flex justify-center">
            {status === ConnectionStatus.CONNECTED ? (
              <button 
                onClick={disconnect}
                className="bg-red-500 hover:bg-red-600 text-white px-8 py-3 rounded-full font-medium shadow-lg hover:shadow-xl transition-all active:scale-95 flex items-center gap-2"
              >
                End Call
              </button>
            ) : (
              <button 
                onClick={connectToGemini}
                disabled={status === ConnectionStatus.CONNECTING}
                className="bg-orange-600 hover:bg-orange-700 text-white px-8 py-3 rounded-full font-medium shadow-lg hover:shadow-xl transition-all active:scale-95 disabled:opacity-70 flex items-center gap-2"
              >
                {status === ConnectionStatus.CONNECTING ? 'Connecting...' : 'Talk to Babu'}
              </button>
            )}
          </div>
        </div>

        {/* Dynamic Status Cards */}
        <div className="w-full max-w-md mt-6 space-y-4 z-10">
          {activeBooking && (
            <div className="bg-green-50 border border-green-200 p-4 rounded-xl shadow-sm flex items-start gap-3 animate-fade-in-up">
              <div className="bg-green-100 p-2 rounded-full text-green-600">📅</div>
              <div>
                <h3 className="font-bold text-green-800">Booking Confirmed</h3>
                <p className="text-sm text-green-700">
                  Date: {activeBooking.date} <br/>
                  Time: {activeBooking.time} <br/>
                  Pax: {activeBooking.people}
                </p>
              </div>
            </div>
          )}

          {activeOrder && (
            <div className="bg-blue-50 border border-blue-200 p-4 rounded-xl shadow-sm flex items-start gap-3 animate-fade-in-up">
              <div className="bg-blue-100 p-2 rounded-full text-blue-600">🛵</div>
              <div>
                <h3 className="font-bold text-blue-800">Order Placed</h3>
                <p className="text-sm text-blue-700">
                  Address: {activeOrder.address} <br/>
                  Items: {(activeOrder.items || []).join(', ')}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right Panel: Menu & Logs */}
      <div className="md:w-96 bg-white border-l border-stone-200 flex flex-col h-[50vh] md:h-screen">
        
        {/* Tabs or Split */}
        <div className="flex-1 overflow-y-auto p-6 border-b border-stone-100">
          <h2 className="text-lg font-bold text-stone-800 mb-4 flex items-center gap-2">
            <span>📜</span> Menu
          </h2>
          <div className="space-y-4">
            {MENU_ITEMS.map((item, idx) => (
              <div key={idx} className="flex justify-between items-start border-b border-stone-100 pb-3 last:border-0">
                <div>
                  <div className="font-medium text-stone-800">{item.name}</div>
                  <div className="text-xs text-stone-500 mt-0.5">{item.description}</div>
                </div>
                <div className="font-bold text-orange-600">Rs. {item.price}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Logs */}
        <div className="h-1/3 bg-stone-900 text-stone-300 p-4 overflow-y-auto font-mono text-xs flex flex-col gap-2">
          <div className="text-stone-500 uppercase tracking-wider text-[10px] mb-2 font-bold">Session Logs</div>
          {logs.length === 0 && <p className="text-stone-600 italic">Ready to connect...</p>}
          {logs.map((log, i) => (
            <div key={i} className={`flex gap-2 ${log.type === 'warning' ? 'text-yellow-400' : log.type === 'success' ? 'text-green-400' : ''}`}>
              <span className="text-stone-600 shrink-0">[{log.timestamp.toLocaleTimeString([], {hour12: false, hour:'2-digit', minute:'2-digit', second:'2-digit'})}]</span>
              <span className={log.sender === 'babu' ? 'text-orange-400 font-bold' : log.sender === 'system' ? 'text-blue-400' : 'text-stone-300'}>
                {log.sender === 'babu' ? 'Babu: ' : log.sender === 'system' ? '> ' : 'User: '}
                {log.message}
              </span>
            </div>
          ))}
          <div ref={logsEndRef} />
        </div>

      </div>
    </div>
  );
};

export default App;