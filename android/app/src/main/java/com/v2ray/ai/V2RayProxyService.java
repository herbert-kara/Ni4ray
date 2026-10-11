package com.v2ray.ai;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.VpnService;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import androidx.core.app.NotificationCompat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

import libv2ray.CoreCallbackHandler;
import libv2ray.ProcessFinder;
import libv2ray.CoreController;
import libv2ray.Libv2ray;

public class V2RayProxyService extends VpnService {
    private static final String TAG = "Ni4rayService";
    private static final String CHANNEL_ID = "Ni4ray_Channel";
    private ParcelFileDescriptor mInterface;
    private static volatile CoreController controller;
    private static volatile String activeServerName = "";
    private static volatile long connectStartMs = 0;

    // Per-app proxy config passed by the JS bridge: "all" | "allow" | "disallow"
    private static volatile String proxyMode = "all";
    private static volatile java.util.List<String> proxyApps = new java.util.ArrayList<>();

    // Called from the JS bridge right before connect().
    public static void setProxySelection(String mode, String packagesCsv) {
        java.util.List<String> list = new java.util.ArrayList<>();
        if (packagesCsv != null && !packagesCsv.isEmpty()) {
            for (String p : packagesCsv.split(",")) {
                String t = p.trim();
                if (!t.isEmpty()) list.add(t);
            }
        }
        proxyMode = mode == null || mode.isEmpty() ? "all" : mode;
        proxyApps = list;
        Log.i(TAG, "proxy selection: " + proxyMode + " " + list);
    }

    /**
     * Protect the current process' sockets from re-entering the tunnel.
     * addDisallowedApplication(getPackageName()) already keeps this process
     * off the tunnel; this is a belt-and-braces pass for sockets that were
     * already open when the tunnel came up.
     */
    private void protectSocketsForThisProcess() {
        if (mInterface == null) return;
        int pid = android.os.Process.myPid();
        try {
            java.io.File[] fds = new java.io.File("/proc/" + pid + "/fd").listFiles();
            if (fds == null) return;
            for (java.io.File f : fds) {
                try {
                    String link = java.nio.file.Files.readSymbolicLink(f.toPath()).toString();
                    if (!link.startsWith("socket:[")) continue;
                    // protect() lives on VpnService (this service), not on the
                    // ParcelFileDescriptor — shield the socket's fd.
                    protect(Integer.parseInt(link.substring(8, link.length() - 1)));
                } catch (Exception ignored) {}
            }
        } catch (Exception ignored) {}
    }

    // Called from MainActivity's JS bridge (same process). Empty string when idle.
    public static String getTrafficStats() {
        try {
            CoreController c = controller;
            if (c == null) return "";
            String s = c.queryAllOutboundTrafficStats();
            return s != null ? s : "";
        } catch (Exception e) {
            return "";
        }
    }

