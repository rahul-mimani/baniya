package com.billmaker.app;

import android.content.ActivityNotFoundException;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.hardware.usb.UsbConstants;
import android.hardware.usb.UsbDevice;
import android.hardware.usb.UsbInterface;
import android.hardware.usb.UsbManager;
import android.net.Uri;
import android.os.Build;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.util.HashMap;

@CapacitorPlugin(name = "UsbPrinter")
public class UsbPrinterPlugin extends Plugin {

    private BroadcastReceiver receiver;

    @Override
    public void load() {
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (action == null) return;
                UsbDevice device = intent.getParcelableExtra(UsbManager.EXTRA_DEVICE);
                JSObject data = new JSObject();
                if (device != null) data.put("device", deviceToObject(device));
                if (UsbManager.ACTION_USB_DEVICE_ATTACHED.equals(action)) {
                    notifyListeners("usbDeviceAttached", data);
                } else if (UsbManager.ACTION_USB_DEVICE_DETACHED.equals(action)) {
                    notifyListeners("usbDeviceDetached", data);
                }
            }
        };
        IntentFilter filter = new IntentFilter();
        filter.addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED);
        filter.addAction(UsbManager.ACTION_USB_DEVICE_DETACHED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(receiver, filter);
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (receiver != null) {
            try { getContext().unregisterReceiver(receiver); } catch (Exception ignored) {}
            receiver = null;
        }
        super.handleOnDestroy();
    }

    @PluginMethod
    public void listPrinters(PluginCall call) {
        UsbManager manager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        JSArray printers = new JSArray();
        if (manager != null) {
            HashMap<String, UsbDevice> all = manager.getDeviceList();
            for (UsbDevice d : all.values()) {
                if (isPrinter(d)) printers.put(deviceToObject(d));
            }
        }
        JSObject result = new JSObject();
        result.put("printers", printers);
        call.resolve(result);
    }

    @PluginMethod
    public void listAllDevices(PluginCall call) {
        UsbManager manager = (UsbManager) getContext().getSystemService(Context.USB_SERVICE);
        JSArray devices = new JSArray();
        if (manager != null) {
            HashMap<String, UsbDevice> all = manager.getDeviceList();
            for (UsbDevice d : all.values()) devices.put(deviceToObject(d));
        }
        JSObject result = new JSObject();
        result.put("devices", devices);
        call.resolve(result);
    }

    private boolean isPrinter(UsbDevice device) {
        if (device.getDeviceClass() == UsbConstants.USB_CLASS_PRINTER) return true;
        for (int i = 0; i < device.getInterfaceCount(); i++) {
            UsbInterface iface = device.getInterface(i);
            if (iface.getInterfaceClass() == UsbConstants.USB_CLASS_PRINTER) return true;
        }
        return false;
    }

    @PluginMethod
    public void isAppInstalled(PluginCall call) {
        String pkg = call.getString("packageName");
        if (pkg == null || pkg.isEmpty()) {
            call.reject("packageName required");
            return;
        }
        boolean installed;
        try {
            getContext().getPackageManager().getPackageInfo(pkg, 0);
            installed = true;
        } catch (PackageManager.NameNotFoundException e) {
            installed = false;
        }
        JSObject r = new JSObject();
        r.put("installed", installed);
        call.resolve(r);
    }

    /**
     * Opens a local file in an explicit external app (e.g. NokoPrint) via Intent.ACTION_VIEW
     * with setPackage(...). Use FileProvider to mint a content:// URI from a file path so the
     * receiver app has temporary read access.
     */
    @PluginMethod
    public void openPdfInApp(PluginCall call) {
        String filePath = call.getString("filePath");
        String packageName = call.getString("packageName");
        String mimeType = call.getString("mimeType", "application/pdf");

        if (filePath == null || filePath.isEmpty() || packageName == null || packageName.isEmpty()) {
            call.reject("filePath and packageName required");
            return;
        }

        Context ctx = getContext();
        Uri uri;
        try {
            if (filePath.startsWith("content://")) {
                uri = Uri.parse(filePath);
            } else {
                String path = filePath.startsWith("file://") ? Uri.parse(filePath).getPath() : filePath;
                if (path == null) {
                    call.reject("Could not resolve filePath: " + filePath);
                    return;
                }
                File file = new File(path);
                if (!file.exists()) {
                    call.reject("File not found: " + path);
                    return;
                }
                uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
            }
        } catch (Exception e) {
            call.reject("Could not build URI: " + e.getMessage());
            return;
        }

        Intent intent = new Intent(Intent.ACTION_VIEW);
        intent.setDataAndType(uri, mimeType);
        intent.setPackage(packageName);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

        try {
            ctx.startActivity(intent);
            JSObject r = new JSObject();
            r.put("opened", true);
            call.resolve(r);
        } catch (ActivityNotFoundException e) {
            call.reject("PACKAGE_NOT_INSTALLED");
        } catch (Exception e) {
            call.reject("startActivity failed: " + e.getMessage());
        }
    }

    private JSObject deviceToObject(UsbDevice device) {
        JSObject obj = new JSObject();
        obj.put("deviceName", device.getDeviceName());
        try { obj.put("productName", device.getProductName()); } catch (Exception ignored) {}
        try { obj.put("manufacturerName", device.getManufacturerName()); } catch (Exception ignored) {}
        obj.put("vendorId", device.getVendorId());
        obj.put("productId", device.getProductId());
        obj.put("isPrinter", isPrinter(device));
        return obj;
    }
}
