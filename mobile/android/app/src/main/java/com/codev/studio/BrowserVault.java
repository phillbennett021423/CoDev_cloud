package com.codev.studio;

import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSArray;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.SecureRandom;
import java.util.Locale;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import org.json.JSONArray;
import org.json.JSONObject;

// The phone's saved web logins for the agents' browser, like desktop/browser/credential-vault.js:
// one AES-256-GCM encrypted list in the app's private storage, with the key kept in the
// Android Keystore (it never leaves the phone's secure hardware where there is one).
// list() never returns passwords; get() is only used to type one into its own site.
final class BrowserVault {

    private static final String ALIAS = "codev_browser_vault";
    private static final String KEY = "credentials";
    private static final int MAX_CREDENTIALS = 100;
    private final SharedPreferences prefs;

    BrowserVault(Context context) {
        prefs = context.getSharedPreferences("codev_browser_vault", Context.MODE_PRIVATE);
    }

    static String originOf(String url) {
        if (url == null) return null;
        Uri uri = Uri.parse(url.trim());
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https") || uri.getHost() == null) return null;
        int port = uri.getPort();
        boolean defaultPort = port == -1 || (scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80);
        return scheme + "://" + uri.getHost().toLowerCase(Locale.ROOT) + (defaultPort ? "" : ":" + port);
    }

    private SecretKey key() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return ((KeyStore.SecretKeyEntry) store.getEntry(ALIAS, null)).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return generator.generateKey();
    }

    // A vault that can't be read (restored from a backup without its key) starts empty.
    private synchronized JSONArray read() {
        String stored = prefs.getString(KEY, null);
        if (stored == null) return new JSONArray();
        try {
            byte[] blob = Base64.decode(stored, Base64.NO_WRAP);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, blob, 0, 12));
            byte[] plain = cipher.doFinal(blob, 12, blob.length - 12);
            return new JSONArray(new String(plain, StandardCharsets.UTF_8));
        } catch (Exception err) {
            return new JSONArray();
        }
    }

    private synchronized void write(JSONArray list) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(list.toString().getBytes(StandardCharsets.UTF_8));
        byte[] blob = new byte[iv.length + sealed.length];
        System.arraycopy(iv, 0, blob, 0, iv.length);
        System.arraycopy(sealed, 0, blob, iv.length, sealed.length);
        prefs.edit().putString(KEY, Base64.encodeToString(blob, Base64.NO_WRAP)).apply();
    }

    JSArray list() throws Exception {
        JSONArray all = read();
        JSArray out = new JSArray();
        for (int i = 0; i < all.length(); i++) {
            JSONObject c = all.getJSONObject(i);
            JSONObject shown = new JSONObject();
            for (String field : new String[] { "id", "label", "origin", "loginUrl", "username", "createdAt", "lastUsedAt" }) {
                if (c.has(field)) shown.put(field, c.get(field));
            }
            out.put(shown);
        }
        return out;
    }

    JSONObject get(String id) throws Exception {
        JSONArray all = read();
        for (int i = 0; i < all.length(); i++) {
            JSONObject c = all.getJSONObject(i);
            if (c.optString("id").equals(id)) {
                c.put("lastUsedAt", isoNow());
                write(all);
                return c;
            }
        }
        return null;
    }

    JSONObject add(JSONObject input) throws Exception {
        String loginUrl = input.optString("loginUrl").trim();
        String origin = originOf(loginUrl);
        if (origin == null) throw new IllegalArgumentException("The sign-in page must be a full http:// or https:// address.");
        String username = input.optString("username").trim();
        String password = input.optString("password");
        if (username.isEmpty() || password.isEmpty()) throw new IllegalArgumentException("A saved login needs a user name and a password.");
        String label = input.optString("label").trim();
        JSONArray all = read();
        if (all.length() >= MAX_CREDENTIALS) throw new IllegalArgumentException("That's the most saved logins CoDev keeps. Delete one first.");
        byte[] random = new byte[9];
        new SecureRandom().nextBytes(random);
        StringBuilder id = new StringBuilder("cred_");
        for (byte b : random) id.append(String.format(Locale.ROOT, "%02x", b));
        JSONObject c = new JSONObject();
        c.put("id", id.toString());
        c.put("label", label.isEmpty() ? Uri.parse(loginUrl).getHost() : label.substring(0, Math.min(80, label.length())));
        c.put("origin", origin);
        c.put("loginUrl", loginUrl);
        c.put("username", username);
        c.put("password", password);
        c.put("usernameSelector", input.optString("usernameSelector").trim());
        c.put("passwordSelector", input.optString("passwordSelector").trim());
        c.put("submitSelector", input.optString("submitSelector").trim());
        c.put("createdAt", isoNow());
        all.put(c);
        write(all);
        JSONObject shown = new JSONObject();
        shown.put("id", c.get("id"));
        shown.put("label", c.get("label"));
        shown.put("origin", origin);
        shown.put("username", username);
        return shown;
    }

    void remove(String id) throws Exception {
        JSONArray all = read();
        JSONArray kept = new JSONArray();
        for (int i = 0; i < all.length(); i++) {
            if (!all.getJSONObject(i).optString("id").equals(id)) kept.put(all.get(i));
        }
        write(kept);
    }

    private static String isoNow() {
        java.text.SimpleDateFormat format = new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss'Z'", Locale.ROOT);
        format.setTimeZone(java.util.TimeZone.getTimeZone("UTC"));
        return format.format(new java.util.Date());
    }
}
