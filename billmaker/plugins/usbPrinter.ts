import { registerPlugin, PluginListenerHandle } from '@capacitor/core';

export interface UsbDeviceInfo {
  deviceName: string;
  productName?: string;
  manufacturerName?: string;
  vendorId: number;
  productId: number;
  isPrinter: boolean;
}

export interface UsbPrinterPlugin {
  listPrinters(): Promise<{ printers: UsbDeviceInfo[] }>;
  listAllDevices(): Promise<{ devices: UsbDeviceInfo[] }>;
  isAppInstalled(opts: { packageName: string }): Promise<{ installed: boolean }>;
  openPdfInApp(opts: {
    filePath: string;
    packageName: string;
    mimeType?: string;
  }): Promise<{ opened: boolean }>;
  addListener(
    event: 'usbDeviceAttached' | 'usbDeviceDetached',
    cb: (data: { device?: UsbDeviceInfo }) => void,
  ): Promise<PluginListenerHandle>;
}

export const UsbPrinter = registerPlugin<UsbPrinterPlugin>('UsbPrinter');
