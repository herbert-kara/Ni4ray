import React, { useState, useEffect } from 'react';
import { ArrowUp, ArrowDown, Activity, ShieldCheck, MapPin, Zap } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { ServerConfig, TrafficStats, AppSettings } from '../types';
import { nativeConnect, nativeDisconnect, nativeGetTrafficAsync, nativeMeasureDelayAsync, nativeResolveIpAsync, nativeIpInfoAsync, parseIpInfo, parseTraffic, IpInfo } from '../services/nativeBridge';

interface DashboardProps {
  activeServer: ServerConfig | null;
  isConnected: boolean;
  settings: AppSettings;
  onConnectToggle: () => void;
}

const emptyTraffic = (): TrafficStats[] =>
  Array.from({ length: 30 }, () => ({ time: '', upload: 0, download: 0 }));

const Dashboard: React.FC<DashboardProps> = ({ activeServer, isConnected, settings, onConnectToggle }) => {
  const [trafficData, setTrafficData] = useState<TrafficStats[]>(emptyTraffic);
  const [duration, setDuration] = useState(0);
  const [realPing, setRealPing] = useState<number | null>(null);
  const [endpointIp, setEndpointIp] = useState<string | null>(null);
  const [endpointInfo, setEndpointInfo] = useState<IpInfo | null>(null);

  // Resolve server IP + country/flag. Both native calls are async: the
  // synchronous versions block the WebView thread (getAllByName / HTTP fetch
  // each held it for seconds while the tunnel was up -> the UI froze).
  useEffect(() => {
    setEndpointIp(null);
    setEndpointInfo(null);
    if (!activeServer) return;
    let cancelled = false;
    const host = activeServer.address;
    const startIpInfo = (ip: string) => {
      if (cancelled) return;
      setEndpointIp(ip);
      // Route the fetch result by the query field so a late answer for a
      // previous server can't overwrite the current one.
      const prev = window.onFetchResult;
      const onFetch = (body: string) => {
        if (cancelled) return;
        const info = parseIpInfo(body);
        if (info && (!info.query || info.query === ip)) setEndpointInfo(info);
        if (window.onFetchResult === onFetch) {
          if (prev) window.onFetchResult = prev;
          else delete window.onFetchResult;
        }
      };
      window.onFetchResult = onFetch;
      nativeIpInfoAsync(ip);
    };
    const prevResolve = window.onResolveResult;
    const onResolve = (ip: string) => {
      if (cancelled || !ip) return;
      startIpInfo(ip);
      if (window.onResolveResult === onResolve) {
        if (prevResolve) window.onResolveResult = prevResolve;
        else delete window.onResolveResult;
      }
    };
    window.onResolveResult = onResolve;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      startIpInfo(host);
    } else {
      nativeResolveIpAsync(host);
    }
    return () => {
      cancelled = true;
      if (window.onResolveResult === onResolve) {
        if (prevResolve) window.onResolveResult = prevResolve;
        else delete window.onResolveResult;
      }
    };
  }, [activeServer?.address]);

  // Real latency through the running core. Fully async: the native side runs
  // the measurement on its own thread and delivers via window.onDelayResult.
  // A blocking bridge call here froze the UI while the tunnel was starting.
  useEffect(() => {
    if (!isConnected) {
      setRealPing(null);
      return;
    }
    let cancelled = false;
    const onDelay = (ms: number) => {
      if (!cancelled) setRealPing(ms >= 0 ? ms : null);
    };
    window.onDelayResult = onDelay;
    const tick = () => {
      if (!cancelled) nativeMeasureDelayAsync(`https://clients3.google.com/generate_204?t=${Date.now()}`);
    };
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (window.onDelayResult === onDelay) delete window.onDelayResult;
    };
  }, [isConnected, activeServer]);

  // Real traffic from the core's counters, delivered via window.onTraffic.
  // NOTE: the core resets its counters on every query, so each reading is
  // already the per-second delta.
  useEffect(() => {
    if (!isConnected) {
      setDuration(0);
      setTrafficData(emptyTraffic());
      return;
    }
    let cancelled = false;
    const onTraffic = (raw: string) => {
      if (cancelled) return;
      const cur = parseTraffic(raw);
      setTrafficData(prev => {
        const newData = [...prev.slice(1)];
        newData.push({
          time: new Date().toLocaleTimeString([], { hour12: false, minute: '2-digit', second: '2-digit' }),
          upload: Math.round((cur ? cur.up : 0) / 1024),
          download: Math.round((cur ? cur.down : 0) / 1024),
        });
        return newData;
      });
    };
    window.onTraffic = onTraffic;
    const id = setInterval(() => {
      setDuration(prev => prev + 1);
      if (!cancelled) nativeGetTrafficAsync();
    }, 1000);
    return () => {
      cancelled = true;
      clearInterval(id);
      if (window.onTraffic === onTraffic) delete window.onTraffic;
    };
  }, [isConnected]);

  const handlePowerClick = () => {
    if (!activeServer) return;
    if (isConnected) {
        nativeDisconnect();
    } else {
        nativeConnect(activeServer, settings);
    }
    onConnectToggle();
  };

  const formatTime = (seconds: number) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const currentUp = isConnected ? trafficData[trafficData.length - 1].upload : 0;
  const currentDown = isConnected ? trafficData[trafficData.length - 1].download : 0;

  // Format Bytes helper
  const formatBytes = (kb: number) => {
      if (kb > 1024) return `${(kb / 1024).toFixed(1)} MB/s`;
      return `${kb} KB/s`;
  };

  return (
    <div className="flex flex-col items-center h-full w-full max-w-md mx-auto p-4 space-y-5">
      
      {/* Header Info */}
      <div className="w-full flex justify-between items-center text-gray-400 text-xs font-mono uppercase tracking-wider mt-1">
        <div className="flex items-center gap-1.5">
          <ShieldCheck size={14} className={isConnected ? "text-green-500" : "text-gray-600"} />
          <span className={isConnected ? "text-green-500 shadow-green-500/50 drop-shadow-sm" : ""}>{isConnected ? "SECURE" : "UNSECURED"}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <MapPin size={14} />
          <span>
            {activeServer
              ? (endpointInfo?.flag ? `${endpointInfo.flag} ` : '') +
                (endpointIp || activeServer.address) +
                (endpointInfo?.country ? ` • ${endpointInfo.country}` : '')
              : "---"}
          </span>
        </div>
      </div>

      {/* THE PILOT SWITCH */}
      <div className="relative py-4">
        <div className={`absolute inset-0 rounded-3xl blur-2xl transition-all duration-700 opacity-20
            ${isConnected ? "bg-green-500" : "bg-red-600"}`}></div>
            
        <div 
            onClick={handlePowerClick}
            className="relative cursor-pointer group select-none"
        >
            <div className="w-36 h-60 bg-gradient-to-b from-gray-700 to-gray-800 rounded-lg border-2 border-gray-600 shadow-[0_10px_30px_rgba(0,0,0,0.5),inset_0_1px_1px_rgba(255,255,255,0.1)] flex flex-col items-center p-3 relative overflow-hidden">
                <div className="absolute top-2 left-2 w-1.5 h-1.5 rounded-full bg-gray-500 shadow-[inset_0_1px_1px_rgba(0,0,0,0.8)]"><div className="w-1 h-px bg-gray-700 -rotate-45 m-auto mt-[2px]"></div></div>
                <div className="absolute top-2 right-2 w-1.5 h-1.5 rounded-full bg-gray-500 shadow-[inset_0_1px_1px_rgba(0,0,0,0.8)]"><div className="w-1 h-px bg-gray-700 -rotate-45 m-auto mt-[2px]"></div></div>
                <div className="absolute bottom-2 left-2 w-1.5 h-1.5 rounded-full bg-gray-500 shadow-[inset_0_1px_1px_rgba(0,0,0,0.8)]"><div className="w-1 h-px bg-gray-700 -rotate-45 m-auto mt-[2px]"></div></div>
                <div className="absolute bottom-2 right-2 w-1.5 h-1.5 rounded-full bg-gray-500 shadow-[inset_0_1px_1px_rgba(0,0,0,0.8)]"><div className="w-1 h-px bg-gray-700 -rotate-45 m-auto mt-[2px]"></div></div>

                {/* Status LED */}
                <div className="w-full flex justify-center mb-4 mt-1">
                    <div className={`w-3 h-3 rounded-full border border-black/50 transition-all duration-300
                        ${isConnected 
                            ? 'bg-green-400 shadow-[0_0_15px_#4ade80]' 
                            : 'bg-red-900 shadow-none'}`} 
                    />
                </div>

                {/* Track */}
                <div className="w-14 flex-1 bg-black rounded border border-gray-600 shadow-[inset_0_0_10px_rgba(0,0,0,1)] relative p-1 mb-2">
                    <div className={`w-full h-1/2 rounded bg-gradient-to-t from-red-800 via-red-600 to-red-500 border-t border-red-400 shadow-lg transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] flex flex-col justify-center items-center gap-1 z-10
                        ${isConnected ? 'translate-y-0' : 'translate-y-full'}`}
                    >
                        <div className="w-8 h-0.5 bg-black/30 shadow-[0_1px_0_rgba(255,255,255,0.2)]"></div>
                        <div className="w-8 h-0.5 bg-black/30 shadow-[0_1px_0_rgba(255,255,255,0.2)]"></div>
                        <div className="w-8 h-0.5 bg-black/30 shadow-[0_1px_0_rgba(255,255,255,0.2)]"></div>
                    </div>
                </div>

                <div className="text-center space-y-1">
                    <div className="text-[9px] text-gray-400 font-mono tracking-widest opacity-60">MAIN POWER</div>
                    <div className={`text-[10px] font-bold font-mono tracking-wider transition-colors duration-300 ${isConnected ? 'text-white text-shadow-green' : 'text-gray-600'}`}>
                        {isConnected ? 'ENGAGED' : 'OFF'}
                    </div>
                </div>
            </div>
        </div>
      </div>

      {/* Timer Display */}
      <div className={`font-mono text-xl tracking-widest transition-colors duration-500 ${isConnected ? "text-green-500" : "text-gray-700"}`}>
        {isConnected ? formatTime(duration) : "00:00:00"}
      </div>

      {/* Server Display with Real Ping */}
      <div className="bg-gray-800/50 rounded-xl p-4 w-full border border-gray-700 backdrop-blur-sm">
        <div className="flex items-center justify-between mb-2">
             <div className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold">Current Endpoint</div>
             {isConnected && (
                 <div className={`flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded ${realPing ? (realPing < 200 ? 'text-green-400 bg-green-900/30' : 'text-yellow-400 bg-yellow-900/30') : 'text-gray-500'}`}>
                     <Activity size={10} />
                     {realPing ? `${realPing}ms` : 'Ping...'}
                 </div>
             )}
        </div>
        <div className="flex items-center justify-between gap-2">
            <div className="font-medium text-white truncate flex-1 min-w-0 flex items-center gap-2">
                <Zap size={16} className={`${isConnected ? "text-yellow-400 fill-yellow-400" : "text-gray-600"} shrink-0`} />
                <span className="truncate">{activeServer ? activeServer.name : "Select a server"}</span>
            </div>
            <div className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider shrink-0 ${activeServer?.protocol === 'vless' ? 'bg-purple-900/50 text-purple-300 border border-purple-700' : 'bg-blue-900/50 text-blue-300 border border-blue-700'}`}>
                {activeServer?.protocol || "N/A"}
            </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-2 gap-4 w-full">
        <div className="bg-gray-800/30 rounded-xl p-3 border border-gray-700/50 flex flex-col items-center relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-green-500/20"></div>
            <div className="flex items-center gap-2 text-gray-400 mb-1 w-full pl-2">
                <ArrowDown size={14} className="text-green-400" />
                <span className="text-[10px] uppercase font-bold tracking-wider">Download</span>
            </div>
            <div className="text-lg font-bold font-mono text-white w-full pl-2">
                {formatBytes(currentDown)}
            </div>
        </div>
        <div className="bg-gray-800/30 rounded-xl p-3 border border-gray-700/50 flex flex-col items-center relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-orange-500/20"></div>
            <div className="flex items-center gap-2 text-gray-400 mb-1 w-full pl-2">
                <ArrowUp size={14} className="text-orange-400" />
                <span className="text-[10px] uppercase font-bold tracking-wider">Upload</span>
            </div>
            <div className="text-lg font-bold font-mono text-white w-full pl-2">
                 {formatBytes(currentUp)}
            </div>
        </div>
      </div>

      {/* Graph */}
      <div className="w-full h-32 bg-gray-900/50 rounded-xl border border-gray-700/50 overflow-hidden relative shadow-inner">
        <div className="absolute top-2 left-3 flex items-center gap-2 text-[10px] text-gray-500 z-10 font-mono uppercase tracking-widest">
            <Activity size={10} />
            <span>Real-time Traffic</span>
        </div>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={trafficData}>
            <defs>
              <linearGradient id="colorDown" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#22c55e" stopOpacity={0.2}/>
                <stop offset="95%" stopColor="#22c55e" stopOpacity={0}/>
              </linearGradient>
            </defs>
            <XAxis dataKey="time" hide />
            <YAxis hide domain={[0, 'auto']} />
            <Tooltip 
                contentStyle={{ backgroundColor: '#111827', border: '1px solid #374151', borderRadius: '4px', fontSize: '12px' }}
                itemStyle={{ color: '#fff' }}
                cursor={{ stroke: '#374151', strokeWidth: 1 }}
            />
            <Area 
                type="monotone" 
                dataKey="download" 
                stroke="#22c55e" 
                fillOpacity={1} 
                fill="url(#colorDown)" 
                strokeWidth={1.5}
                isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};

export default Dashboard;