import { ServerConfig, AppSettings } from '../types';
import { generateV2RayConfig } from '../utils/configGenerator';

export const isAndroid = (): boolean => {
  return typeof window !== 'undefined' && 
         typeof window.Android !== 'undefined' && 
         typeof window.Android.connect === 'function';
};

// NOTE: @JavascriptInterface methods MUST be invoked directly on window.Android.
// Detaching them (const fn = Android.foo; fn()) breaks the bridge with
// "can't be invoked on a non-injected object".
const android = (): any | null =>
  (typeof window !== 'undefined' && (window as any).Android) || null;

export const nativeConnect = (server: ServerConfig, settings?: AppSettings) => {
  if (isAndroid()) {
    try {
      const cfg = generateV2RayConfig(server, settings);
      const bridge = android();
      // Push per-app selection first — the VPN builder reads it at establish() time.
      if (settings && typeof bridge?.setProxySelection === 'function') {
        const mode = settings.perAppMode || 'all';
        bridge.setProxySelection(mode, mode === 'all' ? '' : (settings.perAppPackages || []).join(','));
      }
      if (typeof bridge?.connectWithName === 'function') bridge.connectWithName(cfg, server.name);
      else bridge?.connect(cfg);
    } catch (e) {
      console.error("Bridge Error:", e);
    }
  } else {
    console.log("Mock Connection (Browser Environment):", server.name);
  }
};

export const nativeDisconnect = () => {
  if (isAndroid()) {
    android()?.disconnect();
  } else {
    console.log("Mock Disconnection");
  }
};

// Per-app proxy selection, applied on the next connect. mode: all | allow | disallow.
export const nativeSetProxySelection = (mode: 'all' | 'allow' | 'disallow', packages: string[]) => {
  if (isAndroid()) {
    android()?.setProxySelection(mode, packages.join(','));
  }
};

export const nativeShowToast = (msg: string) => {
  if (isAndroid()) {
    android()?.showToast(msg);
  } else {
    console.log("Toast:", msg);
  }
};

export interface CoreTraffic { up: number; down: number; }

// Parse the core's raw counter string: "tag,direction,value;...".
// Real keys observed on-device: uplink / downlink.
export const parseTraffic = (raw: string): CoreTraffic | null => {
  if (typeof raw !== 'string' || !raw) return { up: 0, down: 0 };
  let up = 0, down = 0;
  for (const part of raw.split(';')) {
    const f = part.split(',');
    if (f.length !== 3) continue;
    const v = Number(f[2]);
    if (!isFinite(v)) continue;
    if (f[1] === 'up' || f[1] === 'uplink') up += v;
    else if (f[1] === 'down' || f[1] === 'downlink') down += v;
  }
  return { up, down };
};

// Per-interval bytes counted by the Xray core. NOTE: the core RESETS its
// counters on every query, so each non-empty reading is the delta since the
// last call — not a cumulative total. Empty string = no traffic since last query.
export const nativeGetTraffic = (): CoreTraffic | null => {
  try {
    const bridge = android();
    if (typeof bridge?.getTraffic !== 'function') return null;
    return parseTraffic(String(bridge.getTraffic() || ''));
  } catch { return null; }
};

// Resolve a hostname to its IP. Async: result via window.onResolveResult(ip).
// The native side runs it off-thread; the synchronous variant blocked the UI.
export const nativeResolveIpAsync = (host: string): boolean => {
  try {
    const bridge = android();
    if (typeof bridge?.resolveHostAsync !== 'function') return false;
    bridge.resolveHostAsync(host);
    return true;
  } catch { return false; }
};

// Resolve a hostname to its IP via the native side (no DNS/CORS issues in JS).
// Synchronous — only for pre-connect use while the tunnel is still down.
export const nativeResolveIp = (host: string): string | null => {
  try {
    const bridge = android();
    if (typeof bridge?.getHostIp !== 'function') return null;
    const ip = String(bridge.getHostIp(host) || '');
    return ip ? ip : null;
  } catch { return null; }
};

// Country + flag for an IP via ip-api. Async: result via window.onIpInfo(info).
// Synchronous native fetch blocked the WebView thread for seconds at a time.
export const nativeIpInfoAsync = (ip: string): boolean => {
  try {
    const bridge = android();
    if (typeof bridge?.fetchUrlAsync !== 'function') return false;
    bridge.fetchUrlAsync(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,query`);
    return true;
  } catch { return false; }
};

export interface IpInfo { country: string; countryCode: string; flag: string; query: string; }
const flagOf = (cc: string): string => {
  if (!/^[A-Za-z]{2}$/.test(cc)) return '';
  return String.fromCodePoint(...cc.toUpperCase().split('').map(c => 0x1F1E6 + c.charCodeAt(0) - 65));
};

// Parse an ip-api response into IpInfo (null when it isn't a success payload).
export const parseIpInfo = (raw: string): IpInfo | null => {
  try {
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (j.status !== 'success') return null;
    return { country: j.country || '', countryCode: j.countryCode || '', flag: flagOf(j.countryCode || ''), query: j.query || '' };
  } catch { return null; }
};

// Synchronous variant — pre-connect / one-off use only.
export const nativeIpInfo = (ip: string): IpInfo | null => {
  try {
    const bridge = android();
    if (typeof bridge?.fetchUrl !== 'function') return null;
    const raw = String(bridge.fetchUrl(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,query`) || '');
    return parseIpInfo(raw);
  } catch { return null; }
};
// Real round-trip to a URL through the running core (ms), delivered via
// window.onDelayResult(ms). The native side runs it off-thread so the UI
// never blocks while the tunnel is starting. Returns false outside Android.
export const nativeMeasureDelayAsync = (url: string): boolean => {
  try {
    const bridge = android();
    if (typeof bridge?.measureDelayAsync !== 'function') return false;
    bridge.measureDelayAsync(url);
    return true;
  } catch { return false; }
};

// Legacy synchronous variant — only for one-off calls, never in a timer loop.
export const nativeMeasureDelay = async (url: string): Promise<number | null> => {
  try {
    const bridge = android();
    if (typeof bridge?.measureDelay !== 'function') return null;
    const v = await bridge.measureDelay(url);
    const n = Number(v);
    return isFinite(n) && n >= 0 ? n : null;
  } catch { return null; }
};

// Latency of a candidate config, via callback (native runs it off-thread).
export const nativeRequestLatency = (id: string, configJson: string, url: string): boolean => {
  try {
    const bridge = android();
    if (typeof bridge?.measureLatency !== 'function') return false;
    bridge.measureLatency(id, configJson, url);
    return true;
  } catch { return false; }
};

// Core traffic counters, delivered via window.onTraffic(raw) — same non-blocking
// reason as measureDelayAsync. Returns false outside Android.
export const nativeGetTrafficAsync = (): boolean => {
  try {
    const bridge = android();
    if (typeof bridge?.getTrafficAsync !== 'function') return false;
    bridge.getTrafficAsync();
    return true;
  } catch { return false; }
};

declare global {
  interface Window {
    onLatencyResult?: (id: string, ms: number) => void;
    onDelayResult?: (ms: number) => void;
    onTraffic?: (raw: string) => void;
    onResolveResult?: (ip: string) => void;
    onFetchResult?: (body: string) => void;
  }
}