import { useEffect, useState } from 'react';
import { UsbPrinter, UsbDeviceInfo } from '../plugins/usbPrinter';

export interface UseUsbPrinterResult {
  printers: UsbDeviceInfo[];
  supported: boolean;
  refresh: () => Promise<void>;
}

export function useUsbPrinter(): UseUsbPrinterResult {
  const [printers, setPrinters] = useState<UsbDeviceInfo[]>([]);
  const [supported, setSupported] = useState<boolean>(true);

  const refresh = async () => {
    try {
      const { printers: list } = await UsbPrinter.listPrinters();
      setPrinters(list);
    } catch {
      setSupported(false);
    }
  };

  useEffect(() => {
    let attachHandle: any;
    let detachHandle: any;
    let cancelled = false;

    (async () => {
      try {
        const result = await UsbPrinter.listPrinters();
        if (!cancelled) setPrinters(result.printers);
        attachHandle = await UsbPrinter.addListener('usbDeviceAttached', async () => {
          const r = await UsbPrinter.listPrinters();
          if (!cancelled) setPrinters(r.printers);
        });
        detachHandle = await UsbPrinter.addListener('usbDeviceDetached', async () => {
          const r = await UsbPrinter.listPrinters();
          if (!cancelled) setPrinters(r.printers);
        });
      } catch {
        if (!cancelled) setSupported(false);
      }
    })();

    return () => {
      cancelled = true;
      attachHandle?.remove?.();
      detachHandle?.remove?.();
    };
  }, []);

  return { printers, supported, refresh };
}
