package com.codev.studio;

import android.annotation.SuppressLint;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.text.TextUtils;
import android.util.Base64;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.InputDevice;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.inputmethod.InputMethodManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONObject;

// The agents' browser on the phone: real Android WebViews ("tabs") that live behind
// CoDev's own page, so agents can browse while the user keeps chatting. The page
// (www/agent-ui/phone-browser.js) drives them and turns them into the same agent tools
// and live view the Windows app has. "show" puts one tab over CoDev, full screen, for
// the user to take over with their own fingers and keyboard; "Hand back" puts it behind
// again. Agent tabs use their own WebView profile where the phone supports it, so sites
// never share storage with CoDev's page, and cookies (sign-ins) stay between runs.
// Saved web logins are kept encrypted with a key in the Android Keystore
// (BrowserVault); passwords are typed into the page here and never go back to JS.
@CapacitorPlugin(name = "CodevBrowser")
public class CodevBrowserPlugin extends Plugin {

    private static final String PROFILE = "codev-agents";
    private static final int LOAD_TIMEOUT_MS = 30000;
    private static final int EVAL_TIMEOUT_MS = 15000;
    private static final int MAX_LOG_TEXT = 500;
    private static final int LOOPBACK_TIMEOUT_MS = 5 * 60 * 1000;

    private final Map<String, Tab> tabs = new LinkedHashMap<>();
    private final Handler main = new Handler(Looper.getMainLooper());
    private FrameLayout stage;
    private FrameLayout holder;
    private LinearLayout bar;
    private TextView barUrl;
    private String shownTab = null;
    private volatile String watchedTab = null;
    private OnBackPressedCallback backCallback;
    private BrowserVault vault;
    private Boolean profileSupported = null;
    private ServerSocket loopback;

    private static class Tab {
        final String id;
        WebView view;
        volatile String url = "about:blank";
        volatile String title = "";
        volatile boolean loading = false;
        volatile int status = 0;
        volatile String error = null;
        long touchDown = 0;
        final List<PluginCall> waiters = new ArrayList<>();

        Tab(String id) {
            this.id = id;
        }
    }

    // window.__codevLiveDom in agents' pages: DOM-change summaries for the live view.
    public static final class DomBridge {
        private final CodevBrowserPlugin plugin;
        private final String tab;

        DomBridge(CodevBrowserPlugin plugin, String tab) {
            this.plugin = plugin;
            this.tab = tab;
        }

        @JavascriptInterface
        public void post(String json) {
            plugin.onDom(tab, json);
        }
    }

    // It only ever carries counts and tag names, and only for the watched tab.
    void onDom(String tab, String json) {
        if (!tab.equals(watchedTab) || json == null || json.length() > 4000) return;
        try {
            JSObject event = new JSObject(json);
            event.put("tab", tab);
            notifyListeners("dom", event);
        } catch (Exception ignored) {}
    }

    @Override
    public void load() {
        vault = new BrowserVault(getContext());
    }

    // ---- Tabs ----

