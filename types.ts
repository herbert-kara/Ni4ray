export interface ServerConfig {
  id: string;
  subscriptionId?: string;
  name: string;
  protocol: 'vmess' | 'vless' | 'trojan' | 'shadowsocks' | 'balancer';
  address: string;
  port: number;
  uuid?: string;
  latency?: number; // ms
  location?: string;
  security?: string;
  rawLink?: string;
}

export interface Subscription {
  id: string;
  name: string;
  url: string;
  updatedAt: number;
  serverCount: number;
}

export interface TrafficStats {
  time: string;
  upload: number;
  download: number;
}

export interface AppSettings {
  routingMode: 'global' | 'bypass_lan' | 'bypass_iran' | 'only_iran';
  domainStrategy: 'IPIfNonMatch' | 'IPOnDemand' | 'AsIs';
  remoteDns: string;
  directDns: string;
  enableFragment: boolean;
  fragmentSize: string;
  fragmentSleep: string;
  enableMux: boolean;
  muxConcurrency: number;
  allowInsecure: boolean;
  theme: 'dark' | 'light' | 'system';
  language: 'en' | 'fa';
  perAppMode: 'all' | 'allow' | 'disallow';
  perAppPackages: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  routingMode: 'bypass_iran',
  domainStrategy: 'IPIfNonMatch',
  remoteDns: '9.9.9.9',
  directDns: '1.1.1.1',
  enableFragment: false,
  fragmentSize: '10-20',
  fragmentSleep: '5-10',
  enableMux: false,
  muxConcurrency: 8,
  allowInsecure: false,
  theme: 'dark',
  language: 'fa',
  perAppMode: 'all',
  perAppPackages: []
};

export enum AppTab {
  DASHBOARD = 'dashboard',
  SERVERS = 'servers',
  AI_TOOLS = 'ai_tools',
  SETTINGS = 'settings',
}



declare global {
  interface Window {
    Android?: {
      connect: (configJson: string) => void;
      disconnect: () => void;
      showToast: (message: string) => void;
      copyToClipboard: (text: string) => void;
      getTraffic: () => string;
      measureDelay: (url: string) => Promise<number>;
      measureLatency: (id: string, configJson: string, url: string) => void;
      fetchUrl: (url: string) => string;
      getHostIp: (host: string) => string;
    };
  }
}