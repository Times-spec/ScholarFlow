package cn.suixing.tour;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 漫游有解——多约束动态游览路线规划智能体（Android 壳）
 *
 * 设计取舍：
 * - WebView 保证与服务端 100% 功能对等（规划、地图、讲解、回顾都在里面）；
 * - 原生只做三件 WebView 做不好的事：①服务器地址配置与连通性检测；②原生定位（局域网 HTTP 下
 *   WebView 的 navigator.geolocation 不可用）；③麦克风权限转授（语音输入）。
 * - 会话免重复登录：网页把游客会话放在 localStorage，DOM storage 持久化即可保持。
 */
public class MainActivity extends Activity {
    private static final String TAG = "SmartTour";
    private static final int REQ_SETUP = 2001;
    private static final int REQ_MIC = 1002;

    private WebView webView;
    private LinearLayout errorBox;
    private TextView subtitle;
    private String serverUrl = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        subtitle = findViewById(R.id.subtitle);
        Button btnSettings = findViewById(R.id.btn_settings);
        Button btnReload = findViewById(R.id.btn_reload);
        webView = findViewById(R.id.webview);
        errorBox = findViewById(R.id.error_box);
        findViewById(R.id.btn_retry).setOnClickListener(v -> loadHome());
        findViewById(R.id.btn_error_settings).setOnClickListener(v -> openSettings());

        btnSettings.setOnClickListener(v -> openSettings());
        btnReload.setOnClickListener(v -> loadHome());

        setupWebView();

        // 调试包开放 WebView 远程调试（便于用 CDP 做端到端验收；正式包不开启）
        if ((getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        serverUrl = Prefs.serverUrl(this);
        if (serverUrl.isEmpty()) {
            openSettings();
        } else {
            loadHome();
        }
    }

    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);          // 网页会话存在 localStorage，必须开
        s.setDatabaseEnabled(true);
        s.setGeolocationEnabled(true);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setMediaPlaybackRequiresUserGesture(false); // 允许讲解语音播放
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setUserAgentString(s.getUserAgentString() + " SmartTourApp/0.1");
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            s.setForceDark(WebSettings.FORCE_DARK_AUTO);
        }

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.addJavascriptInterface(new GeoBridge(this), "SuixingNative");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                injectShims(view);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                injectShims(view);
                CookieManager.getInstance().flush();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                String host = u.getHost() == null ? "" : u.getHost();
                // 站外链接（如高德导航）交给系统浏览器，站内继续在 WebView 中加载
                if (serverUrl.contains(host)) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) { }
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) showError("连不上服务端：" + error.getDescription());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
                callback.invoke(origin, true, false); // 网页直接定位（HTTPS 场景）时放行
            }

            @Override
            public void onPermissionRequest(PermissionRequest request) {
                for (String res : request.getResources()) {
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(res)) {
                        if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_MIC);
                            request.deny();
                        } else {
                            request.grant(new String[]{res});
                        }
                        return;
                    }
                }
                request.deny();
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage msg) {
                Log.i(TAG, "web: " + msg.message() + " @" + msg.lineNumber());
                return true;
            }
        });
    }

    /** 注入定位桥接（网页端调用 navigator.geolocation 时自动走原生） */
    private void injectShims(WebView view) {
        String js = "(function(){\n" +
                "  if (window.__suixingGeoInstalled) return;\n" +
                "  var b = window.SuixingNative;\n" +
                "  if (!b) return;\n" +
                "  window.__suixingGeoInstalled = true;\n" +
                "  function read(){ try { return JSON.parse(b.getLocation()); } catch(e){ return {error:'bridge_error'}; } }\n" +
                "  function toPos(o){ return { coords: { latitude:o.lat, longitude:o.lng, accuracy:o.accuracy||9999, altitude:null, heading:null, speed:null }, timestamp:o.ts||Date.now() }; }\n" +
                "  function getPos(ok, err){\n" +
                "    var o = read();\n" +
                "    if (o.error === 'permission_denied') { try { b.requestPermission(); } catch(e){} err && err({code:1, message:'permission_denied'}); return; }\n" +
                "    if (o.error) { err && err({code:2, message:o.error}); return; }\n" +
                "    ok && ok(toPos(o));\n" +
                "  }\n" +
                "  var geo = { getCurrentPosition:getPos,\n" +
                "    watchPosition: function(ok, err){ var id = setInterval(function(){ getPos(ok, err); }, 6000); getPos(ok, err); return id; },\n" +
                "    clearWatch: function(id){ clearInterval(id); } };\n" +
                "  try { Object.defineProperty(navigator, 'geolocation', { value: geo, configurable: true }); } catch(e){ navigator.geolocation = geo; }\n" +
                "  console.log('[suixing] native geo bridge ready, permission=' + b.hasPermission());\n" +
                "})();";
        view.evaluateJavascript(js, null);
    }

    private void loadHome() {
        errorBox.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        serverUrl = Prefs.serverUrl(this);
        if (serverUrl.isEmpty()) { openSettings(); return; }
        String host = Prefs.host(serverUrl);
        subtitle.setText(host);
        webView.loadUrl(serverUrl + "/");
    }

    private void openSettings() {
        Intent i = new Intent(this, SetupActivity.class);
        startActivityForResult(i, REQ_SETUP);
    }

    private void showError(String msg) {
        webView.setVisibility(View.GONE);
        errorBox.setVisibility(View.VISIBLE);
        ((TextView) findViewById(R.id.error_text)).setText(msg + "\n\n请确认服务端已启动、手机与服务器在同一网络（或用公网地址），然后重试。");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_SETUP) {
            if (resultCode == RESULT_OK) loadHome();
            else if (Prefs.serverUrl(this).isEmpty()) {
                Toast.makeText(this, "未配置服务器地址，无法加载应用", Toast.LENGTH_LONG).show();
            }
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 1001 && grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            Toast.makeText(this, "定位权限已开启，可再次点击「使用当前位置」", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            ((ViewGroup) webView.getParent()).removeView(webView);
            webView.destroy();
        }
        super.onDestroy();
    }
}
