import React, { useState } from 'react';
import { Gauge, Globe, MapPin, Server, Timer, Play } from 'lucide-react';
import { nativeMeasureDelayAsync, nativeResolveIpAsync, IpInfo } from '../services/nativeBridge';

interface TestResult {
  ip: string | null;
  info: IpInfo | null;
  pingMs: number | null;
  downKBs: number | null;
  dnsMs: number | null;
  dnsServer: string | null;
}

const PROBE_URL = 'https://clients3.google.com/generate_204';
const DL_URL = 'https://speed.cloudflare.com/__down?bytes=1000000';

const NetworkTester: React.FC = () => {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const run = async () => {
    if (running) return;
    setRunning(true);
    setResult(null);
    const out: TestResult = { ip: null, info: null, pingMs: null, downKBs: null, dnsMs: null, dnsServer: null };
    try {
      // 1. Ping — via the core (async, like Dashboard); the synchronous
      // bridge variant ran on the WebView thread and froze the UI.
      try {
        out.pingMs = await new Promise<number | null>((resolve) => {
          const prev = window.onDelayResult;
          const timer = setTimeout(() => {
            if (window.onDelayResult === onPing) {
              if (prev) window.onDelayResult = prev; else delete window.onDelayResult;
            }
            resolve(null);
          }, 10000);
          const onPing = (ms: number) => {
            clearTimeout(timer);
            if (window.onDelayResult === onPing) {
              if (prev) window.onDelayResult = prev; else delete window.onDelayResult;
            }
            resolve(typeof ms === 'number' && isFinite(ms) && ms >= 0 ? ms : null);
          };
          window.onDelayResult = onPing;
          if (!nativeMeasureDelayAsync(`${PROBE_URL}?t=${Date.now()}`)) { clearTimeout(timer); resolve(null); }
        });
      } catch { /* ping optional */ }
        // 2. Public IP + location of the current egress.
        // The native variant is off-thread (window.onFetchResult); the blocking
        // one froze the UI for its whole timeout while the tunnel was up.
        try {
          const bridge = (window as any).Android;
          if (bridge && typeof bridge.fetchUrlAsync === 'function') {
            const raw = await new Promise<string>((resolve) => {
              const prev = window.onFetchResult;
              const timer = setTimeout(() => {
                if (window.onFetchResult === onIp) {
                  if (prev) window.onFetchResult = prev; else delete window.onFetchResult;
                }
                resolve('');
              }, 10000);
              const onIp = (body: string) => {
                clearTimeout(timer);
                if (window.onFetchResult === onIp) {
                  if (prev) window.onFetchResult = prev; else delete window.onFetchResult;
                }
                resolve(body || '');
              };
              window.onFetchResult = onIp;
              bridge.fetchUrlAsync('http://ip-api.com/json/?fields=status,country,countryCode,query,isp');
            });
            if (raw) {
              const j = JSON.parse(raw);
              if (j && j.status === 'success') {
                out.ip = j.query || null;
                const cc: string = j.countryCode || '';
                out.info = {
                  country: (j.country || '') + (j.isp ? ` • ${j.isp}` : ''),
                  countryCode: cc, query: j.query || '',
                  flag: /^[A-Za-z]{2}$/.test(cc)
                    ? String.fromCodePoint(...cc.toUpperCase().split('').map((c: string) => 0x1F1E6 + c.charCodeAt(0) - 65))
                    : '',
                };
              }
            }
          }
        } catch { /* ip lookup optional */ }
        // 3. Download speed: 1MB probe. A Chromium fetch is already off the UI
        // thread, so no native bridge call is needed here.
        try {
          const t0 = Date.now();
          const res = await fetch(`${DL_URL}&t=${Date.now()}`, { cache: 'no-store' });
          const buf = await res.arrayBuffer();
          const secs = Math.max(0.1, (Date.now() - t0) / 1000);
          out.downKBs = Math.round(buf.byteLength / 1024 / secs);
        } catch { /* speed optional */ }
        // 4. DNS latency: native resolve timing, off-thread (window.onResolveResult)
        try {
          const t0 = Date.now();
          const ip2 = await new Promise<string>((resolve) => {
            const prev = window.onResolveResult;
            const timer = setTimeout(() => {
              if (window.onResolveResult === onDns) {
                if (prev) window.onResolveResult = prev; else delete window.onResolveResult;
              }
              resolve('');
            }, 8000);
            const onDns = (ip: string) => {
              clearTimeout(timer);
              if (window.onResolveResult === onDns) {
                if (prev) window.onResolveResult = prev; else delete window.onResolveResult;
              }
              resolve(ip || '');
            };
            window.onResolveResult = onDns;
            nativeResolveIpAsync('one.one.one.one');
          });
          if (ip2) {
            out.dnsMs = Date.now() - t0;
            out.dnsServer = ip2;
          }
        } catch { /* dns optional */ }
    } finally {
      setResult(out);
      setRunning(false);
    }
  };

  const Row: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
    <div className="flex items-center justify-between py-2 border-b border-gray-700/50 last:border-0">
      <div className="flex items-center gap-2 text-gray-400 text-xs">
        {icon}
        <span className="uppercase tracking-wider font-semibold">{label}</span>
      </div>
      <div className="text-sm font-mono text-white">{value}</div>
    </div>
  );

  return (
    <div className="bg-gray-800/50 rounded-xl p-4 w-full border border-gray-700 backdrop-blur-sm">
      <div className="flex items-center justify-between mb-2">
        <div className="text-[10px] text-gray-500 uppercase tracking-widest font-semibold">Network Test</div>
        <button
          onClick={run}
          disabled={running}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary-600 text-white text-xs font-bold hover:bg-primary-500 disabled:opacity-50 transition-all active:scale-95"
        >
          <Play size={12} />
          {running ? 'Testing…' : 'Run test'}
        </button>
      </div>
      {!result && !running && (
        <div className="text-xs text-gray-500 py-2">Check speed, IP, location and DNS of the current connection.</div>
      )}
      {result && (
        <div>
          <Row icon={<Gauge size={13} />} label="Download" value={result.downKBs !== null ? `${(result.downKBs / 1024).toFixed(1)} MB/s` : '—'} />
          <Row icon={<Timer size={13} />} label="Ping" value={result.pingMs !== null ? `${Math.round(result.pingMs)} ms` : '—'} />
          <Row icon={<Globe size={13} />} label="Public IP" value={result.ip || '—'} />
          <Row icon={<MapPin size={13} />} label="Location" value={result.info ? `${result.info.flag} ${result.info.country}` : '—'} />
          <Row icon={<Server size={13} />} label="DNS resolve" value={result.dnsMs !== null ? `${result.dnsMs} ms` : '—'} />
        </div>
      )}
    </div>
  );
};

export default NetworkTester;
