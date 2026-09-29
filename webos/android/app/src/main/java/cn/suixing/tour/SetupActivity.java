package cn.suixing.tour;

import android.app.Activity;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 服务器地址配置页。
 *
 * 本应用是"客户端 + 服务端"结构：APK 负责界面与原生能力，规划/地图/讲解全部由
 * Node 服务端（server/index.js）提供。因此首次启动必须填一次服务端地址。
 */
public class SetupActivity extends Activity {
    private EditText input;
    private TextView result;
    private Button testBtn;
    private final ExecutorService pool = Executors.newSingleThreadExecutor();
    private final Handler ui = new Handler(Looper.getMainLooper());
    private boolean saved = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_setup);

        input = findViewById(R.id.input_url);
        result = findViewById(R.id.result);
        testBtn = findViewById(R.id.btn_test);

        String cur = Prefs.serverUrl(this);
        input.setText(cur.isEmpty() ? "http://10.0.2.2:8080" : cur);

        findViewById(R.id.btn_fill_emu).setOnClickListener(v -> input.setText("http://10.0.2.2:8080"));
        findViewById(R.id.btn_fill_lan).setOnClickListener(v -> input.setText("http://192.168.1.25:8080"));
        testBtn.setOnClickListener(v -> testAndSave());
        findViewById(R.id.btn_save_only).setOnClickListener(v -> {
            Prefs.setServerUrl(this, input.getText().toString());
            saved = true;
            finishOk("已保存（未检测连通性）");
        });
    }

    private void testAndSave() {
        final String url = Prefs.normalize(input.getText().toString());
        if (url.isEmpty()) {
            result.setText("请先填写服务器地址，例如 http://192.168.1.25:8080");
            return;
        }
        testBtn.setEnabled(false);
        result.setText("正在连接 " + url + " …");
        pool.execute(() -> {
            String msg;
            boolean ok = false;
            try {
                HttpURLConnection c = (HttpURLConnection) new URL(url + "/v1/config").openConnection();
                c.setConnectTimeout(6000);
                c.setReadTimeout(6000);
                c.setRequestMethod("GET");
                int code = c.getResponseCode();
                if (code == 200) {
                    StringBuilder sb = new StringBuilder();
                    try (BufferedReader br = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
                        String line;
                        while ((line = br.readLine()) != null) sb.append(line);
                    }
                    JSONObject o = new JSONObject(sb.toString());
                    JSONObject p = o.optJSONObject("providers");
                    String map = p == null ? "?" : p.optString("map");
                    String llm = p == null ? "?" : p.optString("llm");
                    boolean needSetup = o.optBoolean("setupRequired", false);
                    ok = true;
                    msg = "连接成功\n地图服务：" + ("amap".equals(map) ? "高德（真实数据）" : "未配置")
                            + "\nAI 服务：" + ("http".equals(llm) ? "已接入" : "未配置（将按默认条件规划）")
                            + (needSetup ? "\n⚠ 服务端未配置高德 Key：能登录但无法规划，请在服务端 config.json 填写后重启。" : "");
                } else {
                    msg = "服务端返回 HTTP " + code + "，请确认地址与端口正确。";
                }
            } catch (Exception e) {
                msg = "连不上：" + e.getClass().getSimpleName() + "\n请确认服务端已启动（node server/index.js）、端口一致，且手机与电脑在同一网络。";
            }
            final boolean okFinal = ok;
            final String msgFinal = msg;
            ui.post(() -> {
                testBtn.setEnabled(true);
                result.setText(msgFinal);
                if (okFinal) {
                    Prefs.setServerUrl(SetupActivity.this, url);
                    saved = true;
                    Toast.makeText(SetupActivity.this, "已保存服务器地址", Toast.LENGTH_SHORT).show();
                    ui.postDelayed(() -> finishOk(null), 900);
                }
            });
        });
    }

    private void finishOk(String toast) {
        if (toast != null) Toast.makeText(this, toast, Toast.LENGTH_SHORT).show();
        setResult(saved ? RESULT_OK : RESULT_CANCELED, new Intent());
        finish();
    }

    @Override
    protected void onDestroy() {
        pool.shutdownNow();
        super.onDestroy();
    }
}
