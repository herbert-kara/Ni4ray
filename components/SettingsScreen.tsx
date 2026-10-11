import React, { useState, useEffect } from 'react';
import { AppSettings, DEFAULT_SETTINGS } from '../types';
import { 
  ShieldCheck, Globe, Wifi, Zap, Lock, Smartphone, RefreshCw, 
  ChevronRight, AlertTriangle, Layers, Split, Download, FolderGit2, Boxes, X, Search 
} from 'lucide-react';
import { nativeShowToast, nativeSetProxySelection } from '../services/nativeBridge';

interface SettingsScreenProps {
  settings: AppSettings;
  onUpdate: (newSettings: AppSettings) => void;
}

interface InstalledApp { pkg: string; label: string; }

const SettingsScreen: React.FC<SettingsScreenProps> = ({ settings, onUpdate }) => {
  const [showAppPicker, setShowAppPicker] = useState(false);
  const [installedApps, setInstalledApps] = useState<InstalledApp[]>([]);
  const [appSearch, setAppSearch] = useState('');
  const [appsLoaded, setAppsLoaded] = useState(false);

  const applyProxy = (mode: string, packages: string[]) => {
    nativeSetProxySelection(mode as any, packages);
  };

  const loadApps = async () => {
    if (appsLoaded) return;
    const bridge = (window as any).Android;
    if (typeof bridge?.listInstalledApps !== 'function') {
      nativeShowToast('Not available outside Android');
      return;
    }
    try {
      const raw = String(bridge.listInstalledApps() || '');
      // "label\tpkg;label\tpkg;..."
      const list: InstalledApp[] = [];
      for (const rec of raw.split(';')) {
        const [label, pkg] = rec.split('\t');
        if (pkg) list.push({ pkg, label: label || pkg });
      }
      list.sort((a, b) => a.label.localeCompare(b.label));
      setInstalledApps(list);
      setAppsLoaded(true);
    } catch {
      nativeShowToast('Failed to load apps');
    }
  };
  
  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const newSettings = { ...settings, [key]: value };
    onUpdate(newSettings);
  };

  const SectionHeader: React.FC<{ title: string; icon: React.ReactNode }> = ({ title, icon }) => (
    <div className="flex items-center gap-2 px-4 py-3 mt-4 text-primary-500 font-semibold text-sm uppercase tracking-wider">
      {icon}
      <span>{title}</span>
    </div>
  );

  const ToggleItem: React.FC<{ 
    label: string; 
    desc?: string; 
    checked: boolean; 
    onChange: (val: boolean) => void 
  }> = ({ label, desc, checked, onChange }) => (
    <div 
      className="flex items-center justify-between p-4 bg-gray-800/40 border-b border-gray-800 hover:bg-gray-800/60 transition-colors cursor-pointer"
      onClick={() => onChange(!checked)}
    >
      <div className="flex-1 pr-4">
        <div className="text-gray-200 font-medium text-sm">{label}</div>
        {desc && <div className="text-xs text-gray-500 mt-1">{desc}</div>}
      </div>
      <div className={`w-11 h-6 rounded-full relative transition-colors duration-200 ${checked ? 'bg-primary-600' : 'bg-gray-700'}`}>
        <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-transform duration-200 ${checked ? 'left-6' : 'left-1'}`}></div>
      </div>
    </div>
  );

  const SelectItem: React.FC<{
    label: string;
    value: string;
    options: { label: string; value: string }[];
    onChange: (val: any) => void;
  }> = ({ label, value, options, onChange }) => (
    <div className="flex flex-col p-4 bg-gray-800/40 border-b border-gray-800">
      <div className="text-gray-200 font-medium text-sm mb-2">{label}</div>
      <select 
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-gray-900 border border-gray-700 text-gray-300 text-sm rounded-lg focus:ring-primary-500 focus:border-primary-500 block w-full p-2.5 outline-none"
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
    </div>
  );

  const InputItem: React.FC<{
    label: string;
    value: string | number;
    placeholder?: string;
    onChange: (val: string) => void;
  }> = ({ label, value, placeholder, onChange }) => (
    <div className="flex flex-col p-4 bg-gray-800/40 border-b border-gray-800">
      <div className="text-gray-200 font-medium text-sm mb-2">{label}</div>
      <input 
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="bg-gray-900 border border-gray-700 text-gray-300 text-sm rounded-lg focus:ring-primary-500 focus:border-primary-500 block w-full p-2.5 outline-none"
      />
    </div>
  );

  return (
    <div className="pb-24 animate-in fade-in duration-300">
      <div className="p-6 text-center border-b border-gray-800 bg-gradient-to-b from-gray-900 to-gray-950">
         <div className="w-16 h-16 bg-gradient-to-br from-cyan-600 to-blue-600 text-white rounded-2xl flex items-center justify-center mx-auto mb-3 shadow-[0_0_20px_rgba(59,130,246,0.3)]">
            <Zap size={32} fill="currentColor" />
         </div>
         <h1 className="text-2xl font-bold text-white tracking-tight">Ni4ray <span className="text-xs align-top bg-gray-800 px-1.5 py-0.5 rounded text-gray-400">v1.2</span></h1>
         <p className="text-gray-500 text-xs mt-1">Advanced V2Ray Client for Android</p>
      </div>

      <div className="bg-gray-900">
        
        {/* ROUTING */}
        <SectionHeader title="Routing & Traffic" icon={<Split size={16} />} />
        <SelectItem 
          label="Routing Mode"
          value={settings.routingMode}
          onChange={(v) => updateSetting('routingMode', v)}
          options={[
            { label: 'Bypass LAN & Iran (Recommended)', value: 'bypass_iran' },
            { label: 'Bypass LAN only', value: 'bypass_lan' },
            { label: 'Global (Proxy Everything)', value: 'global' },
            { label: 'Only Iran (Inverse)', value: 'only_iran' },
          ]}
        />
        <SelectItem 
          label="Domain Strategy"
          value={settings.domainStrategy}
          onChange={(v) => updateSetting('domainStrategy', v)}
          options={[
            { label: 'IPIfNonMatch (Standard)', value: 'IPIfNonMatch' },
            { label: 'IPOnDemand', value: 'IPOnDemand' },
            { label: 'AsIs', value: 'AsIs' },
          ]}
        />

        {/* PER-APP PROXY */}
        <SectionHeader title="Per-App Proxy" icon={<Boxes size={16} />} />
        <SelectItem
          label="Mode"
          value={settings.perAppMode || 'all'}
          onChange={(v) => {
            updateSetting('perAppMode', v as any);
            applyProxy(v, settings.perAppPackages || []);
          }}
          options={[
            { label: 'Proxy all apps', value: 'all' },
            { label: 'Only selected apps', value: 'allow' },
            { label: 'All except selected', value: 'disallow' },
          ]}
        />
        {settings.perAppMode && settings.perAppMode !== 'all' && (
          <div className="p-4 bg-gray-800/40 border-b border-gray-800">
            <div className="flex gap-2">
              <button
                onClick={() => { setShowAppPicker(true); loadApps(); }}
                className="flex-1 px-3 py-2 rounded-lg bg-primary-600 text-white text-xs font-bold hover:bg-primary-500"
              >
                {settings.perAppMode === 'allow' ? 'Select apps to proxy' : 'Select apps to bypass'}
              </button>
              {(settings.perAppPackages || []).length > 0 && (
                <button
                  onClick={() => { updateSetting('perAppPackages', []); applyProxy(settings.perAppMode!, []); }}
                  className="px-3 py-2 rounded-lg bg-gray-700 text-gray-300 text-xs font-bold"
                >
                  Clear ({settings.perAppPackages?.length})
                </button>
              )}
            </div>
            <p className="text-[10px] text-gray-500 mt-2">
              Takes effect on the next connection.
            </p>
          </div>
        )}

        {/* DNS */}
        <SectionHeader title="DNS Settings" icon={<Globe size={16} />} />
        <InputItem 
          label="Remote DNS (Secure)"
          value={settings.remoteDns}
          onChange={(v) => updateSetting('remoteDns', v)}
        />
        <InputItem 
          label="Direct DNS (Local)"
          value={settings.directDns}
          onChange={(v) => updateSetting('directDns', v)}
        />

        {/* ADVANCED CONNECTION */}
        <SectionHeader title="Connection Modes" icon={<Zap size={16} />} />
        <div className="p-3 bg-yellow-900/10 border-l-4 border-yellow-600 mx-4 mb-2 rounded-r">
            <div className="flex gap-2">
                <AlertTriangle size={16} className="text-yellow-600 shrink-0" />
                <p className="text-xs text-yellow-200/80">Features below help bypass heavy censorship but may increase battery usage.</p>
            </div>
        </div>

        <ToggleItem 
          label="Enable Fragment" 
          desc="Split packets to bypass SNI blocking"
          checked={settings.enableFragment}
          onChange={(v) => updateSetting('enableFragment', v)}
        />
        
        {settings.enableFragment && (
          <div className="pl-4 border-l-2 border-primary-900 ml-4 mb-2">
            <InputItem label="Packets Size" value={settings.fragmentSize} onChange={(v) => updateSetting('fragmentSize', v)} />
            <InputItem label="Sleep (ms)" value={settings.fragmentSleep} onChange={(v) => updateSetting('fragmentSleep', v)} />
          </div>
        )}

        <ToggleItem 
          label="Enable Mux" 
          desc="Multiplexing connections"
          checked={settings.enableMux}
          onChange={(v) => updateSetting('enableMux', v)}
        />
        
        {settings.enableMux && (
           <div className="pl-4 border-l-2 border-primary-900 ml-4 mb-2">
              <InputItem label="Concurrency" value={settings.muxConcurrency} onChange={(v) => updateSetting('muxConcurrency', parseInt(v) || 8)} />
           </div>
        )}

        <SectionHeader title="Appearance" icon={<Smartphone size={16} />} />
        <SelectItem
          label="Theme"
          value={settings.theme}
          onChange={(v) => updateSetting('theme', v)}
          options={[
            { label: 'Dark', value: 'dark' },
            { label: 'Light', value: 'light' },
            { label: 'System', value: 'system' },
          ]}
        />

        <SectionHeader title="Security" icon={<Lock size={16} />} />
        <ToggleItem 
          label="Allow Insecure" 
          desc="Ignore TLS certificate errors"
          checked={settings.allowInsecure}
          onChange={(v) => updateSetting('allowInsecure', v)}
        />

        <div className="p-8 text-center">
            <button 
                onClick={() => {
                    localStorage.removeItem('nim4ray_settings');
                    onUpdate(DEFAULT_SETTINGS);
                    applyProxy('all', []);
                    nativeShowToast("Settings Reset");
                }}
                className="text-red-400 text-sm flex items-center justify-center gap-2 hover:text-red-300 w-full py-2"
            >
                <RefreshCw size={14} /> Reset to Defaults
            </button>
        </div>
      </div>

      {/* APP PICKER MODAL */}
      {showAppPicker && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/70 backdrop-blur-sm">
          <div className="flex-1 flex flex-col m-4 mb-0 rounded-t-2xl bg-[#0d1117] border border-gray-700 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <div className="text-sm font-bold text-white">
                {settings.perAppMode === 'allow' ? 'Apps to proxy' : 'Apps to bypass'}
              </div>
              <button onClick={() => setShowAppPicker(false)} className="text-gray-400 hover:text-white">
                <X size={20} />
              </button>
            </div>
            <div className="px-4 py-2 border-b border-gray-800">
              <div className="flex items-center gap-2 bg-gray-900 border border-gray-700 rounded-lg px-3">
                <Search size={14} className="text-gray-500" />
                <input
                  type="text"
                  value={appSearch}
                  onChange={(e) => setAppSearch(e.target.value)}
                  placeholder="Search apps..."
                  className="bg-transparent text-sm text-gray-200 py-2 w-full outline-none"
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto">
              {installedApps
                .filter(a => !appSearch || a.label.toLowerCase().includes(appSearch.toLowerCase()) || a.pkg.includes(appSearch.toLowerCase()))
                .map(a => {
                  const checked = (settings.perAppPackages || []).includes(a.pkg);
                  return (
                    <div
                      key={a.pkg}
                      onClick={() => {
                        const cur = settings.perAppPackages || [];
                        const next = checked ? cur.filter(p => p !== a.pkg) : [...cur, a.pkg];
                        updateSetting('perAppPackages', next);
                        applyProxy(settings.perAppMode || 'all', next);
                      }}
                      className="flex items-center gap-3 px-4 py-2.5 border-b border-gray-800/50 active:bg-gray-800/60 cursor-pointer"
                    >
                      <div className={`w-5 h-5 rounded border-2 flex items-center justify-center shrink-0 ${checked ? 'bg-primary-600 border-primary-600' : 'border-gray-600'}`}>
                        {checked && <span className="text-white text-xs font-bold">✓</span>}
                      </div>
                      <div className="min-w-0">
                        <div className="text-sm text-gray-200 truncate">{a.label}</div>
                        <div className="text-[10px] text-gray-500 truncate">{a.pkg}</div>
                      </div>
                    </div>
                  );
                })}
              {installedApps.length === 0 && (
                <div className="p-8 text-center text-gray-500 text-sm">Loading apps…</div>
              )}
            </div>
            <div className="px-4 py-3 border-t border-gray-800">
              <button
                onClick={() => setShowAppPicker(false)}
                className="w-full py-2.5 rounded-xl bg-primary-600 text-white text-sm font-bold"
              >
                Done ({(settings.perAppPackages || []).length} selected)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default SettingsScreen;