    // Round-trip through the running core, ms. -1 on failure / when idle.
    public static double measureDelaySync(String url) {
        try {
            CoreController c = controller;
            if (c == null) return -1;
            return c.measureDelay(url);
        } catch (Exception e) {
            return -1;
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && "STOP".equals(intent.getAction())) {
            stopVpn();
            return START_NOT_STICKY;
        }

        String configJson = intent != null ? intent.getStringExtra("CONFIG") : null;
        String serverName = intent != null ? intent.getStringExtra("NAME") : null;
        if (configJson != null) {
            Log.i(TAG, "CONFIG head: [" + configJson.substring(0, Math.min(40, configJson.length()))
                    .replace("\n", "\\n") + "] len=" + configJson.length());
            // Stop only the core here — keep the foreground notification alive across reconnects.
            stopCore();
            startVpn(configJson, serverName != null ? serverName : "Ni4ray");
        } else if (controller == null) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private android.os.Handler notifHandler;
    private Runnable notifUpdater;

    private android.app.Notification buildNotification(String serverName, String detail) {
        createNotificationChannel();
        Intent stopIntent = new Intent(this, V2RayProxyService.class);
        stopIntent.setAction("STOP");
        PendingIntent stopPendingIntent = PendingIntent.getService(this, 0, stopIntent, PendingIntent.FLAG_IMMUTABLE);

        Intent openIntent = new Intent(this, MainActivity.class);
        PendingIntent openPendingIntent = PendingIntent.getActivity(this, 0, openIntent, PendingIntent.FLAG_IMMUTABLE);

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle("Ni4ray • " + serverName)
                .setContentText(detail)
                .setSmallIcon(R.drawable.ic_launcher)
                .setContentIntent(openPendingIntent)
                .addAction(R.drawable.ic_launcher, "Disconnect", stopPendingIntent)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
    }

    private void startNotifLoop(final String serverName) {
        stopNotifLoop();
        notifHandler = new android.os.Handler(android.os.Looper.getMainLooper());
        notifUpdater = new Runnable() {
            @Override public void run() {
                try {
                    String stats = getTrafficStats();
                    long up = 0, down = 0;
                    if (stats != null && !stats.isEmpty()) {
                        for (String part : stats.split(";")) {
                            String[] f = part.split(",");
                            if (f.length != 3) continue;
                            try {
                                long v = Long.parseLong(f[2]);
                                if (f[1].contains("up")) up += v;
                                else if (f[1].contains("down")) down += v;
                            } catch (NumberFormatException ignored) {}
                        }
                    }
                    long secs = Math.max(0, (System.currentTimeMillis() - connectStartMs) / 1000);
                    String detail = String.format("↑ %s  ↓ %s  •  %02d:%02d:%02d",
                            fmtBytes(up), fmtBytes(down), secs / 3600, (secs % 3600) / 60, secs % 60);
                    Notification n = buildNotification(serverName, detail);
                    NotificationManager nm = getSystemService(NotificationManager.class);
                    if (nm != null) nm.notify(1, n);
                } catch (Exception ignored) {}
                if (notifHandler != null) notifHandler.postDelayed(notifUpdater, 2000);
            }
        };
        notifHandler.post(notifUpdater);
    }

    private void stopNotifLoop() {
        if (notifHandler != null && notifUpdater != null) notifHandler.removeCallbacks(notifUpdater);
        notifHandler = null;
        notifUpdater = null;
    }

    private static String fmtBytes(long b) {
        if (b > 1048576) return String.format("%.1f MB", b / 1048576.0);
        if (b > 1024) return String.format("%.0f KB", b / 1024.0);
        return b + " B";
    }

    private void startVpn(String configJson, String serverName) {
        try {
            copyAssets();
            Libv2ray.initCoreEnv(getFilesDir().getAbsolutePath(), "");

            VpnService.Builder builder = new VpnService.Builder()
                    .setSession("Ni4ray")
                    .setMtu(1500)
                    .addAddress("10.0.0.2", 32)
                    .addRoute("0.0.0.0", 0)
                    .addDnsServer("9.9.9.9")
                    .addDnsServer("8.8.8.8");

            // Per-app proxy selection (from Settings). When mode==allow the list is the
            // allow-list; when mode==disallow it is the exclude-list. Empty list + allow
            // mode is rejected because it would tunnel nothing.
            boolean proxyAll = proxyMode == null || proxyMode.equals("all") || proxyMode.isEmpty();
            if (!proxyAll) {
                java.util.List<String> pkgs = proxyApps != null ? proxyApps : java.util.Collections.emptyList();
                for (String pkg : pkgs) {
                    if (pkg == null || pkg.isEmpty()) continue;
                    try {
                        if ("allow".equals(proxyMode)) {
                            builder.addAllowedApplication(pkg);
                        } else if ("disallow".equals(proxyMode)) {
                            builder.addDisallowedApplication(pkg);
                        }
                    } catch (Exception e) { // unknown / uninstalled pkg
                        Log.w(TAG, "per-app proxy: unknown pkg " + pkg);
                    }
                }
            }

            // Always shield ourselves: the core dials from this very process, so
            // without this its own outbound sockets get captured by the tunnel
            // and loop back ("cannot assign requested address"). Must be
            // unconditional — it applies in every per-app mode, including "all".
            try { builder.addDisallowedApplication(getPackageName()); }
            catch (Exception ignored) {}

            mInterface = builder.establish();
            if (mInterface == null) throw new Exception("VPN interface not established (permission revoked?)");

            controller = Libv2ray.newCoreController(new CoreCallbackHandler() {
                @Override public long startup() { return 0L; }
                @Override public long shutdown() { return 0L; }
                @Override public long onEmitStatus(long p0, String p1) {
                    Log.i(TAG, "core: " + p1);
                    return 0L;
                }
            });
            // Core dials outbound sockets itself; every such socket must bypass
            // the tunnel or the proxy loops on its own traffic.
            controller.registerProcessFinder(new ProcessFinder() {
                @Override public long findProcessByConnection(
                        String srcIp, String dstIp, long srcPort, String proto, long dstPort) {
                    try { protectSocketsForThisProcess(); } catch (Exception ignored) {}
                    return 0L; // our own uid -> never matched as a proxied app
                }
            });
            controller.startLoop(configJson, mInterface.getFd());
            Log.i(TAG, "Xray core started, TUN fd=" + mInterface.getFd() + " json-len=" + configJson.length());
            activeServerName = serverName;
            connectStartMs = System.currentTimeMillis();
            // Foreground notification (must be quick for VpnService on Android 8+).
            Notification first = buildNotification(serverName, "Connecting…");
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(1, first, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(1, first);
            }
            startNotifLoop(serverName);
        } catch (Exception e) {
            Log.e(TAG, "Fatal start error", e);
            stopVpn();
        }
    }

    private void copyAssets() {
        String[] files = {"geoip.dat", "geosite.dat"};
        for (String fileName : files) {
            try {
                File outFile = new File(getFilesDir(), fileName);
                if (!outFile.exists()) {
                    try (InputStream in = getAssets().open(fileName);
                         OutputStream out = new FileOutputStream(outFile)) {
                        byte[] buffer = new byte[1024];
                        int read;
                        while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
                    }
                }
            } catch (Exception e) {
                Log.w(TAG, "asset copy failed: " + fileName, e);
            }
        }
    }

    // Stop the core + interface, but leave the foreground state to the caller.
    private void stopCore() {
        try {
            if (controller != null) controller.stopLoop();
        } catch (Exception e) {
            Log.e(TAG, "stopLoop failed", e);
        }
        controller = null;
        if (mInterface != null) {
            try { mInterface.close(); } catch (Exception e) { }
            mInterface = null;
        }
        stopNotifLoop();
    }

    private void stopVpn() {
        stopCore();
        stopForeground(true);
        stopSelf();
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel serviceChannel = new NotificationChannel(
                    CHANNEL_ID,
                    "Ni4ray Service",
                    NotificationManager.IMPORTANCE_DEFAULT
            );
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(serviceChannel);
        }
    }
}
