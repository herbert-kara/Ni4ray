package com.v2ray.ai;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.VpnService;
import android.os.Bundle;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.util.Log;
import android.widget.Toast;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.appcompat.app.AppCompatActivity;
import androidx.activity.OnBackPressedCallback;
import libv2ray.Libv2ray;
import org.json.JSONArray;
import org.json.JSONObject;

public class MainActivity extends AppCompatActivity {
    private WebView webView;
    private String pendingConfig; // xray JSON waiting for VPN permission
    private String pendingName;
    // Set while the tunnel is up so app HTTP (IP lookup, etc.) routes through the
    // local proxy inbound (127.0.0.1:10809) and exits via the server, not the device.
    private static volatile boolean sTunnelUp = false;

    // Launcher for the VPN permission dialog
    private final ActivityResultLauncher<Intent> vpnPermissionLauncher =
            registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
                if (result.getResultCode() == Activity.RESULT_OK) {
                    startVpnService(pendingConfig, pendingName);
                } else {
                    Toast.makeText(this, "VPN Permission Denied", Toast.LENGTH_SHORT).show();
                    // Notify JS that connection failed
                    webView.post(() -> webView.evaluateJavascript("window.onVpnPermissionDenied && window.onVpnPermissionDenied()", null));
                }
            });

    public class WebAppInterface {
        Context mContext;

        WebAppInterface(Context c) {
            mContext = c;
        }

        @JavascriptInterface
        public void connect(String configJson) {
            connectWithName(configJson, "Ni4ray");
        }

        @JavascriptInterface
        public void connectWithName(String configJson, String name) {
            // Pre-resolve the outbound host on the plain system resolver while the
            // tunnel is still down. The core's dialer would otherwise resolve through
            // the VPN's own DNS (9.9.9.9) and loop back into the tunnel, which fails
            // with "no such host" and stalls the connection.
            Log.i("Ni4rayMain", "connectWithName: " + name + " cfg-len=" + configJson.length());
            String resolved = preResolveConfig(configJson);
            pendingConfig = resolved;
            pendingName = name;
            Intent intent = VpnService.prepare(mContext);
            if (intent != null) {
                vpnPermissionLauncher.launch(intent);
            } else {
                startVpnService(resolved, name);
            }
        }

        /** Pull the outbound host out of the Xray config JSON (vnext address / ws host). */
        private String extractOutboundHost(String json) {
            try {
                JSONObject root = new JSONObject(json);
                JSONArray outbounds = root.optJSONArray("outbounds");
                if (outbounds == null) return null;
                for (int i = 0; i < outbounds.length(); i++) {
                    JSONObject ob = outbounds.optJSONObject(i);
                    if (ob == null) continue;
                    String proto = ob.optString("protocol", "");
                    if (proto.equals("vmess") || proto.equals("vless")) {
                        JSONObject settings = ob.optJSONObject("settings");
                        if (settings != null) {
                            JSONArray vnext = settings.optJSONArray("vnext");
                            if (vnext != null && vnext.length() > 0) {
                                String addr = vnext.optJSONObject(0).optString("address", "");
                                if (!addr.isEmpty()) return addr;
                            }
                        }
                        JSONObject ss = ob.optJSONObject("streamSettings");
                        if (ss != null) {
                            JSONObject tls = ss.optJSONObject("tlsSettings");
                            if (tls != null) {
                                String sni = tls.optString("serverName", "");
                                if (!sni.isEmpty()) return sni;
                            }
                            JSONObject ws = ss.optJSONObject("wsSettings");
                            if (ws != null) {
                                JSONObject hdrs = ws.optJSONObject("headers");
                                if (hdrs != null) {
                                    String host = hdrs.optString("Host", "");
                                    if (!host.isEmpty()) return host;
                                }
                            }
                        }
                    } else if (proto.equals("trojan")) {
                        JSONObject settings = ob.optJSONObject("settings");
                        if (settings != null) {
                            JSONArray servers = settings.optJSONArray("servers");
                            if (servers != null && servers.length() > 0) {
                                String addr = servers.optJSONObject(0).optString("address", "");
                                if (!addr.isEmpty()) return addr;
                            }
                        }
                    }
                }
            } catch (Exception ignored) {}
            return null;
        }

        /** True when the host is already a numeric IPv4 literal. */
        private boolean isIpv4(String host) {
            int dots = 0;
            for (int i = 0; i < host.length(); i++) {
                char c = host.charAt(i);
                if (c == '.') dots++;
                else if (c < '0' || c > '9') return false;
            }
            return dots == 3;
        }

        /**
         * Rewrite the outbound host to its IP before the tunnel exists. The
         * device's system DNS can't answer for the server domain, and the
         * core's own resolver would loop back through the tunnel. SNI/TLS
         * fields are deliberately left as the hostname.
         */
        private String preResolveConfig(String configJson) {
            try {
                String host = extractOutboundHost(configJson);
                if (host == null || isIpv4(host)) return configJson;
                String ip = resolveHost(host);
                if (ip == null || ip.isEmpty()) return configJson;
                String out = rewriteJsonStringValue(configJson, "address", host, ip);
                out = rewriteJsonStringValue(out, "host", host, ip);
                out = rewriteJsonStringValue(out, "sni", host, ip);
                Log.i("Ni4rayMain", "pre-resolved " + host + " -> " + ip
                      + " changed=" + (!out.equals(configJson)));
                return out;
            } catch (Exception e) {
                Log.w("Ni4rayMain", "pre-resolve skipped: " + e.getMessage());
                return configJson;
            }
        }

        /**
         * Replace the value of every "key":"old" occurrence, tolerating any
         * whitespace around the colon. Plain String.replace missed the field
         * whenever the JSON was pretty-printed.
         */
        private String rewriteJsonStringValue(String json, String key, String oldVal, String newVal) {
            try {
                org.json.JSONObject root = new org.json.JSONObject(json);
                int replaced = rewriteInObject(root, key, oldVal, newVal);
                if (replaced == 0) return json;
                return root.toString(2);
            } catch (Exception e) {
                Log.w("Ni4rayMain", "rewrite failed for " + key + ": " + e.getMessage());
                return json;
            }
        }

        /** Depth-first walk replacing every "key":oldVal with newVal. */
        private int rewriteInObject(org.json.JSONObject obj, String key, String oldVal, String newVal) {
            int n = 0;
            java.util.Iterator<String> it = obj.keys();
            while (it.hasNext()) {
                String k = it.next();
                Object v = obj.opt(k);
                if (k.equals(key) && oldVal.equals(v)) {
                    try {
                        obj.put(k, newVal);
                        n++;
                        continue;
                    } catch (Exception ignored) {}
                }
                if (v instanceof org.json.JSONObject) {
                    n += rewriteInObject((org.json.JSONObject) v, key, oldVal, newVal);
                } else if (v instanceof org.json.JSONArray) {
                    n += rewriteInArray((org.json.JSONArray) v, key, oldVal, newVal);
                }
            }
            return n;
        }

        private int rewriteInArray(org.json.JSONArray arr, String key, String oldVal, String newVal) {
            int n = 0;
            for (int i = 0; i < arr.length(); i++) {
                Object v = arr.opt(i);
                if (v instanceof org.json.JSONObject) {
                    n += rewriteInObject((org.json.JSONObject) v, key, oldVal, newVal);
                } else if (v instanceof org.json.JSONArray) {
                    n += rewriteInArray((org.json.JSONArray) v, key, oldVal, newVal);
                }
            }
            return n;
        }

        /** Resolve via the plain system DNS. Null on failure. */
        private String resolveHost(String host) {
            try {
                java.net.InetAddress[] addrs = java.net.InetAddress.getAllByName(host);
                for (java.net.InetAddress a : addrs) {
                    if (a instanceof java.net.Inet4Address) return a.getHostAddress();
                }
                if (addrs.length > 0) return addrs[0].getHostAddress();
            } catch (Exception ignored) {}
            // The device's system resolver often can't answer for the server
            // domain (ISP filtering). Fall back to DNS-over-HTTPS, which is
            // independent of it and works before the tunnel exists.
            return resolveHostDoH(host);
        }

        /** DoH lookup (dns.google then cloudflare). Empty string on failure. */
        private String resolveHostDoH(String host) {
            String[] endpoints = {
                "https://dns.google/resolve?name=" + host + "&type=A",
                "https://cloudflare-dns.com/dns-query?name=" + host + "&type=A",
            };
            for (String url : endpoints) {
                try {
                    java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
                    c.setConnectTimeout(6000);
                    c.setReadTimeout(6000);
                    c.setRequestProperty("accept", "application/dns-json");
                    c.setRequestProperty("User-Agent", "Ni4ray/1.0");
                    java.io.InputStream in = c.getInputStream();
                    java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                    byte[] buf = new byte[4096];
                    int n;
                    while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
                    String json = out.toString("UTF-8");
                    // Minimal parse: first "data":"1.2.3.4" in the Answer list.
                    int ans = json.indexOf("\"Answer\"");
                    if (ans < 0) continue;
                    int d = json.indexOf("\"data\":\"", ans);
                    if (d < 0) continue;
                    int s = d + 8;
                    int e = json.indexOf('"', s);
                    if (e <= s) continue;
                    String ip = json.substring(s, e);
                    if (isIpv4(ip)) {
                        Log.i("Ni4rayMain", "doh-resolved " + host + " -> " + ip);
                        return ip;
                    }
                } catch (Exception ignored) {}
            }
            return "";
        }

        // Per-app proxy selection: mode = "all" | "allow" | "disallow", packagesCsv = "pkg1,pkg2".
        @JavascriptInterface
        public void setProxySelection(String mode, String packagesCsv) {
            V2RayProxyService.setProxySelection(mode, packagesCsv);
        }

        // Installed launchable apps as "label\tpkg;label\tpkg;...". Excludes system-only
        // packages and ourselves.
        @JavascriptInterface
        public String listInstalledApps() {
            try {
                android.content.pm.PackageManager pm = getPackageManager();
                java.util.List<android.content.pm.ApplicationInfo> apps =
                        pm.getInstalledApplications(android.content.pm.PackageManager.MATCH_DISABLED_COMPONENTS);
                StringBuilder sb = new StringBuilder();
                for (android.content.pm.ApplicationInfo ai : apps) {
                    String pkg = ai.packageName;
                    if (pkg.equals(getPackageName())) continue;
                    if (pm.getLaunchIntentForPackage(pkg) == null) continue; // no launcher icon
                    String label = pm.getApplicationLabel(ai).toString();
                    sb.append(label.replace('\t', ' ')).append('\t').append(pkg).append(';');
                }
                return sb.toString();
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void disconnect() {
            sTunnelUp = false;
            Intent intent = new Intent(mContext, V2RayProxyService.class);
            intent.setAction("STOP");
            mContext.startService(intent);
            Toast.makeText(mContext, "VPN Disconnected", Toast.LENGTH_SHORT).show();
        }

        @JavascriptInterface
        public void showToast(String toast) {
            Toast.makeText(mContext, toast, Toast.LENGTH_SHORT).show();
        }
        
        @JavascriptInterface
        public void copyToClipboard(String text) {
            android.content.ClipboardManager clipboard = (android.content.ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
            android.content.ClipData clip = android.content.ClipData.newPlainText("Copied Text", text);
            clipboard.setPrimaryClip(clip);
            Toast.makeText(mContext, "Copied to clipboard", Toast.LENGTH_SHORT).show();
        }

        // Cumulative core counters: "tag,direction,value;..." — empty string when idle.
        // Async: result arrives via window.onTraffic(raw).
        @JavascriptInterface
        public void getTrafficAsync() {
            new Thread(() -> {
                String raw = "";
                try { raw = V2RayProxyService.getTrafficStats(); } catch (Exception ignored) {}
                final String r = raw == null ? "" : raw;
                webView.post(() -> webView.evaluateJavascript(
                    "window.onTraffic && window.onTraffic(" + JSONObject.quote(r) + ")", null));
            }).start();
        }

        // Synchronous variant kept for one-off native calls (not the UI loop).
        @JavascriptInterface
        public String getTraffic() {
            return V2RayProxyService.getTrafficStats();
        }

        // Round-trip through the running core, ms. -1 on failure / when idle.
        // Async: result arrives via window.onDelayResult(ms).
        @JavascriptInterface
        public void measureDelayAsync(final String url) {
            new Thread(() -> {
                double ms = -1;
                try { ms = V2RayProxyService.measureDelaySync(url); } catch (Exception ignored) {}
                final double result = ms;
                webView.post(() -> webView.evaluateJavascript(
                    "window.onDelayResult && window.onDelayResult(" + result + ")", null));
            }).start();
        }

        // Synchronous variant kept for one-off native calls (not the UI loop).
        @JavascriptInterface
        public double measureDelay(String url) {
            return V2RayProxyService.measureDelaySync(url);
        }

        // Latency of a candidate config. TCP connect time to the server address,
        // measured directly — no Xray core involved.
        //
        // Libv2ray.measureOutboundDelay was tried first and rejected: it spins up
        // a throwaway core per call, and from the SECOND call onwards in the same
        // process the probe consistently times out (the first call's core still
        // holds the probe port). A TCP handshake is what a ping actually needs,
        // it works for every server and repeats reliably.
        @JavascriptInterface
        public void measureLatency(final String id, final String configJson, final String unusedUrl) {
            new Thread(() -> {
                long ms = -1;
                try {
                    String host = extractOutboundHost(configJson);
                    int port = extractOutboundPort(configJson);
                    if (host != null && port > 0) {
                        // v2rayNG-style tcping: direct TCP connect, no tunnel.
                        // The app is excluded from the TUN (addDisallowedApplication),
                        // so this measures the true device→server latency whether
                        // or not the VPN is running. System DNS first, DoH fallback.
                        String ip = resolveHost(host);
                        if (ip == null || ip.isEmpty()) ip = host;
                        Log.i("Ni4rayPing", "probe direct " + ip + ":" + port);
                        long t0 = System.nanoTime();
                        try (java.net.Socket s = new java.net.Socket()) {
                            s.connect(new java.net.InetSocketAddress(ip, port), 2000);
                        }
                        ms = (System.nanoTime() - t0) / 1_000_000L;
                    }
                } catch (Exception ignored) {
                    ms = -1;
                }
                Log.i("Ni4rayPing", "result ms=" + ms + " id=" + id);
                final long result = ms;
                webView.post(() -> webView.evaluateJavascript(
                    "window.onLatencyResult && window.onLatencyResult(" + JSONObject.quote(id) + "," + result + ")", null));
            }).start();
        }

        // Port of the first outbound: settings.vnext[0].port, streamSettings port
        // override, or the well-known default for the protocol.
        private int extractOutboundPort(String configJson) {
            try {
                org.json.JSONObject root = new org.json.JSONObject(configJson);
                org.json.JSONArray outs = root.optJSONArray("outbounds");
                if (outs == null) return 0;
                for (int i = 0; i < outs.length(); i++) {
                    org.json.JSONObject ob = outs.optJSONObject(i);
                    if (ob == null) continue;
                    org.json.JSONObject settings = ob.optJSONObject("settings");
                    if (settings == null) continue;
                    org.json.JSONArray vnext = settings.optJSONArray("vnext");
                    if (vnext != null && vnext.length() > 0) {
                        org.json.JSONObject v = vnext.optJSONObject(0);
                        if (v != null && v.has("port")) return v.optInt("port", 0);
                    }
                    org.json.JSONArray servers = settings.optJSONArray("servers");
                    if (servers != null && servers.length() > 0) {
                        org.json.JSONObject sv = servers.optJSONObject(0);
                        if (sv != null && sv.has("port")) return sv.optInt("port", 0);
                    }
                    // Shadowsocks keeps the endpoint at the outbound level.
                    if (ob.has("port")) return ob.optInt("port", 0);
                }
            } catch (Exception e) {
                Log.w("Ni4rayMain", "extractOutboundPort failed: " + e.getMessage());
            }
            return 0;
        }

        // Resolve hostname -> IP. Async: result via window.onResolveResult(ip).
        // A blocking bridge call on the WebView thread stalls the whole UI.
        @JavascriptInterface
        public void resolveHostAsync(final String host) {
            new Thread(() -> {
                String ip = "";
                try {
                    java.net.InetAddress[] addrs = java.net.InetAddress.getAllByName(host);
                    for (java.net.InetAddress a : addrs) {
                        if (a instanceof java.net.Inet4Address) { ip = a.getHostAddress(); break; }
                    }
                    if (ip.isEmpty() && addrs.length > 0) ip = addrs[0].getHostAddress();
                } catch (Exception ignored) {}
                final String result = ip;
                webView.post(() -> webView.evaluateJavascript(
                    "window.onResolveResult && window.onResolveResult(" + JSONObject.quote(result) + ")", null));
            }).start();
        }

        // Synchronous variant for pre-connect use, where the tunnel is still down
        // and the system resolver answers immediately.
        @JavascriptInterface
        public String getHostIp(String host) {
            try {
                java.net.InetAddress[] addrs = java.net.InetAddress.getAllByName(host);
                for (java.net.InetAddress a : addrs) {
                    if (a instanceof java.net.Inet4Address) return a.getHostAddress();
                }
                return addrs.length > 0 ? addrs[0].getHostAddress() : "";
            } catch (Exception e) {
                return "";
            }
        }

        // Plain HTTP GET with no CORS restrictions. Async: result via window.onFetchResult.
        @JavascriptInterface
        public void fetchUrlAsync(final String url) {
            new Thread(() -> {
                String body = fetchUrlSync(url);
                webView.post(() -> webView.evaluateJavascript(
                    "window.onFetchResult && window.onFetchResult(" + JSONObject.quote(body) + ")", null));
            }).start();
        }

        private String fetchUrlSync(String url) {
            java.net.HttpURLConnection conn = null;
            try {
                java.net.URL u = new java.net.URL(url);
                // While the tunnel is up the app is excluded from it, so route this
                // request through the local HTTP proxy inbound (127.0.0.1:10809) to
                // exit via the server. When down, go direct.
                java.net.Proxy proxy = sTunnelUp
                        ? new java.net.Proxy(java.net.Proxy.Type.HTTP, new java.net.InetSocketAddress("127.0.0.1", 10809))
                        : java.net.Proxy.NO_PROXY;
                conn = (java.net.HttpURLConnection) u.openConnection(proxy);
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                conn.setInstanceFollowRedirects(true);
                conn.setRequestProperty("User-Agent", "Ni4ray/1.0");
                java.io.InputStream in = conn.getInputStream();
                java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
                byte[] buf = new byte[8192];
                int n, total = 0;
                while ((n = in.read(buf)) != -1) {
                    total += n;
                    if (total > 512 * 1024) break; // 512KB cap
                    out.write(buf, 0, n);
                }
                return out.toString("UTF-8");
            } catch (Exception e) {
                return "";
            } finally {
                if (conn != null) conn.disconnect();
            }
        }

        // Synchronous variant kept for pre-connect use.
        @JavascriptInterface
        public String fetchUrl(String url) {
            return fetchUrlSync(url);
        }
    }

    private void startVpnService(String configJson, String name) {
        Intent intent = new Intent(this, V2RayProxyService.class);
        intent.putExtra("CONFIG", configJson);
        intent.putExtra("NAME", name != null ? name : "Ni4ray");
        startService(intent);
        sTunnelUp = true;
        Toast.makeText(this, "VPN Service Started", Toast.LENGTH_SHORT).show();
        // Notify JS that connection started
        webView.post(() -> webView.evaluateJavascript("window.onVpnConnected && window.onVpnConnected()", null));
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        
        webView = new WebView(this);
        setContentView(webView);

        WebSettings webSettings = webView.getSettings();
        webSettings.setJavaScriptEnabled(true);
        webSettings.setDomStorageEnabled(true);
        webSettings.setAllowFileAccess(true);
        webSettings.setAllowContentAccess(true);
        webSettings.setAllowUniversalAccessFromFileURLs(true);

        webView.addJavascriptInterface(new WebAppInterface(this), "Android");
        webView.setWebViewClient(new WebViewClient());

        webView.loadUrl("file:///android_asset/index.html");

        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });
    }
}