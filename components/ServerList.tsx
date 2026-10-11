import React, { useState, useEffect, useRef } from 'react';
import { ServerConfig, Subscription } from '../types';
import { parseSubscription } from '../utils/parsers';
import { generateV2RayConfig } from '../utils/configGenerator';
import { Signal, Trash2, Globe, Plus, RefreshCw, Link as LinkIcon, AlertCircle, Zap, Shuffle, ClipboardList, Activity, ArrowDownUp } from 'lucide-react';
import { isAndroid, nativeShowToast, nativeRequestLatency } from '../services/nativeBridge';

interface ServerListProps {
  servers: ServerConfig[];
  subscriptions: Subscription[];
  selectedId: string | null;
  onSelect: (server: ServerConfig) => void;
  onDeleteServer: (id: string) => void;
  onAddSubscription: (sub: Subscription, servers: ServerConfig[]) => void;
  onImportConfig: (servers: ServerConfig[]) => void;
  onDeleteSubscription: (id: string) => void;
}

const ServerList: React.FC<ServerListProps> = ({ 
  servers, 
  subscriptions, 
  selectedId, 
  onSelect, 
  onDeleteServer, 
  onAddSubscription,
  onImportConfig,
  onDeleteSubscription
}) => {
  const [activeTab, setActiveTab] = useState<'all' | 'subs'>('all');
  
  // Subscription Modal State
  const [isSubModalOpen, setIsSubModalOpen] = useState(false);
  const [subUrl, setSubUrl] = useState('');
  const [subName, setSubName] = useState('');
  
  // Config Import Modal State
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [configInput, setConfigInput] = useState('');

  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [pingingId, setPingingId] = useState<string | null>(null);
  const [latency, setLatency] = useState<Record<string, number>>(() => {
      const s = localStorage.getItem('nim4ray_latency');
      return s ? JSON.parse(s) : {};
  });

  // Keep measured pings across app restarts (they don't live in the server list itself).
  useEffect(() => {
      localStorage.setItem('nim4ray_latency', JSON.stringify(latency));
  }, [latency]);

  // Special Balancer Configurations
  const balancerLowest: ServerConfig = {
      id: 'balancer_lowest',
      name: 'Auto - Lowest Ping',
      protocol: 'balancer',
      address: '127.0.0.1',
      port: 0,
      location: 'Automatic',
      latency: 1
  };

  const balancerRR: ServerConfig = {
      id: 'balancer_rr',
      name: 'Auto - Round Robin',
      protocol: 'balancer',
      address: '127.0.0.1',
      port: 0,
      location: 'Automatic',
      latency: 50
  };

  // Robust fetching with multiple proxies
  const fetchWithBackups = async (url: string): Promise<string> => {
      // Strategy: Native (no CORS) -> Direct -> AllOrigins -> CorsProxy
      // Strip #fragment: landing pages use it for routing, servers ignore it.
      const clean = url.split('#')[0];
      try {
          const bridge = (window as any).Android;
          if (bridge && typeof bridge.fetchUrlAsync === 'function') {
            // Native fetch is off-thread and reports via window.onFetchResult;
            // the blocking variant froze the UI for its whole 8s timeout.
            const native = await new Promise<string>((resolve) => {
              const prev = window.onFetchResult;
              const timer = setTimeout(() => {
                if (window.onFetchResult === onFetch) {
                  if (prev) window.onFetchResult = prev;
                  else delete window.onFetchResult;
                }
                resolve('');
              }, 10000);
              const onFetch = (body: string) => {
                clearTimeout(timer);
                if (window.onFetchResult === onFetch) {
                  if (prev) window.onFetchResult = prev;
                  else delete window.onFetchResult;
                }
                resolve(body || '');
              };
              window.onFetchResult = onFetch;
              bridge.fetchUrlAsync(clean);
            });
            if (native && native.length > 10 && !native.trim().startsWith('<!DOCTYPE')) {
                return native;
            }
          }
      } catch (e) {
          console.warn(`Native fetch failed for ${url}`, e);
      }
      const proxies = [
          (u: string) => u, // Direct try
          (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
          (u: string) => `https://corsproxy.io/?${encodeURIComponent(u)}`
      ];

      for (const proxyGen of proxies) {
          try {
              const target = proxyGen(url);
              console.log(`Fetching via: ${target}`);
              
              const res = await fetch(target);
              if (res.ok) {
                  const text = await res.text();
                  // Basic validation to ensure we didn't get an HTML error page
                  if (text && text.length > 10 && !text.trim().startsWith('<!DOCTYPE')) {
                      return text;
                  }
              }
          } catch (e) {
              console.warn(`Fetch failed for ${url}`, e);
          }
      }
      throw new Error("Unable to fetch subscription from any source.");
  };

  const handleFetchSubscription = async (overrideUrl?: string) => {
    const url = (overrideUrl ?? subUrl).trim();
    if (!url) return;
    setIsLoading(true);
    setErrorMsg('');

    try {
      const text = await fetchWithBackups(url);
      
      const subId = crypto.randomUUID();
      const newServers = parseSubscription(text, subId);

      if (newServers.length === 0) {
        throw new Error("Parsed successfully but no servers found.");
      } else {
        const newSub: Subscription = {
          id: subId,
          name: subName || 'New Subscription',
          url,
          updatedAt: Date.now(),
          serverCount: newServers.length
        };
        onAddSubscription(newSub, newServers);
        setIsSubModalOpen(false);
        setSubUrl('');
        setSubName('');
        nativeShowToast(`Success: ${newServers.length} servers imported`);
      }
    } catch (e: any) {
      console.error(e);
      setErrorMsg(e.message || "Failed to load subscription.");
    } finally {
      setIsLoading(false);
    }
  };

  const handleImportManual = () => {
      if (!configInput.trim()) return;

      const trimmed = configInput.trim();
      // URL? treat as subscription link and fetch it. Otherwise parse as raw config text.
      if (/^https?:\/\//i.test(trimmed) && !trimmed.includes('://vmess') && !trimmed.includes('://vless') && !trimmed.includes('://trojan') && !trimmed.includes('://ss')) {
          setSubUrl(trimmed);
          setIsConfigModalOpen(false);
          setConfigInput('');
          setIsSubModalOpen(true);
          handleFetchSubscription(trimmed);
          return;
      }

      const parsed = parseSubscription(configInput); // subId undefined
      if (parsed.length > 0) {
          onImportConfig(parsed);
          setIsConfigModalOpen(false);
          setConfigInput('');
          setErrorMsg('');
      } else {
          setErrorMsg("Invalid config format.");
      }
  };

  // Real latency of one server through the core (Android only).
  // Native measures off-thread and reports back via window.onLatencyResult.
  const pendingRef = useRef<Record<string, { resolve: (ms: number | null) => void; timer: ReturnType<typeof setTimeout> }>>({});

  useEffect(() => {
    window.onLatencyResult = (id: string, ms: number) => {
      const p = pendingRef.current[id];
      if (!p) return;
      clearTimeout(p.timer);
      delete pendingRef.current[id];
      p.resolve(ms >= 0 && isFinite(ms) ? ms : null);
    };
    return () => { window.onLatencyResult = undefined; };
  }, []);

  const requestOne = (server: ServerConfig): Promise<number | null> =>
    new Promise((resolve) => {
      const ok = nativeRequestLatency(
        server.id,
        generateV2RayConfig(server),
        `https://clients3.google.com/generate_204?t=${Date.now()}`
      );
      if (!ok) {
        resolve(null);
        return;
      }
      const timer = setTimeout(() => {
        delete pendingRef.current[server.id];
        resolve(null);
      }, 20000);
      pendingRef.current[server.id] = { resolve, timer };
    });

  const handlePing = async (server: ServerConfig) => {
      if (pingingId) return;
      setPingingId(server.id);
      try {
          const ms = await requestOne(server);
          if (ms !== null) {
              setLatency(prev => ({ ...prev, [server.id]: Math.round(ms) }));
          } else {
              nativeShowToast(isAndroid() ? "Ping failed" : "Ping needs the Android app");
          }
      } finally {
          setPingingId(null);
      }
  };

  const serverLatency = (s: ServerConfig) => latency[s.id] ?? s.latency;

  // Sort by measured ping: fastest first, never-measured last.
  const [sortByPing, setSortByPing] = useState(false);
  const visibleServers = sortByPing
    ? [...servers].sort((a, b) => (serverLatency(a) ?? Infinity) - (serverLatency(b) ?? Infinity))
    : servers;

  // Measure every server one by one (sequential — the core handles one test config at a time).
  const handlePingAll = async () => {
      if (pingingId || servers.length === 0) return;
      for (const s of servers) {
          if (s.protocol === 'balancer') continue;
          setPingingId(s.id);
          try {
              const ms = await requestOne(s);
                if (ms !== null) {
                    setLatency(prev => ({ ...prev, [s.id]: Math.round(ms) }));
                }
          } catch { /* next server */ }
      }
      setPingingId(null);
      nativeShowToast("Latency test done");
  };

  // Re-fetch every saved subscription URL and merge new servers.
  const handleRefreshAll = async () => {
      if (subscriptions.length === 0 || isLoading) return;
      setIsLoading(true);
      setErrorMsg('');
      let added = 0;
      try {
          for (const sub of subscriptions) {
              try {
                  const text = await fetchWithBackups(sub.url);
                  const parsed = parseSubscription(text, sub.id);
                  const fresh = parsed.filter(ns => !servers.some(s => s.rawLink === ns.rawLink));
                  if (fresh.length > 0) {
                      added += fresh.length;
                      onImportConfig(fresh);
                  }
              } catch (e) {
                  console.warn(`Refresh failed for ${sub.url}`, e);
              }
          }
          nativeShowToast(added > 0 ? `Refreshed: ${added} new servers` : "Subscriptions up to date");
      } finally {
          setIsLoading(false);
      }
  };

  return (
    <div className="w-full max-w-md mx-auto p-4 pb-24 space-y-4">
      {/* Tabs */}
      <div className="flex p-1 bg-gray-800 rounded-lg mb-4">
        <button 
          onClick={() => setActiveTab('all')}
          className={`flex-1 py-2 text-xs font-medium rounded-md transition-all ${activeTab === 'all' ? 'bg-primary-600 text-white shadow-lg' : 'text-gray-400 hover:text-gray-200'}`}
        >
          Servers
        </button>
        <button 
          onClick={() => setActiveTab('subs')}
          className={`flex-1 py-2 text-xs font-medium rounded-md transition-all ${activeTab === 'subs' ? 'bg-primary-600 text-white shadow-lg' : 'text-gray-400 hover:text-gray-200'}`}
        >
          Subscriptions
        </button>
      </div>

      {/* Content */}
      {activeTab === 'all' ? (
        <div className="space-y-4">
          
          {/* LOAD BALANCER SECTION */}
          {servers.length > 0 && (
             <div className="grid grid-cols-2 gap-3 mb-6">
                <div 
                    onClick={() => onSelect(balancerLowest)}
                    className={`relative p-3 rounded-xl border cursor-pointer transition-all flex flex-col items-center justify-center gap-2 text-center
                    ${selectedId === 'balancer_lowest' 
                        ? 'bg-gradient-to-br from-green-900/80 to-green-800/80 border-green-500 shadow-[0_0_15px_rgba(34,197,94,0.3)]' 
                        : 'bg-gray-800/60 border-gray-700 hover:bg-gray-700'}`}
                >
                    <Zap size={20} className={selectedId === 'balancer_lowest' ? "text-green-400 fill-green-400" : "text-gray-400"} />
                    <div>
                        <div className="text-xs font-bold text-white">Lowest Ping</div>
                        <div className="text-[10px] text-gray-400">Auto-select best</div>
                    </div>
                </div>

                <div 
                    onClick={() => onSelect(balancerRR)}
                    className={`relative p-3 rounded-xl border cursor-pointer transition-all flex flex-col items-center justify-center gap-2 text-center
                    ${selectedId === 'balancer_rr' 
                        ? 'bg-gradient-to-br from-blue-900/80 to-blue-800/80 border-blue-500 shadow-[0_0_15px_rgba(59,130,246,0.3)]' 
                        : 'bg-gray-800/60 border-gray-700 hover:bg-gray-700'}`}
                >
                    <Shuffle size={20} className={selectedId === 'balancer_rr' ? "text-blue-400" : "text-gray-400"} />
                    <div>
                        <div className="text-xs font-bold text-white">Round Robin</div>
                        <div className="text-[10px] text-gray-400">Load distribution</div>
                    </div>
                </div>
             </div>
          )}

          <div className="flex justify-between items-center px-1">
             <h2 className="text-xl font-bold text-white">All Servers</h2>
             <div className="flex items-center gap-2">
               {servers.length > 0 && (
                 <>
                 <button
                   onClick={() => setSortByPing(v => !v)}
                   title="Sort servers by ping"
                   className={`text-xs px-2 py-1 rounded-full flex items-center gap-1 disabled:opacity-50 ${sortByPing ? 'text-primary-400 bg-primary-900/40' : 'text-gray-400 bg-gray-900 hover:text-white'}`}
                 >
                   <ArrowDownUp size={11} />
                   Ping
                 </button>
                 <button
                   onClick={handlePingAll}
                   disabled={isLoading || pingingId !== null}
                   title="Measure real delay for all servers"
                   className="text-xs text-gray-400 bg-gray-900 px-2 py-1 rounded-full hover:text-white flex items-center gap-1 disabled:opacity-50"
                 >
                   <Activity size={11} className={pingingId ? "animate-pulse" : ""} />
                   {pingingId ? "Testing…" : "Test all"}
                 </button>
                 </>
               )}
               {subscriptions.length > 0 && (
                 <button
                   onClick={handleRefreshAll}
                   disabled={isLoading}
                   title="Re-fetch all subscriptions"
                   className="text-xs text-gray-400 bg-gray-900 px-2 py-1 rounded-full hover:text-white flex items-center gap-1 disabled:opacity-50"
                 >
                   <RefreshCw size={11} className={isLoading ? "animate-spin" : ""} />
                   Refresh
                 </button>
               )}
               <span className="text-xs text-gray-500 bg-gray-900 px-2 py-1 rounded-full">{servers.length} items</span>
             </div>
          </div>

          {servers.length === 0 && (
            <div className="text-center py-10 text-gray-500 flex flex-col items-center">
                <AlertCircle size={48} className="mb-2 text-gray-700" />
                <p>No servers available.</p>
                <p className="text-sm">Import a subscription or config to get started.</p>
            </div>
          )}
          
          {visibleServers.map((server) => (
            <div 
              key={server.id}
              onClick={() => onSelect(server)}
              className={`relative group rounded-xl p-4 border transition-all duration-200 cursor-pointer overflow-hidden
                ${selectedId === server.id 
                  ? 'bg-gray-800 border-primary-500 shadow-[0_0_15px_rgba(59,130,246,0.2)]' 
                  : 'bg-gray-800/40 border-gray-700 hover:border-gray-600 hover:bg-gray-800/60'
                }`}
            >
              <div className="flex justify-between items-start mb-2 gap-2">
                <div className="flex items-center gap-3 min-w-0 flex-1 overflow-hidden">
                  <div className={`w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-sm shrink-0
                    ${server.protocol === 'vmess' ? 'bg-indigo-600' : 
                      server.protocol === 'vless' ? 'bg-purple-600' : 'bg-teal-600'}`}>
                    {server.protocol.substring(0,2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <h3 className="font-semibold text-gray-100 truncate pr-2 break-all">{server.name}</h3>
                    <div className="flex items-center gap-1 text-xs text-gray-500 min-w-0">
                        <Globe size={10} className="shrink-0" />
                        <span className="truncate">{server.location || 'Unknown'}</span>
                        <span className="mx-1 shrink-0">•</span>
                        <span className="truncate">{server.address}</span>
                    </div>
                  </div>
                </div>
                
                <button
                  onClick={(e) => { e.stopPropagation(); handlePing(server); }}
                  disabled={pingingId !== null}
                  title="Measure real latency"
                  className="flex items-center gap-1 text-xs font-mono shrink-0 hover:bg-gray-700 rounded px-1.5 py-1 transition-colors disabled:opacity-50"
                >
                  <Signal size={12} className={serverLatency(server) ? "text-green-400" : "text-gray-500"} />
                  <span className={serverLatency(server) ? "text-green-400" : "text-gray-500"}>
                    {pingingId === server.id ? '...' : serverLatency(server) ? `${serverLatency(server)}ms` : 'ping'}
                  </span>
                </button>
              </div>
              
              {/* Actions Row */}
              <div className="flex items-center justify-between mt-3 pt-3 border-t border-gray-700/50">
                <div className="text-[10px] text-gray-500 font-mono">
                    {server.protocol.toUpperCase()}
                </div>
                <button 
                    onClick={(e) => { e.stopPropagation(); onDeleteServer(server.id); }}
                    className="p-1.5 text-gray-400 hover:text-red-400 hover:bg-gray-700 rounded-full transition-colors"
                >
                    <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}

          {/* Floating Action Button for Manual Config */}
          <div className="fixed bottom-24 right-4 z-10">
              <button 
                onClick={() => setIsConfigModalOpen(true)}
                className="w-14 h-14 rounded-full bg-primary-600 shadow-lg shadow-primary-900/40 flex items-center justify-center text-white hover:bg-primary-500 transition-all active:scale-95"
              >
                  <Plus size={28} />
              </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
            {/* Subscription List */}
             {subscriptions.map(sub => (
                 <div key={sub.id} className="bg-gray-800/40 border border-gray-700 rounded-xl p-4">
                     <div className="flex justify-between items-start">
                         <div>
                             <h3 className="font-bold text-gray-200">{sub.name}</h3>
                             <p className="text-xs text-gray-500 truncate max-w-[200px] mt-1">{sub.url}</p>
                         </div>
                         <div className="text-xs font-mono bg-gray-900 px-2 py-1 rounded text-primary-400">
                             {sub.serverCount} Servers
                         </div>
                     </div>
                     <div className="flex justify-between items-center mt-4 pt-3 border-t border-gray-700/50">
                         <span className="text-[10px] text-gray-600">Updated: {new Date(sub.updatedAt).toLocaleDateString()}</span>
                         <div className="flex gap-2">
                             <button className="p-2 text-primary-400 hover:bg-gray-700 rounded-lg"><RefreshCw size={14} /></button>
                             <button onClick={() => onDeleteSubscription(sub.id)} className="p-2 text-red-400 hover:bg-gray-700 rounded-lg"><Trash2 size={14} /></button>
                         </div>
                     </div>
                 </div>
             ))}

             <button 
                onClick={() => setIsSubModalOpen(true)}
                className="w-full py-4 border-2 border-dashed border-gray-700 text-gray-500 rounded-xl hover:border-gray-500 hover:text-gray-300 transition-all flex items-center justify-center gap-2"
            >
                <Plus size={18} />
                <span>Add Subscription Link</span>
            </button>
        </div>
      )}

      {/* Manual Config Import Modal */}
      {isConfigModalOpen && (
          <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-sm p-6 shadow-2xl">
                <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                    <ClipboardList size={20} className="text-primary-500" />
                    Import Config
                </h3>
                
                <div className="space-y-4">
                    <div>
                        <label className="text-xs text-gray-500 block mb-1">Paste config (vmess://, vless://...)</label>
                        <textarea 
                            className="w-full h-32 bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-xs font-mono focus:ring-2 focus:ring-primary-500 outline-none resize-none"
                            placeholder="vmess://..."
                            value={configInput}
                            onChange={(e) => setConfigInput(e.target.value)}
                        />
                    </div>
                </div>

                {errorMsg && (
                    <div className="mt-4 p-3 bg-red-900/50 border border-red-700 rounded-lg text-xs text-red-200 flex items-start gap-2">
                        <AlertCircle size={14} className="mt-0.5 shrink-0" />
                        <span>{errorMsg}</span>
                    </div>
                )}

                <div className="flex gap-3 mt-6">
                    <button 
                        onClick={() => { setIsConfigModalOpen(false); setErrorMsg(''); setConfigInput(''); }}
                        className="flex-1 py-2 rounded-lg text-gray-400 hover:bg-gray-800 text-sm font-medium"
                    >
                        Cancel
                    </button>
                    <button 
                        onClick={handleImportManual}
                        disabled={!configInput.trim()}
                        className="flex-1 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-500 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        Import
                    </button>
                </div>
            </div>
        </div>
      )}

      {/* Add Subscription Modal */}
      {isSubModalOpen && (
        <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-center justify-center p-4">
            <div className="bg-gray-900 border border-gray-700 rounded-2xl w-full max-w-sm p-6 shadow-2xl">
                <h3 className="text-lg font-bold text-white mb-4 flex items-center gap-2">
                    <LinkIcon size={20} className="text-primary-500" />
                    Add Subscription
                </h3>
                
                <div className="space-y-4">
                    <div>
                        <label className="text-xs text-gray-500 block mb-1">Name (Optional)</label>
                        <input 
                            type="text" 
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none"
                            placeholder="My V2Ray Sub"
                            value={subName}
                            onChange={(e) => setSubName(e.target.value)}
                        />
                    </div>
                    <div>
                        <label className="text-xs text-gray-500 block mb-1">Subscription URL</label>
                        <input 
                            type="text" 
                            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-white text-sm focus:ring-2 focus:ring-primary-500 outline-none"
                            placeholder="https://example.com/sub/..."
                            value={subUrl}
                            onChange={(e) => setSubUrl(e.target.value)}
                        />
                    </div>
                </div>

                {errorMsg && (
                    <div className="mt-4 p-3 bg-red-900/50 border border-red-700 rounded-lg text-xs text-red-200 flex items-start gap-2">
                        <AlertCircle size={14} className="mt-0.5 shrink-0" />
                        <span>{errorMsg}</span>
                    </div>
                )}

                <div className="flex gap-3 mt-6">
                    <button 
                        onClick={() => { setIsSubModalOpen(false); setErrorMsg(''); }}
                        className="flex-1 py-2 rounded-lg text-gray-400 hover:bg-gray-800 text-sm font-medium"
                    >
                        Cancel
                    </button>
                    <button 
                        onClick={() => handleFetchSubscription()}
                        disabled={isLoading || !subUrl}
                        className="flex-1 py-2 rounded-lg bg-primary-600 text-white text-sm font-medium hover:bg-primary-500 disabled:opacity-50 flex items-center justify-center gap-2"
                    >
                        {isLoading ? <RefreshCw className="animate-spin" size={14} /> : 'Import'}
                    </button>
                </div>
            </div>
        </div>
      )}
    </div>
  );
};

export default ServerList;