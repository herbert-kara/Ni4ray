import { ServerConfig, AppSettings } from '../types';

/**
 * Generates a valid Xray configuration.
 * TUN mode: packets from the VPN interface are consumed by the core itself,
 * so no local inbounds are needed. Stats are enabled for real traffic counters.
 */
export const generateV2RayConfig = (server: ServerConfig, settings?: AppSettings): string => {
  const outbound: any = {
    tag: "proxy",
    protocol: server.protocol,
    settings: {},
    streamSettings: {
      network: "tcp",
      security: "none",
    },
    mux: {
        enabled: settings?.enableMux ?? false,
        concurrency: settings?.muxConcurrency ?? 8
    }
  };

  // Fragment (socks-style): splits TLS ClientHello to bypass SNI filtering.
  // Range strings like "10-20" come from settings; invalid values are ignored.

  if (server.protocol === 'vmess') {
    outbound.settings = {
      vnext: [{
        address: server.address,
        port: server.port,
        users: [{
          id: server.uuid,
          alterId: 0,
          security: "auto",
          level: 8
        }]
      }]
    };
  } else if (server.protocol === 'vless') {
    outbound.settings = {
      vnext: [{
        address: server.address,
        port: server.port,
        users: [{
          id: server.uuid,
          encryption: "none",
          level: 0
        }]
      }]
    };
    if (server.security === 'tls') {
        outbound.streamSettings.security = 'tls';
        outbound.streamSettings.tlsSettings = {
            serverName: server.address
        };
    }
  } else if (server.protocol === 'trojan') {
      outbound.settings = {
          servers: [{
              address: server.address,
              port: server.port,
              password: server.uuid,
              level: 0
          }]
      };
      outbound.streamSettings.security = 'tls';
      outbound.streamSettings.tlsSettings = {
          serverName: server.address
      };
  }

  const link = server.rawLink || '';
  const getParam = (k: string) => {
      const m = link.match(new RegExp('[?&]' + k + '=([^&#]*)'));
      return m ? decodeURIComponent(m[1]) : '';
  };
  const netType = getParam('type') || getParam('net');
  const linkPath = getParam('path');
  const linkHost = getParam('host') || getParam('sni');
  const linkFp = getParam('fp');

  if (netType === 'ws') {
      outbound.streamSettings.network = 'ws';
      outbound.streamSettings.wsSettings = {
          path: linkPath || '/'
      };
      if (linkHost) outbound.streamSettings.wsSettings.headers = { Host: linkHost };
  } else if (netType === 'httpupgrade') {
      outbound.streamSettings.network = 'httpupgrade';
      outbound.streamSettings.httpupgradeSettings = {
          path: linkPath || '/',
          host: linkHost || server.address
      };
  } else if (netType === 'grpc') {
      outbound.streamSettings.network = 'grpc';
      outbound.streamSettings.grpcSettings = {
          serviceName: getParam('serviceName') || ''
      };
  }

  // TLS serverName / fingerprint from link params (sni, fp) win over defaults
  if (outbound.streamSettings.security === 'tls') {
      const tls = outbound.streamSettings.tlsSettings || {};
      if (linkHost) tls.serverName = linkHost;
      if (linkFp) tls.fingerprint = linkFp;
      // allowInsecure was removed from Xray: skipping cert verify is now verifyPeerCertByName=false
      if (settings?.allowInsecure) tls.verifyPeerCertByName = false;
      outbound.streamSettings.tlsSettings = tls;
  }

  // Fragment: split TLS hello to bypass SNI filtering (Xray socks-style).
  if (settings?.enableFragment && outbound.streamSettings.security === 'tls') {
      const range = (v: string, dflt: number[]): number[] => {
          const m = (v || '').split('-').map(Number);
          return m.length === 2 && m.every(n => isFinite(n) && n > 0) ? m : dflt;
      };
      outbound.streamSettings.sockopt = {
          ...(outbound.streamSettings.sockopt || {}),
          dialerProxy: '',
          tcpKeepAliveIdle: 100,
          fragment: {
              packets: 'tlshello',
              length: range(settings.fragmentSize, [10, 20]).join('-'),
              interval: range(settings.fragmentSleep, [5, 10]).join('-')
          }
      };
  }

  // NOTE: no geosite:/geoip: rules — the geo .dat files shipped in the AAR fail
  // to load on-device (EOF on code lookup), so routing uses plain domain
  // regex + private ranges with zero .dat dependency.
  const routingMode = settings?.routingMode ?? 'global';
  // No ads-block rule: the only ads list available was geosite:category-ads-all,
  // which needs the broken .dat files. Rules below, first match wins.
  const routingRules: any[] = [];
  if (routingMode === 'bypass_iran') {
    routingRules.push(
      { type: "field", domain: ["regexp:.*\\.ir$"], outboundTag: "direct" },
      { type: "field", ip: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"], outboundTag: "direct" }
    );
  } else if (routingMode === 'bypass_lan') {
    routingRules.push(
      { type: "field", ip: ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"], outboundTag: "direct" }
    );
  } else if (routingMode === 'only_iran') {
    routingRules.push(
      { type: "field", domain: ["regexp:.*\\.ir$"], outboundTag: "proxy" },
      { type: "field", network: "tcp,udp", outboundTag: "direct" }
    );
  }
  if (routingMode !== 'only_iran') {
    routingRules.push({ type: "field", network: "tcp,udp", outboundTag: "proxy" });
  }

  const config = {
    log: {
      loglevel: "warning"
    },
    stats: {},
    api: {
      tag: "api",
      services: ["StatsService"]
    },
    policy: {
      levels: { "0": { statsUserUplink: true, statsUserDownlink: true } },
      system: {
        statsOutboundUplink: true,
        statsOutboundDownlink: true
      }
    },
    dns: {
      tag: "dns",
      queryStrategy: "UseIP",
      servers: [
        {
          address: "https://9.9.9.9/dns-query",
          skipFallback: true
        },
        settings?.directDns || "1.1.1.1"
      ]
    },
    inbounds: [
      {
        tag: "tun-in",
        protocol: "tun",
        settings: {
          name: "xray0",
          mtu: 1500
        },
        sniffing: {
          enabled: true,
          destOverride: ["http", "tls", "quic"]
        }
      },
      {
        tag: "api",
        listen: "127.0.0.1",
        port: 10823,
        protocol: "dokodemo-door",
        settings: { address: "127.0.0.1" }
      }
    ],
    outbounds: [
      outbound,
      {
        tag: "direct",
        protocol: "freedom",
        settings: {}
      },
      {
        tag: "block",
        protocol: "blackhole",
        settings: {}
      }
    ],
    routing: {
      domainStrategy: settings?.domainStrategy || "IPIfNonMatch",
      rules: [
        {
          type: "field",
          inboundTag: ["api"],
          outboundTag: "api"
        },
        ...routingRules
      ]
    }
  };

  return JSON.stringify(config, null, 2);
};