package cn.suixing.tour;

import android.content.Context;
import android.content.SharedPreferences;

/** 极简偏好存储：服务器地址（会话本身由网页 localStorage 持久化） */
public class Prefs {
    private static final String FILE = "smart_tour";
    private static final String KEY_SERVER = "server_url";

    public static SharedPreferences get(Context ctx) {
        return ctx.getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public static String serverUrl(Context ctx) {
        return get(ctx).getString(KEY_SERVER, "");
    }

    public static void setServerUrl(Context ctx, String url) {
        get(ctx).edit().putString(KEY_SERVER, normalize(url)).apply();
    }

    public static String normalize(String url) {
        if (url == null) return "";
        String u = url.trim();
        if (u.isEmpty()) return "";
        if (!u.startsWith("http://") && !u.startsWith("https://")) u = "http://" + u;
        while (u.endsWith("/")) u = u.substring(0, u.length() - 1);
        return u;
    }

    public static String host(String url) {
        try {
            java.net.URL u = new java.net.URL(url);
            return u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "");
        } catch (Exception e) {
            return url;
        }
    }
}
