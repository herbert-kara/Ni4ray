import { ServerConfig } from '../types';

const fixBase64 = (str: string) => {
  let output = str.replace(/\s/g, '');
  output = output.replace(/-/g, '+').replace(/_/g, '/');
  while (output.length % 4 !== 0) {
    output += '=';
  }
  return output;
};

export const safeAtob = (str: string) => {
  try {
    if (!/^[A-Za-z0-9+/=_ -]+$/.test(str)) return str;
    return decodeURIComponent(escape(window.atob(fixBase64(str))));
  } catch (e) {
    return str; 
  }
};

const parseVmess = (link: string): Partial<ServerConfig> | null => {
  try {
    const b64 = link.replace('vmess://', '');
    const jsonStr = safeAtob(b64);
    const json = JSON.parse(jsonStr);
    return {
      protocol: 'vmess',
      name: json.ps || json.add || 'VMess Node',
      address: json.add,
      port: Number(json.port) || 443,
      uuid: json.id,
      location: 'Unknown',
      security: json.tls || 'auto',
      rawLink: link
    };
  } catch (e) {
    return null;
  }
};

const parseUrlLike = (link: string, protocol: 'vless' | 'trojan'): Partial<ServerConfig> | null => {
  try {
    const cleanLink = link.substring(link.indexOf(protocol + '://'));
    const url = new URL(cleanLink);
    const params = new URLSearchParams(url.search);
    
    let name = 'Server';
    if (url.hash) {
        try {
            name = decodeURIComponent(url.hash.slice(1));
        } catch (e) {
            name = url.hash.slice(1);
        }
    }

    return {
      protocol: protocol,
      name: name,
      address: url.hostname,
      port: Number(url.port) || 443,
      uuid: url.username,
      location: 'Unknown',
      security: params.get('security') || 'none',
      rawLink: link
    };
  } catch (e) {
    return null;
  }
};

export const parseSubscription = (body: string, subId?: string): ServerConfig[] => {
  if (!body) return [];
  let content = body;
  
  for (let i = 0; i < 2; i++) {
      if (!content.includes('vmess://') && !content.includes('vless://') && !content.includes('trojan://')) {
          const decoded = safeAtob(content);
          if (decoded !== content && /^[\x20-\x7E\s]+$/.test(decoded)) {
              content = decoded;
          } else {
              break;
          }
      } else {
          break;
      }
  }

  const lines = content.split(/[\r\n\s]+/).filter(line => line && line.trim().length > 0);
  const configs: ServerConfig[] = [];

  lines.forEach(line => {
    let parsed: Partial<ServerConfig> | null = null;
    const trimLine = line.trim();

    if (trimLine.startsWith('vmess://')) {
      parsed = parseVmess(trimLine);
    } else if (trimLine.startsWith('vless://')) {
      parsed = parseUrlLike(trimLine, 'vless');
    } else if (trimLine.startsWith('trojan://')) {
      parsed = parseUrlLike(trimLine, 'trojan');
    }

    if (parsed) {
      configs.push({
        ...parsed,
        id: crypto.randomUUID(),
        subscriptionId: subId,
      } as ServerConfig);
    }
  });

  return configs;
};