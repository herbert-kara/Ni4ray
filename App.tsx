import React, { useState, useEffect } from 'react';
import { ServerConfig, Subscription, AppTab, AppSettings, DEFAULT_SETTINGS } from './types';
import Dashboard from './components/Dashboard';
import ServerList from './components/ServerList';
import SettingsScreen from './components/SettingsScreen';
import { LayoutDashboard, Server, Bot, Settings } from 'lucide-react';
import { nativeShowToast } from './services/nativeBridge';
import NetworkTester from './components/NetworkTester';
import { generateV2RayConfig } from './utils/configGenerator';

const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<AppTab>(AppTab.DASHBOARD);
  
  // Data State
  const [servers, setServers] = useState<ServerConfig[]>(() => {
      const saved = localStorage.getItem('v2ray_servers');
      return saved ? JSON.parse(saved) : [];
  });
  
  const [subscriptions, setSubscriptions] = useState<Subscription[]>(() => {
      const saved = localStorage.getItem('v2ray_subs');
      return saved ? JSON.parse(saved) : [];
  });

  const [settings, setSettings] = useState<AppSettings>(() => {
      try {
        const saved = localStorage.getItem('nim4ray_settings');
        if (saved) {
          const parsed = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
          // Migrate stale stored values to current defaults (one field at a time).
          if ((JSON.parse(saved) as any).remoteDns === '8.8.8.8') parsed.remoteDns = DEFAULT_SETTINGS.remoteDns;
          return parsed;
        }
      } catch { /* corrupted storage -> defaults */ }
      return DEFAULT_SETTINGS;
  });

  const [selectedServer, setSelectedServer] = useState<ServerConfig | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [showToast, setShowToast] = useState(false);

  // Persistence Effects
  useEffect(() => {
    localStorage.setItem('v2ray_servers', JSON.stringify(servers));
  }, [servers]);

  useEffect(() => {
    localStorage.setItem('v2ray_subs', JSON.stringify(subscriptions));
  }, [subscriptions]);

  useEffect(() => {
    localStorage.setItem('nim4ray_settings', JSON.stringify(settings));
  }, [settings]);

  // Handle auto-select first server if none selected
  useEffect(() => {
      if (!selectedServer && servers.length > 0) {
          setSelectedServer(servers[0]);
      }
  }, [servers]);

  // Setup callbacks from Android Java
  useEffect(() => {
      (window as any).onVpnConnected = () => {
          setIsConnected(true);
          setShowToast(true);
          setTimeout(() => setShowToast(false), 3000);
      };
      
      (window as any).onVpnPermissionDenied = () => {
          setIsConnected(false);
          nativeShowToast("VPN Permission Required");
      };
  }, []);

  const handleConnectToggle = () => {
    if (!selectedServer) {
        nativeShowToast("Please add and select a server first");
        return;
    }
    
    // Logic for Disconnecting
    if (isConnected) {
        setIsConnected(false);
        if (window.Android?.disconnect) {
            window.Android.disconnect();
        }
        return;
    }

    // Logic for Connecting
    let targetServer = selectedServer;

    // Load Balancing Logic (Simplified for now, picks one)
    if (selectedServer.id === 'balancer_lowest' && servers.length > 0) {
        const best = [...servers].sort((a, b) => (a.latency || 9999) - (b.latency || 9999))[0];
        targetServer = best;
        nativeShowToast(`Auto-Selected: ${best.name} (${best.latency}ms)`);
    } else if (selectedServer.id === 'balancer_rr' && servers.length > 0) {
        const randomIdx = Math.floor(Math.random() * servers.length);
        targetServer = servers[randomIdx];
        nativeShowToast(`Load Balancing: Connected to ${targetServer.name}`);
    }
    
    // GENERATE REAL XRAY JSON
    try {
        const fullConfigJson = generateV2RayConfig(targetServer, settings);
        
        if (window.Android?.connect) {
            window.Android.connect(fullConfigJson);
        } else {
            // Mock connection for browser dev
            console.log("Generated Xray Config:", fullConfigJson);
            setIsConnected(true);
            setShowToast(true);
            setTimeout(() => setShowToast(false), 3000);
        }
    } catch (e) {
        console.error("Config Generation Failed", e);
        nativeShowToast("Error generating config");
    }
  };

  const handleAddSubscription = (sub: Subscription, newServers: ServerConfig[]) => {
      const uniqueNewServers = newServers.filter(ns => !servers.some(s => s.rawLink === ns.rawLink));
      setSubscriptions(prev => [...prev, sub]);
      setServers(prev => [...prev, ...uniqueNewServers]);
      nativeShowToast(`Added ${uniqueNewServers.length} servers`);
  };

  const handleImportConfig = (importedServers: ServerConfig[]) => {
      const uniqueNewServers = importedServers.filter(ns => !servers.some(s => s.rawLink === ns.rawLink));
      if (uniqueNewServers.length === 0) {
          nativeShowToast("Config already exists or invalid");
          return;
      }
      setServers(prev => [...prev, ...uniqueNewServers]);
      nativeShowToast(`Imported ${uniqueNewServers.length} configs`);
  };

  const handleDeleteSubscription = (id: string) => {
      setSubscriptions(prev => prev.filter(s => s.id !== id));
      setServers(prev => prev.filter(s => s.subscriptionId !== id));
      if (selectedServer?.subscriptionId === id) {
          setSelectedServer(null);
          setIsConnected(false);
      }
  };

  const handleDeleteServer = (id: string) => {
    setServers(prev => prev.filter(s => s.id !== id));
    if (selectedServer?.id === id) {
        setSelectedServer(null);
        setIsConnected(false);
    }
  };

  const renderContent = () => {
    switch (activeTab) {
      case AppTab.DASHBOARD:
        return (
          <Dashboard
            activeServer={selectedServer}
            isConnected={isConnected}
            settings={settings}
            onConnectToggle={handleConnectToggle}
          />
        );
      case AppTab.SERVERS:
        return (
          <ServerList 
            servers={servers}
            subscriptions={subscriptions}
            selectedId={selectedServer?.id || null}
            onSelect={(s) => {
                setSelectedServer(s);
                nativeShowToast(s.protocol === 'balancer' ? `Mode: ${s.name}` : `Selected ${s.name}`);
            }}
            onDeleteServer={handleDeleteServer}
            onAddSubscription={handleAddSubscription}
            onImportConfig={handleImportConfig}
            onDeleteSubscription={handleDeleteSubscription}
          />
        );
      case AppTab.AI_TOOLS:
        return (
          <NetworkTester />
        );
      case AppTab.SETTINGS:
        return (
          <SettingsScreen
            settings={settings}
            onUpdate={setSettings}
          />
        );
      default:
        return null;
    }
  };

  const lightMode = settings.theme === 'light' ||
    (settings.theme === 'system' && typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-color-scheme: light)').matches);

  return (
    <div className={`flex flex-col h-screen w-full bg-[#0d1117] text-gray-200 font-sans overflow-hidden relative${lightMode ? ' theme-light' : ''}`}>
      
      {/* Top Bar */}
      <div className="h-14 border-b border-gray-800 flex items-center justify-between px-3 sm:px-4 bg-[#0d1117]/90 backdrop-blur-md z-20">
        <div className="font-bold text-lg tracking-tight flex items-center gap-2 cursor-pointer" onClick={() => setActiveTab(AppTab.DASHBOARD)}>
            <LayoutDashboard size={32} className="shadow-lg shadow-cyan-500/20" />
            <span className="text-xl tracking-tighter text-white">Ni4ray</span>
        </div>


      </div>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto no-scrollbar relative bg-[#0d1117]">
        {renderContent()}
      </main>

      {/* Toast Notification */}
      <div className={`absolute top-16 left-1/2 transform -translate-x-1/2 bg-green-600/90 backdrop-blur text-white px-6 py-2.5 rounded-full text-sm font-semibold shadow-[0_4px_20px_rgba(22,163,74,0.4)] transition-all duration-300 pointer-events-none z-50 flex items-center gap-2 ${showToast ? 'translate-y-0 opacity-100' : '-translate-y-4 opacity-0'}`}>
        <div className="w-2 h-2 bg-white rounded-full animate-pulse"></div>
        Ni4ray Secured
      </div>

      {/* Bottom Navigation */}
      <nav className="h-[84px] bg-[#0b0e14] border-t border-gray-800 flex justify-around items-center px-2 pb-5 z-20 shadow-[0_-5px_20px_rgba(0,0,0,0.5)]">
        <NavButton 
            active={activeTab === AppTab.DASHBOARD} 
            onClick={() => setActiveTab(AppTab.DASHBOARD)}
            icon={<LayoutDashboard size={22} />}
            label="Home"
        />
        <NavButton 
            active={activeTab === AppTab.SERVERS} 
            onClick={() => setActiveTab(AppTab.SERVERS)}
            icon={<Server size={22} />}
            label="Servers"
        />
        
        {/* Floating AI Action Button */}
        <div className="relative -top-6">
            <button 
                onClick={() => setActiveTab(AppTab.AI_TOOLS)}
                className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-2xl transition-all duration-300 border-4 border-[#0d1117] group
                ${activeTab === AppTab.AI_TOOLS ? 'bg-white text-black scale-105 rotate-3' : 'bg-primary-600 text-white hover:bg-primary-500'}`}
                title="Network Test"
            >
                <Bot size={26} className={activeTab === AppTab.AI_TOOLS ? "text-primary-600" : "text-white"} />
                <div className={`absolute inset-0 rounded-2xl bg-primary-500 blur-xl opacity-40 -z-10 transition-opacity ${activeTab === AppTab.AI_TOOLS ? 'opacity-60' : ''}`}></div>
            </button>
        </div>

        <NavButton 
            active={activeTab === AppTab.SETTINGS} 
            onClick={() => setActiveTab(AppTab.SETTINGS)}
            icon={<Settings size={22} />}
            label="Settings"
        />
      </nav>
    </div>
  );
};

interface NavButtonProps {
    active: boolean;
    onClick: () => void;
    icon: React.ReactNode;
    label: string;
}

const NavButton: React.FC<NavButtonProps> = ({ active, onClick, icon, label }) => (
    <button 
        onClick={onClick}
        className={`flex flex-col items-center justify-center w-16 h-full transition-all duration-200
        ${active ? 'text-primary-500' : 'text-gray-500 hover:text-gray-300'}`}
    >
        <div className={`mb-1.5 transition-transform duration-200 ${active ? '-translate-y-1 scale-110' : ''}`}>
            {icon}
        </div>
        <span className={`text-[10px] font-bold tracking-wide ${active ? 'opacity-100' : 'opacity-70'}`}>{label}</span>
    </button>
);

export default App;