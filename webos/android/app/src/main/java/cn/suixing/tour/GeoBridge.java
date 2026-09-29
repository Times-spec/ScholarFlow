package cn.suixing.tour;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;

import org.json.JSONObject;

/**
 * 原生定位桥：把 Android 定位能力暴露给网页。
 *
 * 为什么需要：WebView 里的 navigator.geolocation 只允许安全上下文（HTTPS/localhost），
 * 而自建服务多为局域网 HTTP。这里用原生定位补上，返回 WGS84 坐标，
 * 由服务端适配器统一转换成 GCJ02（与网页端 web/ 里一致的处理链路）。
 */
public class GeoBridge {
    private final Activity activity;
    private static final long MAX_AGE_MS = 60_000L;

    public GeoBridge(Activity activity) {
        this.activity = activity;
    }

    @JavascriptInterface
    public boolean hasPermission() {
        return activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    @JavascriptInterface
    public void requestPermission() {
        activity.runOnUiThread(() -> activity.requestPermissions(
                new String[]{Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION}, 1001));
    }

    /** 同步返回定位结果（阻塞最多约 6 秒）：{lng, lat, accuracy, ts} 或 {error} */
    @JavascriptInterface
    public String getLocation() {
        if (!hasPermission()) return "{\"error\":\"permission_denied\"}";
        try {
            LocationManager lm = (LocationManager) activity.getSystemService(Context.LOCATION_SERVICE);
            if (lm == null) return "{\"error\":\"no_location_service\"}";
            Location best = null;
            for (String provider : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER}) {
                try {
                    if (!lm.isProviderEnabled(provider)) continue;
                    Location l = lm.getLastKnownLocation(provider);
                    if (l == null) continue;
                    if (best == null || l.getTime() > best.getTime()) best = l;
                } catch (SecurityException ignored) { }
            }
            if (best == null || System.currentTimeMillis() - best.getTime() > MAX_AGE_MS) {
                Location fresh = requestSingleUpdate(lm);
                if (fresh != null) best = fresh;
            }
            if (best == null) return "{\"error\":\"location_unavailable\"}";
            JSONObject o = new JSONObject();
            o.put("lng", best.getLongitude());   // WGS84
            o.put("lat", best.getLatitude());
            o.put("accuracy", best.hasAccuracy() ? best.getAccuracy() : 9999);
            o.put("ts", best.getTime());
            return o.toString();
        } catch (Exception e) {
            return "{\"error\":\"" + e.getClass().getSimpleName() + "\"}";
        }
    }

    private Location requestSingleUpdate(LocationManager lm) {
        final Object lock = new Object();
        final Location[] out = new Location[1];
        final Handler h = new Handler(Looper.getMainLooper());
        LocationListener listener = new LocationListener() {
            @Override public void onLocationChanged(Location location) {
                synchronized (lock) { out[0] = location; lock.notifyAll(); }
            }
            @Override public void onStatusChanged(String p, int s, Bundle b) { }
            @Override public void onProviderEnabled(String p) { }
            @Override public void onProviderDisabled(String p) { }
        };
        try {
            for (String provider : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
                try {
                    if (lm.isProviderEnabled(provider)) lm.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper());
                } catch (SecurityException ignored) { }
            }
            synchronized (lock) { lock.wait(6000); }
        } catch (InterruptedException ignored) {
        } finally {
            try { lm.removeUpdates(listener); } catch (Exception ignored) { }
            h.removeCallbacksAndMessages(null);
        }
        return out[0];
    }
}
