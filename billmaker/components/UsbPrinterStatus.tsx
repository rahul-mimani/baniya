import React from 'react';
import { UsbDeviceInfo } from '../plugins/usbPrinter';

interface Props {
  printers: UsbDeviceInfo[];
  supported: boolean;
  compact?: boolean;
}

const UsbPrinterStatus: React.FC<Props> = ({ printers, supported, compact }) => {
  if (!supported) return null;

  const detected = printers.length > 0;
  const primary = printers[0];
  const label = detected
    ? (primary.productName || primary.manufacturerName || `USB printer (VID ${primary.vendorId.toString(16).toUpperCase().padStart(4, '0')})`)
    : 'No USB printer detected';

  const tone = detected
    ? 'bg-indigo-50 border-indigo-200 text-indigo-800'
    : 'bg-slate-50 border-slate-200 text-slate-600';
  const dotTone = detected ? 'bg-indigo-500' : 'bg-slate-400';

  if (compact) {
    return (
      <div className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-medium ${tone}`}>
        <span className={`w-2 h-2 rounded-full ${dotTone} ${detected ? 'animate-pulse' : ''}`} />
        <span className="truncate max-w-[180px]">{label}</span>
        {detected && printers.length > 1 && (
          <span className="text-indigo-700 font-semibold">+{printers.length - 1}</span>
        )}
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-3 p-3 rounded-lg border ${tone}`}>
      <span className={`w-3 h-3 rounded-full ${dotTone} ${detected ? 'animate-pulse' : ''} flex-shrink-0`} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold truncate">{label}</p>
        {detected ? (
          <p className="text-xs opacity-80">
            VID {primary.vendorId.toString(16).toUpperCase().padStart(4, '0')} ·
            PID {primary.productId.toString(16).toUpperCase().padStart(4, '0')}
            {printers.length > 1 && <> · +{printers.length - 1} more</>}
          </p>
        ) : (
          <p className="text-xs opacity-80">Plug in via USB-C / OTG. Mopria or vendor service required.</p>
        )}
      </div>
    </div>
  );
};

export default UsbPrinterStatus;
