import React, { useEffect } from 'react';
import './Toast.css';

interface ToastProps {
  message: string;
  type: 'success' | 'error';
  onDismiss: () => void;
}

const Toast: React.FC<ToastProps> = ({ message, type, onDismiss }) => {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 3000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className={`toast ${type}`}>
      <span>{message}</span>
      <button onClick={onDismiss} className="close-btn" aria-label="Dismiss">
        &times;
      </button>
    </div>
  );
};

export default Toast;
