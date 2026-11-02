package com.codev.studio;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // The agents' browser on the phone (see CodevBrowserPlugin).
        registerPlugin(CodevBrowserPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