    private boolean useProfile() {
        if (profileSupported == null) {
            boolean ok = false;
            try {
                ok = WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE);
            } catch (Throwable ignored) {}
            profileSupported = ok;
        }
        return profileSupported;
    }

    private CookieManager cookies() {
        if (useProfile()) {
            try {
                return ProfileStore.getInstance().getOrCreateProfile(PROFILE).getCookieManager();
            } catch (Throwable ignored) {}
        }
        return CookieManager.getInstance();
    }

    private float density() {
        return getContext().getResources().getDisplayMetrics().density;
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, value, getContext().getResources().getDisplayMetrics());
    }

    private ViewGroup bridgeParent() {
        return (ViewGroup) getBridge().getWebView().getParent();
    }

    // The stage holds every tab. It sits behind CoDev's page until a tab is shown.
    private void ensureStage() {
        if (stage != null) return;
        Context ctx = getActivity();
        stage = new FrameLayout(ctx);
        stage.setBackgroundColor(Color.WHITE);
        LinearLayout column = new LinearLayout(ctx);
        column.setOrientation(LinearLayout.VERTICAL);

        bar = new LinearLayout(ctx);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#16181d"));
        bar.setPadding(dp(6), dp(4), dp(6), dp(4));
        Button back = barButton("◀");
        back.setContentDescription("Back");
        back.setOnClickListener(v -> {
            Tab tab = tabs.get(shownTab);
            if (tab != null && tab.view.canGoBack()) tab.view.goBack();
        });
        barUrl = new TextView(ctx);
        barUrl.setTextColor(Color.parseColor("#c9ced8"));
        barUrl.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        barUrl.setSingleLine(true);
        barUrl.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        barUrl.setPadding(dp(8), 0, dp(8), 0);
        Button handBack = barButton("↩ Hand back");
        handBack.setTextColor(Color.WHITE);
        handBack.setBackgroundColor(Color.parseColor("#2563eb"));
        handBack.setOnClickListener(v -> handBackShown());
        bar.addView(back, new LinearLayout.LayoutParams(dp(44), dp(40)));
        bar.addView(barUrl, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
        bar.addView(handBack, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(40)));
        bar.setVisibility(View.GONE);

        holder = new FrameLayout(ctx);
        column.addView(bar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        column.addView(holder, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        stage.addView(column, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // Behind CoDev the tabs keep the screen's size; the keyboard only counts while one is shown.
        ViewCompat.setOnApplyWindowInsetsListener(stage, (v, insets) -> {
            int types = WindowInsetsCompat.Type.systemBars() | (shownTab != null ? WindowInsetsCompat.Type.ime() : 0);
            Insets pad = insets.getInsets(types);
            v.setPadding(pad.left, pad.top, pad.right, pad.bottom);
            return insets;
        });
        bridgeParent().addView(stage, 0, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        backCallback = new OnBackPressedCallback(false) {
            @Override
            public void handleOnBackPressed() {
                Tab tab = tabs.get(shownTab);
                if (tab != null && tab.view.canGoBack()) tab.view.goBack();
                else handBackShown();
            }
        };
        getActivity().getOnBackPressedDispatcher().addCallback(getActivity(), backCallback);
    }

    private Button barButton(String label) {
        Button button = new Button(getActivity());
        button.setText(label);
        button.setAllCaps(false);
        button.setTextColor(Color.parseColor("#e5e7eb"));
        button.setBackgroundColor(Color.TRANSPARENT);
        button.setTypeface(Typeface.DEFAULT_BOLD);
        button.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        button.setPadding(dp(10), 0, dp(10), 0);
        button.setMinWidth(0);
        button.setMinimumWidth(0);
        return button;
    }

    private void handBackShown() {
        String id = shownTab;
        hideStage();
        if (id != null) {
            JSObject event = new JSObject();
            event.put("tab", id);
            notifyListeners("handback", event);
        }
    }

    private void hideStage() {
        if (stage == null || shownTab == null) return;
        Tab tab = tabs.get(shownTab);
        shownTab = null;
        bar.setVisibility(View.GONE);
        if (tab != null) {
            InputMethodManager imm = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
            if (imm != null) imm.hideSoftInputFromWindow(tab.view.getWindowToken(), 0);
            tab.view.clearFocus();
            tab.view.setFocusable(false);
            tab.view.setFocusableInTouchMode(false);
        }
        ViewGroup parent = bridgeParent();
        parent.removeView(stage);
        parent.addView(stage, 0);
        backCallback.setEnabled(false);
        getBridge().getWebView().requestFocus();
        ViewCompat.requestApplyInsets(stage);
        cookies().flush();
    }

    private Tab tab(PluginCall call) {
        String id = call.getString("tab", "");
        Tab tab = tabs.get(id);
        if (tab == null) call.reject("That browser isn't open.");
        return tab;
    }

    private static boolean isBlockedHost(Uri uri) {
        String host = uri.getHost();
        if (host == null) return false;
        host = host.toLowerCase();
        return host.equals("localhost") || host.endsWith(".localhost") || host.startsWith("127.") || host.equals("[::1]")
            || host.equals("::1") || host.equals("0.0.0.0");
    }

    private static String clip(String text, int max) {
        if (text == null) return "";
        return text.length() > max ? text.substring(0, max) + "…" : text;
    }

    private JSObject info(Tab tab) {
        JSObject out = new JSObject();
        out.put("tab", tab.id);
        out.put("url", tab.url);
        out.put("title", tab.title);
        out.put("loading", tab.loading);
        out.put("status", tab.status);
        out.put("error", tab.error);
        out.put("shown", tab.id.equals(shownTab));
        if (tab.view != null) {
            out.put("canGoBack", tab.view.canGoBack());
            out.put("canGoForward", tab.view.canGoForward());
            float d = density();
            out.put("width", Math.round(tab.view.getWidth() / d));
            out.put("height", Math.round(tab.view.getHeight() / d));
        }
        return out;
    }

    private void emitPage(Tab tab) {
        notifyListeners("page", info(tab));
    }

    private void emitNetwork(Tab tab, String phase, String method, String url, int status, String error) {
        if (!tab.id.equals(watchedTab)) return;
        JSObject event = new JSObject();
        event.put("tab", tab.id);
        event.put("phase", phase);
        event.put("method", method);
        event.put("url", clip(url, 300));
        if (status > 0) event.put("status", status);
        if (error != null) event.put("error", clip(error, 120));
        notifyListeners("network", event);
    }

    private void finishWaiters(Tab tab, boolean timedOut) {
        List<PluginCall> done = new ArrayList<>(tab.waiters);
        tab.waiters.clear();
        for (PluginCall call : done) {
            JSObject out = info(tab);
            out.put("timedOut", timedOut);
            call.resolve(out);
        }
    }

    @SuppressLint({ "SetJavaScriptEnabled", "AddJavascriptInterface" })
    private Tab createTab(String id) {
        ensureStage();
        Tab tab = new Tab(id);
        WebView view = new WebView(getActivity());
        if (useProfile()) {
            try {
                WebViewCompat.setProfile(view, PROFILE);
            } catch (Throwable err) {
                profileSupported = false;
            }
        }
        tab.view = view;
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setSupportMultipleWindows(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        CookieManager jar = cookies();
        jar.setAcceptCookie(true);
        jar.setAcceptThirdPartyCookies(view, true);
        view.setFocusable(false);
        view.setFocusableInTouchMode(false);
        view.addJavascriptInterface(new DomBridge(this, tab.id), "__codevLiveDom");
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
                Uri uri = req.getUrl();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
                if (scheme.equals("http") || scheme.equals("https")) {
                    if (isBlockedHost(uri)) {
                        tab.error = "CoDev's agent browser doesn't open addresses on this phone itself.";
                        return true;
                    }
                    return false;
                }
                if (scheme.equals("about") || scheme.equals("data") || scheme.equals("blob")) return false;
                // Other apps' links (mail, phone, Play Store) open only when the user taps them while driving.
                if (tab.id.equals(shownTab) && req.hasGesture()) {
                    try {
                        getActivity().startActivity(new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
                    } catch (ActivityNotFoundException ignored) {}
                }
                return true;
            }

            @Override
            public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest req) {
                if (isBlockedHost(req.getUrl())) {
                    emitNetwork(tab, "failed", req.getMethod(), req.getUrl().toString(), 0, "blocked: addresses on this phone");
                    return new WebResourceResponse("text/plain", "utf-8", 403, "Forbidden", null,
                        new ByteArrayInputStream("Blocked by CoDev".getBytes(StandardCharsets.UTF_8)));
                }
                emitNetwork(tab, "request", req.getMethod(), req.getUrl().toString(), 0, null);
                return null;
            }

            @Override
            public void onPageStarted(WebView v, String url, Bitmap favicon) {
                tab.loading = true;
                tab.url = url;
                if (tab.id.equals(shownTab)) barUrl.setText(url);
                emitPage(tab);
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                tab.loading = false;
                tab.url = url;
                tab.title = v.getTitle() == null ? "" : v.getTitle();
                if (tab.id.equals(shownTab)) barUrl.setText(url);
                emitPage(tab);
                finishWaiters(tab, false);
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                String why = String.valueOf(err.getDescription());
                if (req.isForMainFrame()) tab.error = why;
                emitNetwork(tab, "failed", req.getMethod(), req.getUrl().toString(), 0, why);
            }

            @Override
            public void onReceivedHttpError(WebView v, WebResourceRequest req, WebResourceResponse res) {
                if (req.isForMainFrame()) tab.status = res.getStatusCode();
                emitNetwork(tab, "response", req.getMethod(), req.getUrl().toString(), res.getStatusCode(), null);
            }
        });
        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage msg) {
                if (tab.id.equals(watchedTab)) {
                    JSObject event = new JSObject();
                    event.put("tab", tab.id);
                    String level = msg.messageLevel() == ConsoleMessage.MessageLevel.ERROR ? "error"
                        : msg.messageLevel() == ConsoleMessage.MessageLevel.WARNING ? "warning" : "log";
                    event.put("level", level);
                    event.put("text", clip(msg.message(), MAX_LOG_TEXT));
                    notifyListeners("console", event);
                }
                return true;
            }

            @Override
            public void onReceivedTitle(WebView v, String title) {
                tab.title = title == null ? "" : title;
            }
        });
        holder.addView(view, 0, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        tabs.put(id, tab);
        return tab;
    }

    private void destroyTab(Tab tab) {
        if (tab.id.equals(shownTab)) hideStage();
        tabs.remove(tab.id);
        finishWaiters(tab, true);
        holder.removeView(tab.view);
        tab.view.stopLoading();
        tab.view.destroy();
        JSObject event = new JSObject();
        event.put("tab", tab.id);
        notifyListeners("closed", event);
    }

    // ---- Methods for the page ----

    @PluginMethod
    public void open(PluginCall call) {
        String id = call.getString("tab", "");
        if (id.isEmpty()) {
            call.reject("No tab id.");
            return;
        }
        main.post(() -> {
            Tab tab = tabs.get(id);
            boolean fresh = tab == null;
            if (fresh) tab = createTab(id);
            JSObject out = info(tab);
            out.put("fresh", fresh);
            out.put("separateProfile", useProfile());
            call.resolve(out);
        });
    }

    @PluginMethod
    public void load(PluginCall call) {
        String url = call.getString("url", "");
        Uri uri = Uri.parse(url);
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        if (!url.equals("about:blank") && !scheme.equals("http") && !scheme.equals("https")) {
            call.reject("Only http:// and https:// pages open here.");
            return;
        }
        if (isBlockedHost(uri)) {
            call.reject("CoDev's agent browser doesn't open addresses on this phone itself.");
            return;
        }
        main.post(() -> {
            Tab tab = tab(call);
            if (tab == null) return;
            tab.status = 0;
            tab.error = null;
            tab.waiters.add(call);
            tab.view.loadUrl(url);
            main.postDelayed(() -> {
                if (tab.waiters.remove(call)) {
                    JSObject out = info(tab);
                    out.put("timedOut", true);
                    call.resolve(out);
                }
            }, LOAD_TIMEOUT_MS);
        });
    }

    @PluginMethod
    public void info(PluginCall call) {
        main.post(() -> {
            Tab tab = tab(call);
            if (tab != null) call.resolve(info(tab));
        });
    }

    @PluginMethod
    public void list(PluginCall call) {
        main.post(() -> {
            JSArray list = new JSArray();
            for (Tab tab : tabs.values()) list.put(info(tab));
            JSObject out = new JSObject();
            out.put("tabs", list);
            out.put("separateProfile", useProfile());
            call.resolve(out);
        });
    }

    // Runs a script in the tab's page and resolves with its result as JSON text.
    @PluginMethod
    public void eval(PluginCall call) {
        String script = call.getString("script", "");
        main.post(() -> {
            Tab tab = tab(call);
            if (tab == null) return;
            final boolean[] done = { false };
            tab.view.evaluateJavascript(script, value -> {
                if (done[0]) return;
                done[0] = true;
                JSObject out = new JSObject();
                out.put("value", value);
                call.resolve(out);
            });
            main.postDelayed(() -> {
                if (done[0]) return;
                done[0] = true;
                call.reject("The page didn't answer in time.");
            }, EVAL_TIMEOUT_MS);
        });
    }

    // A finger on the tab, at x, y in the tab's own dp (the live picture's size).
    @PluginMethod
    public void touch(PluginCall call) {
        String action = call.getString("action", "tap");
        double x = call.getDouble("x", 0.0);
        double y = call.getDouble("y", 0.0);
        main.post(() -> {
            Tab tab = tab(call);
            if (tab == null) return;
            float d = density();
            float px = (float) (x * d);
            float py = (float) (y * d);
            long now = SystemClock.uptimeMillis();
            switch (action) {
                case "down":
                    tab.touchDown = now;
                    send(tab, MotionEvent.ACTION_DOWN, tab.touchDown, now, px, py);
                    break;
                case "move":
                    if (tab.touchDown != 0) send(tab, MotionEvent.ACTION_MOVE, tab.touchDown, now, px, py);
                    break;
                case "up":
                    if (tab.touchDown == 0) tab.touchDown = now;
                    send(tab, MotionEvent.ACTION_UP, tab.touchDown, now, px, py);
                    tab.touchDown = 0;
                    break;
                default:
                    send(tab, MotionEvent.ACTION_DOWN, now, now, px, py);
                    send(tab, MotionEvent.ACTION_UP, now, now + 60, px, py);
            }
            call.resolve();
        });
    }

    private void send(Tab tab, int action, long downTime, long time, float x, float y) {
        MotionEvent event = MotionEvent.obtain(downTime, time, action, x, y, 0);
        event.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        tab.view.dispatchTouchEvent(event);
        event.recycle();
    }

    // A JPEG of what the tab shows, at most maxWidth pixels wide; width and height are in dp.
    @PluginMethod
    public void capture(PluginCall call) {
        int quality = Math.max(20, Math.min(95, call.getInt("quality", 60)));
        int maxWidth = Math.max(200, Math.min(1600, call.getInt("maxWidth", 720)));
        main.post(() -> {
            Tab tab = tab(call);
            if (tab == null) return;
            WebView view = tab.view;
            int w = view.getWidth();
            int h = view.getHeight();
            if (w <= 0 || h <= 0) {
                call.reject("The browser isn't laid out yet.");
                return;
            }
            float scale = Math.min(1f, (float) maxWidth / w);
            Bitmap bitmap;
            try {
                bitmap = Bitmap.createBitmap(Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale)), Bitmap.Config.ARGB_8888);
            } catch (OutOfMemoryError err) {
                call.reject("Not enough memory for a picture.");
                return;
            }
            Canvas canvas = new Canvas(bitmap);
            canvas.scale(scale, scale);
            canvas.translate(-view.getScrollX(), -view.getScrollY());
            view.draw(canvas);
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out);
            bitmap.recycle();
            float d = density();
            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP));
            result.put("width", Math.round(w / d));
            result.put("height", Math.round(h / d));
            result.put("url", tab.url);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void history(PluginCall call) {
        String op = call.getString("op", "");
        main.post(() -> {
            Tab tab = tab(call);
            if (tab == null) return;
            if (op.equals("back") && tab.view.canGoBack()) tab.view.goBack();
            else if (op.equals("forward") && tab.view.canGoForward()) tab.view.goForward();
            else if (op.equals("reload")) tab.view.reload();
            else if (op.equals("stop")) tab.view.stopLoading();
            call.resolve(info(tab));
        });
    }

    // The tab over CoDev, full screen, for the user's own hands, with a Hand back bar.
    @PluginMethod
    public void show(PluginCall call) {
        main.post(() -> {
            Tab tab = tab(call);
            if (tab == null) return;
            ViewGroup parent = bridgeParent();
            if (shownTab == null) {
                parent.removeView(stage);
                parent.addView(stage);
            }
            shownTab = tab.id;
            tab.view.bringToFront();
            bar.setVisibility(View.VISIBLE);
            barUrl.setText(tab.url);
            tab.view.setFocusable(true);
            tab.view.setFocusableInTouchMode(true);
            tab.view.requestFocus();
            backCallback.setEnabled(true);
            ViewCompat.requestApplyInsets(stage);
            call.resolve(info(tab));
        });
    }

    @PluginMethod
    public void hide(PluginCall call) {
        main.post(() -> {
            hideStage();
            call.resolve();
        });
    }

    // Which tab the live view watches: only its console, network and DOM events are sent.
    @PluginMethod
    public void watch(PluginCall call) {
        watchedTab = call.getString("tab", null);
        call.resolve();
    }

    @PluginMethod
    public void close(PluginCall call) {
        main.post(() -> {
            Tab tab = tabs.get(call.getString("tab", ""));
            if (tab != null) destroyTab(tab);
            JSObject out = new JSObject();
            out.put("closed", tab != null);
            call.resolve(out);
        });
    }

    // Deletes the agents' sign-ins: closes every tab, then their cookies and site storage.
    @PluginMethod
    public void forgetSignIns(PluginCall call) {
        main.post(() -> {
            for (Tab tab : new ArrayList<>(tabs.values())) destroyTab(tab);
            boolean storage = false;
            if (useProfile()) {
                try {
                    storage = ProfileStore.getInstance().deleteProfile(PROFILE);
                } catch (Throwable ignored) {}
            }
            final boolean clearedStorage = storage;
            CookieManager jar = storage ? CookieManager.getInstance() : cookies();
            Runnable reply = () -> {
                JSObject out = new JSObject();
                out.put("forgotten", true);
                out.put("storage", clearedStorage);
                call.resolve(out);
            };
            // With a separate profile its cookies went with it; otherwise only cookies can be
            // cleared, because CoDev's own page keeps its chats in the shared site storage.
            if (clearedStorage) reply.run();
            else jar.removeAllCookies(ok -> {
                jar.flush();
                reply.run();
            });
        });
    }

    // ---- Saved web logins ----

    @PluginMethod
    public void vaultList(PluginCall call) {
        try {
            JSObject out = new JSObject();
            out.put("credentials", vault.list());
            out.put("protector", "androidKeystore");
            call.resolve(out);
        } catch (Exception err) {
            call.reject(err.getMessage());
        }
    }

    @PluginMethod
    public void vaultAdd(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(vault.add(call.getObject("credential", new JSObject()))));
        } catch (Exception err) {
            call.reject(err.getMessage());
        }
    }

    @PluginMethod
    public void vaultRemove(PluginCall call) {
        try {
            vault.remove(call.getString("id", ""));
            call.resolve();
        } catch (Exception err) {
            call.reject(err.getMessage());
        }
    }

    // Types a saved login into the tab's page, only while that page is on the login's own
    // site. step "both" fills what is there (and presses Enter after a lone user name box);
    // step "password" fills the password box that came after.
    @PluginMethod
    public void vaultLogin(PluginCall call) {
        String id = call.getString("id", "");
        String step = "password".equals(call.getString("step")) ? "password" : "both";
        JSONObject credential;
        try {
            credential = vault.get(id);
        } catch (Exception err) {
            call.reject(err.getMessage());
            return;
        }
        if (credential == null) {
            call.reject("No saved login with id \"" + id + "\".");
            return;
        }
        main.post(() -> {
            Tab tab = tab(call);
            if (tab == null) return;
            String origin = credential.optString("origin");
            String here = BrowserVault.originOf(tab.view.getUrl());
            if (!origin.equals(here)) {
                JSObject out = new JSObject();
                out.put("refused", here == null ? "" : here);
                call.resolve(out);
                return;
            }
            String script;
            try {
                JSONObject params = new JSONObject();
                params.put("step", step);
                params.put("username", credential.optString("username"));
                params.put("password", credential.optString("password"));
                params.put("usernameSelector", credential.optString("usernameSelector"));
                params.put("passwordSelector", credential.optString("passwordSelector"));
                params.put("submitSelector", credential.optString("submitSelector"));
                script = "(" + LOGIN_SCRIPT + ")(" + params.toString() + ")";
            } catch (Exception err) {
                call.reject(err.getMessage());
                return;
            }
            tab.view.evaluateJavascript(script, value -> {
                JSObject out;
                try {
                    out = new JSObject(value == null || value.equals("null") ? "{}" : value);
                } catch (Exception err) {
                    out = new JSObject();
                }
                call.resolve(out);
            });
        });
    }

    private static final String LOGIN_SCRIPT =
        "function (p) {" +
        "  var USER = ['input[autocomplete=\"username\"]', 'input[type=\"email\"]', 'input[name*=\"user\" i]', 'input[id*=\"user\" i]'," +
        "    'input[name*=\"email\" i]', 'input[id*=\"email\" i]', 'input[name*=\"login\" i]', 'input[type=\"text\"]'];" +
        "  var PASS = ['input[autocomplete=\"current-password\"]', 'input[type=\"password\"]'];" +
        "  function vis(el) { var r = el.getBoundingClientRect(); var s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; }" +
        "  function first(list) { for (var i = 0; i < list.length; i++) { if (!list[i]) continue; var els; try { els = document.querySelectorAll(list[i]); } catch (e) { continue; }" +
        "    for (var j = 0; j < els.length; j++) if (vis(els[j])) return els[j]; } return null; }" +
        "  function put(el, v) { el.focus(); var setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;" +
        "    if (el.select) el.select(); var typed = false; try { typed = document.execCommand('insertText', false, v); } catch (e) {}" +
        "    if (!typed || el.value !== v) { setter.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); }" +
        "    el.dispatchEvent(new Event('change', { bubbles: true })); }" +
        "  function enter(el) { var o = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };" +
        "    var go = el.dispatchEvent(new KeyboardEvent('keydown', o)); el.dispatchEvent(new KeyboardEvent('keypress', o)); el.dispatchEvent(new KeyboardEvent('keyup', o));" +
        "    if (go && el.form) { try { if (el.form.requestSubmit) el.form.requestSubmit(); else el.form.submit(); } catch (e) {} } }" +
        "  var pass = first([p.passwordSelector].concat(PASS));" +
        "  if (p.step === 'both') { var user = first([p.usernameSelector].concat(USER));" +
        "    if (user && user !== pass) put(user, p.username);" +
        "    if (!pass) { if (!user) return { noBox: 'user' }; enter(user); return { needPassword: true }; } }" +
        "  if (!pass) return { noBox: 'password' };" +
        "  put(pass, p.password);" +
        "  var submit = null; if (p.submitSelector) { try { submit = document.querySelector(p.submitSelector); } catch (e) {} }" +
        "  if (submit) submit.click(); else enter(pass);" +
        "  return { done: true };" +
        "}";

    // ---- Google's sign-in for installed apps, in the phone's own browser ----

    // A one-time listener on 127.0.0.1 for the sign-in's redirect. Resolves with its port;
    // the redirect's query arrives later as a "loopback" event.
    @PluginMethod
    public void loopbackStart(PluginCall call) {
        stopLoopback();
        try {
            ServerSocket server = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
            server.setSoTimeout(LOOPBACK_TIMEOUT_MS);
            loopback = server;
            int port = server.getLocalPort();
            new Thread(() -> serveLoopback(server), "codev-loopback").start();
            JSObject out = new JSObject();
            out.put("port", port);
            call.resolve(out);
        } catch (Exception err) {
            call.reject("Couldn't start the sign-in listener: " + err.getMessage());
        }
    }

    @PluginMethod
    public void loopbackStop(PluginCall call) {
        stopLoopback();
        call.resolve();
    }

    private void stopLoopback() {
        if (loopback == null) return;
        try {
            loopback.close();
        } catch (Exception ignored) {}
        loopback = null;
    }

    private void serveLoopback(ServerSocket server) {
        try {
            while (!server.isClosed()) {
                try (Socket socket = server.accept()) {
                    socket.setSoTimeout(10000);
                    InputStream in = socket.getInputStream();
                    StringBuilder line = new StringBuilder();
                    int c;
                    while ((c = in.read()) != -1 && c != '\n' && line.length() < 8192) line.append((char) c);
                    String[] parts = line.toString().trim().split(" ");
                    String target = parts.length > 1 ? parts[1] : "";
                    boolean root = target.equals("/") || target.startsWith("/?");
                    String body = root
                        ? "<!doctype html><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>CoDev</title>" +
                          "<body style=\"font-family:sans-serif;padding:32px\"><h2>Done. Go back to CoDev.</h2><p>You can close this tab.</p></body>"
                        : "Not found";
                    byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                    OutputStream out = socket.getOutputStream();
                    out.write(("HTTP/1.1 " + (root ? "200 OK" : "404 Not Found") + "\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: " +
                        bytes.length + "\r\nConnection: close\r\n\r\n").getBytes(StandardCharsets.UTF_8));
                    out.write(bytes);
                    out.flush();
                    if (root) {
                        JSObject event = new JSObject();
                        event.put("port", server.getLocalPort());
                        event.put("query", target.contains("?") ? target.substring(target.indexOf('?') + 1) : "");
                        notifyListeners("loopback", event);
                        break;
                    }
                }
            }
        } catch (Exception ignored) {
            // Closed or timed out: the page stops waiting on its own.
        } finally {
            try {
                server.close();
            } catch (Exception ignored) {}
        }
    }

    // Opens an https address in the phone's own browser (Google's sign-in page).
    @PluginMethod
    public void openExternal(PluginCall call) {
        String url = call.getString("url", "");
        if (!url.startsWith("https://")) {
            call.reject("Only https:// addresses open in the browser.");
            return;
        }
        try {
            getActivity().startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            call.resolve();
        } catch (ActivityNotFoundException err) {
            call.reject("No browser on this phone could open the page.");
        }
    }

    @Override
    protected void handleOnPause() {
        try {
            cookies().flush();
        } catch (Throwable ignored) {}
    }

    @Override
    protected void handleOnDestroy() {
        stopLoopback();
    }
}
